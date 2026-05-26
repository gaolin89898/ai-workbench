mod terminal;

use anyhow::bail;
use chrono::Utc;
use clap::{Parser, Subcommand};
use futures_util::{SinkExt, StreamExt};
use remote_term_shared::{assess_command_risk, InputKind, RealtimeMessage, TerminalErrorCode};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use terminal::TerminalManager;
use tokio::time::{interval, sleep};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, warn};
use uuid::Uuid;

#[derive(Parser)]
#[command(name = "remote-term-desktop-agent")]
#[command(about = "Desktop relay agent for tmux/screen AI terminal sessions")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Pair {
        #[arg(long, env = "REMOTE_TERM_SERVER")]
        server: String,
        #[arg(long)]
        code: String,
        #[arg(long)]
        name: Option<String>,
    },
    Run {
        #[arg(long, env = "REMOTE_TERM_SERVER")]
        server: String,
        #[arg(long, env = "REMOTE_TERM_DEVICE_ID")]
        device_id: Uuid,
        #[arg(long, env = "REMOTE_TERM_TOKEN")]
        token: String,
    },
    Sessions,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    code: String,
    name: String,
    os: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    device_id: Uuid,
    access_token: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    match Cli::parse().command {
        Command::Pair { server, code, name } => pair(server, code, name).await?,
        Command::Run {
            server,
            device_id,
            token,
        } => run(server, device_id, token).await?,
        Command::Sessions => {
            let manager = TerminalManager::new();
            println!(
                "{}",
                serde_json::to_string_pretty(&manager.list_sessions().await?)?
            );
        }
    }
    Ok(())
}

async fn pair(server: String, code: String, name: Option<String>) -> anyhow::Result<()> {
    let request = PairRequest {
        code,
        name: name.unwrap_or_else(default_device_name),
        os: std::env::consts::OS.to_string(),
    };
    let url = format!("{}/desktop/pair", server.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .json(&request)
        .send()
        .await?
        .error_for_status()?
        .json::<PairResponse>()
        .await?;
    println!("device_id={}", response.device_id);
    println!("token={}", response.access_token);
    Ok(())
}

async fn run(server: String, device_id: Uuid, token: String) -> anyhow::Result<()> {
    let manager = TerminalManager::new();
    loop {
        match connect_and_run(&server, device_id, &token, &manager).await {
            Ok(()) => warn!("websocket closed, reconnecting soon"),
            Err(err) => error!(?err, "desktop agent connection failed"),
        }
        sleep(Duration::from_secs(3)).await;
    }
}

async fn connect_and_run(
    server: &str,
    device_id: Uuid,
    token: &str,
    manager: &TerminalManager,
) -> anyhow::Result<()> {
    let ws_url = websocket_url(server, token, "/ws/desktop")?;
    let (stream, _) = connect_async(ws_url).await?;
    let (mut writer, mut reader) = stream.split();
    let mut heartbeat = interval(Duration::from_secs(15));
    let mut scan = interval(Duration::from_secs(5));
    let mut output = interval(Duration::from_millis(1500));
    let mut sequence = 0_i64;

    send_json(
        &mut writer,
        &RealtimeMessage::DesktopHeartbeat {
            device_id,
            timestamp: Utc::now(),
        },
    )
    .await?;
    send_sessions(&mut writer, device_id, manager).await?;

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                send_json(&mut writer, &RealtimeMessage::DesktopHeartbeat {
                    device_id,
                    timestamp: Utc::now(),
                }).await?;
            }
            _ = scan.tick() => {
                send_sessions(&mut writer, device_id, manager).await?;
            }
            _ = output.tick() => {
                for session in manager.list_sessions().await? {
                    if let Ok(chunk) = manager.capture_recent_output(&session.session_id, 80).await {
                        if !chunk.trim().is_empty() {
                            sequence += 1;
                            send_json(&mut writer, &RealtimeMessage::TerminalOutput {
                                device_id,
                                session_id: session.session_id,
                                chunk,
                                sequence,
                            }).await?;
                        }
                    }
                }
            }
            incoming = reader.next() => {
                let Some(message) = incoming else { break; };
                let message = message?;
                if let Message::Text(text) = message {
                    handle_server_message(&mut writer, device_id, manager, &text).await?;
                }
            }
        }
    }
    Ok(())
}

async fn handle_server_message<W>(
    writer: &mut W,
    device_id: Uuid,
    manager: &TerminalManager,
    text: &str,
) -> anyhow::Result<()>
where
    W: SinkExt<Message> + Unpin,
    <W as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    match serde_json::from_str::<RealtimeMessage>(text)? {
        RealtimeMessage::TerminalInput {
            session_id,
            input,
            input_kind: InputKind::Text,
            confirmed_risk,
            ..
        } => {
            let risk = assess_command_risk(&input);
            if risk.risky && !confirmed_risk {
                send_json(
                    writer,
                    &RealtimeMessage::TerminalError {
                        device_id,
                        session_id: Some(session_id),
                        code: TerminalErrorCode::RiskConfirmationRequired,
                        message: "Desktop agent rejected a risky command without confirmation."
                            .to_string(),
                    },
                )
                .await?;
                return Ok(());
            }
            if let Err(err) = manager.send_text(&session_id, &input).await {
                send_terminal_error(writer, device_id, Some(session_id), err).await?;
            }
        }
        RealtimeMessage::TerminalControl {
            session_id,
            control,
            ..
        } => {
            if let Err(err) = manager.send_control(&session_id, control).await {
                send_terminal_error(writer, device_id, Some(session_id), err).await?;
            }
        }
        _ => {}
    }
    Ok(())
}

async fn send_terminal_error<W>(
    writer: &mut W,
    device_id: Uuid,
    session_id: Option<String>,
    err: anyhow::Error,
) -> anyhow::Result<()>
where
    W: SinkExt<Message> + Unpin,
    <W as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    send_json(
        writer,
        &RealtimeMessage::TerminalError {
            device_id,
            session_id,
            code: TerminalErrorCode::CommandRejected,
            message: err.to_string(),
        },
    )
    .await
}

async fn send_sessions<W>(
    writer: &mut W,
    device_id: Uuid,
    manager: &TerminalManager,
) -> anyhow::Result<()>
where
    W: SinkExt<Message> + Unpin,
    <W as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    let sessions = manager.list_sessions().await?;
    send_json(
        writer,
        &RealtimeMessage::SessionsSnapshot {
            device_id,
            sessions,
        },
    )
    .await
}

async fn send_json<W>(writer: &mut W, message: &RealtimeMessage) -> anyhow::Result<()>
where
    W: SinkExt<Message> + Unpin,
    <W as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    writer
        .send(Message::Text(serde_json::to_string(message)?.into()))
        .await?;
    Ok(())
}

fn websocket_url(server: &str, token: &str, path: &str) -> anyhow::Result<String> {
    let server = server.trim_end_matches('/');
    let base = if let Some(rest) = server.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = server.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        bail!("server must start with http:// or https://");
    };
    Ok(format!("{base}{path}?token={token}"))
}

fn default_device_name() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "Desktop".to_string())
}
