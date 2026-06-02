use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use remote_term_shared::{assess_command_risk, RealtimeMessage, TerminalErrorCode};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::error;
use uuid::Uuid;

use crate::db::{ensure_ai_session_owner, ensure_device_owner, insert_activity_log, load_settings, ActivityLogInsert};
use crate::state::{AppState, MobileConnection};
use crate::ws::dispatch::{forward_to_desktop, notify_mobiles};

pub async fn mobile_socket(state: Arc<AppState>, user_id: Uuid, socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<RealtimeMessage>();
    let connection_id = Uuid::new_v4();
    state
        .mobiles
        .write()
        .await
        .entry(user_id)
        .or_default()
        .insert(connection_id, MobileConnection { tx });

    let outgoing = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            match serde_json::to_string(&message) {
                Ok(payload) => {
                    if sender.send(Message::Text(payload.into())).await.is_err() {
                        break;
                    }
                }
                Err(err) => error!(?err, "failed to serialize message"),
            }
        }
    });

    while let Some(Ok(message)) = receiver.next().await {
        if let Message::Text(text) = message {
            match serde_json::from_str::<RealtimeMessage>(&text) {
                Ok(message) => handle_mobile_message(&state, user_id, message).await,
                Err(err) => error!(?err, "invalid mobile websocket payload"),
            }
        }
    }

    state.remove_mobile(user_id, connection_id).await;
    outgoing.abort();
}

async fn handle_mobile_message(state: &Arc<AppState>, user_id: Uuid, message: RealtimeMessage) {
    match message {
        RealtimeMessage::TerminalInput {
            device_id,
            session_id,
            input,
            input_kind,
            confirmed_risk,
        } => handle_terminal_input(state, user_id, device_id, session_id, input, input_kind, confirmed_risk).await,
        RealtimeMessage::TerminalControl {
            device_id,
            session_id,
            control,
        } => handle_terminal_control(state, user_id, device_id, session_id, control).await,
        RealtimeMessage::AiMessageSend {
            device_id,
            ai_session_id,
            content,
            confirmed_risk,
        } => handle_ai_message_send(state, user_id, device_id, ai_session_id, content, confirmed_risk).await,
        RealtimeMessage::AiHistoryRequest {
            device_id,
            ai_session_id,
            request_id,
        } => handle_ai_history_request(state, user_id, device_id, ai_session_id, request_id).await,
        _ => {}
    }
}

async fn handle_terminal_input(
    state: &Arc<AppState>,
    user_id: Uuid,
    device_id: Uuid,
    session_id: String,
    input: String,
    input_kind: remote_term_shared::InputKind,
    confirmed_risk: bool,
) {
    if ensure_device_owner(&state.pool, user_id, device_id)
        .await
        .is_err()
    {
        return;
    }
    let risk = assess_command_risk(&input);
    let command_summary = input.chars().take(200).collect::<String>();
    let settings = load_settings(&state.pool, user_id)
        .await
        .unwrap_or_else(|_| crate::db::default_settings());
    if settings.command_logging_enabled {
        let _ = sqlx::query(
            "INSERT INTO command_audit_logs (user_id, device_id, session_id, command_summary, risky, confirmed, matched_rules) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(user_id)
        .bind(device_id)
        .bind(&session_id)
        .bind(&command_summary)
        .bind(risk.risky)
        .bind(confirmed_risk)
        .bind(serde_json::json!(risk.matched_rules))
        .execute(&state.pool)
        .await;
    }

    if risk.risky && !confirmed_risk {
        insert_activity_log(
            &state.pool,
            ActivityLogInsert {
                user_id,
                device_id: Some(device_id),
                session_id: Some(&session_id),
                kind: "risk",
                title: "高危命令被拦截",
                body: "命令命中风险规则，需要移动端确认后才会转发。",
                risky: true,
            },
        )
        .await;
        notify_mobiles(
            state,
            user_id,
            RealtimeMessage::TerminalError {
                device_id,
                session_id: Some(session_id),
                code: TerminalErrorCode::RiskConfirmationRequired,
                message: "This command requires confirmation before it can run.".to_string(),
            },
        )
        .await;
        return;
    }

    let activity_body = format!("{}：{}", session_id, command_summary.trim());
    insert_activity_log(
        &state.pool,
        ActivityLogInsert {
            user_id,
            device_id: Some(device_id),
            session_id: Some(&session_id),
            kind: if risk.risky { "risk" } else { "command" },
            title: if risk.risky {
                "高危命令已确认"
            } else {
                "命令已发送"
            },
            body: &activity_body,
            risky: risk.risky,
        },
    )
    .await;

    forward_to_desktop(
        state,
        user_id,
        device_id,
        RealtimeMessage::TerminalInput {
            device_id,
            session_id,
            input,
            input_kind,
            confirmed_risk,
        },
    )
    .await;
}

async fn handle_terminal_control(
    state: &Arc<AppState>,
    user_id: Uuid,
    device_id: Uuid,
    session_id: String,
    control: remote_term_shared::ControlInput,
) {
    if ensure_device_owner(&state.pool, user_id, device_id)
        .await
        .is_ok()
    {
        insert_activity_log(
            &state.pool,
            ActivityLogInsert {
                user_id,
                device_id: Some(device_id),
                session_id: Some(&session_id),
                kind: "command",
                title: "控制键已发送",
                body: "移动端发送了终端控制输入。",
                risky: false,
            },
        )
        .await;
        forward_to_desktop(
            state,
            user_id,
            device_id,
            RealtimeMessage::TerminalControl {
                device_id,
                session_id,
                control,
            },
        )
        .await;
    }
}

async fn handle_ai_message_send(
    state: &Arc<AppState>,
    user_id: Uuid,
    device_id: Uuid,
    ai_session_id: Uuid,
    content: String,
    confirmed_risk: bool,
) {
    if ensure_ai_session_owner(&state.pool, user_id, ai_session_id, device_id)
        .await
        .is_err()
    {
        return;
    }
    let risk = assess_command_risk(&content);
    if risk.risky && !confirmed_risk {
        notify_mobiles(
            state,
            user_id,
            RealtimeMessage::TerminalError {
                device_id,
                session_id: None,
                code: TerminalErrorCode::RiskConfirmationRequired,
                message: "This AI message requires confirmation before it can run.".to_string(),
            },
        )
        .await;
        return;
    }
    let body = format!(
        "AI 会话 {ai_session_id}：{}",
        content.chars().take(160).collect::<String>()
    );
    insert_activity_log(
        &state.pool,
        ActivityLogInsert {
            user_id,
            device_id: Some(device_id),
            session_id: None,
            kind: if risk.risky { "risk" } else { "command" },
            title: if risk.risky {
                "高危 AI 消息已确认"
            } else {
                "AI 消息已发送"
            },
            body: &body,
            risky: risk.risky,
        },
    )
    .await;
    forward_to_desktop(
        state,
        user_id,
        device_id,
        RealtimeMessage::AiMessageSend {
            device_id,
            ai_session_id,
            content,
            confirmed_risk,
        },
    )
    .await;
}

async fn handle_ai_history_request(
    state: &Arc<AppState>,
    user_id: Uuid,
    device_id: Uuid,
    ai_session_id: Uuid,
    request_id: Uuid,
) {
    if ensure_ai_session_owner(&state.pool, user_id, ai_session_id, device_id)
        .await
        .is_ok()
    {
        forward_to_desktop(
            state,
            user_id,
            device_id,
            RealtimeMessage::AiHistoryRequest {
                device_id,
                ai_session_id,
                request_id,
            },
        )
        .await;
    }
}
