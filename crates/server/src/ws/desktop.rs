use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use remote_term_shared::RealtimeMessage;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::error;
use uuid::Uuid;

use crate::db::{
    ensure_device_owner, insert_activity_log, mark_device_online, upsert_ai_sessions,
    upsert_projects, upsert_provider_statuses, upsert_sessions, ActivityLogInsert,
};
use crate::state::{AppState, DesktopConnection};
use crate::ws::dispatch::{notify_mobiles, now_heartbeat};

pub async fn desktop_socket(state: Arc<AppState>, user_id: Uuid, socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<RealtimeMessage>();
    let mut connected_device_id: Option<Uuid> = None;

    let outgoing = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if let Ok(payload) = serde_json::to_string(&message) {
                if sender.send(Message::Text(payload.into())).await.is_err() {
                    break;
                }
            }
        }
    });

    while let Some(Ok(message)) = receiver.next().await {
        if let Message::Text(text) = message {
            match serde_json::from_str::<RealtimeMessage>(&text) {
                Ok(message) => {
                    if let Some(device_id) =
                        handle_desktop_message(&state, user_id, tx.clone(), message).await
                    {
                        connected_device_id = Some(device_id);
                    }
                }
                Err(err) => error!(?err, "invalid desktop websocket payload"),
            }
        }
    }

    if let Some(device_id) = connected_device_id {
        state.desktops.write().await.remove(&device_id);
        if let Err(err) = mark_device_online(&state.pool, device_id, false).await {
            error!(?err, "failed to mark desktop offline");
        }
        insert_activity_log(
            &state.pool,
            ActivityLogInsert {
                user_id,
                device_id: Some(device_id),
                session_id: None,
                kind: "connection",
                title: "桌面代理已离线",
                body: "桌面端 WebSocket 已断开，设备标记为离线。",
                risky: false,
            },
        )
        .await;
        notify_mobiles(&state, user_id, now_heartbeat(device_id)).await;
    }
    outgoing.abort();
}

async fn handle_desktop_message(
    state: &Arc<AppState>,
    user_id: Uuid,
    tx: mpsc::UnboundedSender<RealtimeMessage>,
    message: RealtimeMessage,
) -> Option<Uuid> {
    match message {
        RealtimeMessage::DesktopHeartbeat {
            device_id,
            timestamp: _,
        } => Some(handle_heartbeat(state, user_id, device_id, tx).await),
        RealtimeMessage::SessionsSnapshot {
            device_id,
            sessions,
        } => handle_sessions_snapshot(state, user_id, device_id, sessions).await,
        RealtimeMessage::TerminalOutput { device_id, .. } => {
            notify_mobiles(state, user_id, message).await;
            Some(device_id)
        }
        RealtimeMessage::TerminalError {
            device_id,
            session_id,
            code,
            message: err_message,
        } => {
            handle_terminal_error(
                state,
                user_id,
                device_id,
                session_id.as_deref(),
                &err_message,
            )
            .await;
            notify_mobiles(
                state,
                user_id,
                RealtimeMessage::TerminalError {
                    device_id,
                    session_id,
                    code,
                    message: err_message,
                },
            )
            .await;
            Some(device_id)
        }
        RealtimeMessage::ProvidersSnapshot {
            device_id,
            providers,
        } => handle_providers_snapshot(state, user_id, device_id, providers).await,
        RealtimeMessage::ProjectsSnapshot {
            device_id,
            projects,
        } => handle_projects_snapshot(state, user_id, device_id, projects).await,
        RealtimeMessage::AiSessionsSnapshot {
            device_id,
            sessions,
        } => handle_ai_sessions_snapshot(state, user_id, device_id, sessions).await,
        RealtimeMessage::AiMessageDelta { device_id, .. }
        | RealtimeMessage::AiMessageDone { device_id, .. }
        | RealtimeMessage::AiHistoryResponse { device_id, .. }
        | RealtimeMessage::AiChatOutput { device_id, .. }
        | RealtimeMessage::GitStatusSnapshot {
            snapshot: remote_term_shared::GitStatusSnapshot { device_id, .. },
        } => {
            notify_mobiles(state, user_id, message).await;
            Some(device_id)
        }
        _ => None,
    }
}

async fn handle_heartbeat(
    state: &Arc<AppState>,
    user_id: Uuid,
    device_id: Uuid,
    tx: mpsc::UnboundedSender<RealtimeMessage>,
) -> Uuid {
    if ensure_device_owner(&state.pool, user_id, device_id)
        .await
        .is_err()
    {
        return device_id;
    }
    state
        .desktops
        .write()
        .await
        .insert(device_id, DesktopConnection { user_id, tx });
    if let Err(err) = mark_device_online(&state.pool, device_id, true).await {
        error!(?err, "failed to mark desktop online");
    }
    insert_activity_log(
        &state.pool,
        ActivityLogInsert {
            user_id,
            device_id: Some(device_id),
            session_id: None,
            kind: "connection",
            title: "桌面代理已连接",
            body: "桌面端 WebSocket 心跳已恢复，设备标记为在线。",
            risky: false,
        },
    )
    .await;
    notify_mobiles(state, user_id, now_heartbeat(device_id)).await;
    device_id
}

async fn handle_sessions_snapshot(
    state: &Arc<AppState>,
    user_id: Uuid,
    device_id: Uuid,
    sessions: Vec<remote_term_shared::TerminalSession>,
) -> Option<Uuid> {
    if ensure_device_owner(&state.pool, user_id, device_id)
        .await
        .is_err()
    {
        return None;
    }
    if let Err(err) = upsert_sessions(&state.pool, device_id, &sessions).await {
        error!(?err, "failed to upsert sessions");
    }
    insert_activity_log(
        &state.pool,
        ActivityLogInsert {
            user_id,
            device_id: Some(device_id),
            session_id: None,
            kind: "connection",
            title: "会话快照已同步",
            body: "桌面端已上报最新 tmux/screen 会话列表。",
            risky: false,
        },
    )
    .await;
    notify_mobiles(
        state,
        user_id,
        RealtimeMessage::SessionsSnapshot {
            device_id,
            sessions,
        },
    )
    .await;
    Some(device_id)
}

async fn handle_providers_snapshot(
    state: &Arc<AppState>,
    user_id: Uuid,
    device_id: Uuid,
    providers: Vec<remote_term_shared::DesktopProviderStatus>,
) -> Option<Uuid> {
    if ensure_device_owner(&state.pool, user_id, device_id)
        .await
        .is_err()
    {
        return None;
    }
    if let Err(err) = upsert_provider_statuses(&state.pool, device_id, &providers).await {
        error!(?err, "failed to upsert provider statuses");
    }
    notify_mobiles(
        state,
        user_id,
        RealtimeMessage::ProvidersSnapshot {
            device_id,
            providers,
        },
    )
    .await;
    Some(device_id)
}

async fn handle_projects_snapshot(
    state: &Arc<AppState>,
    user_id: Uuid,
    device_id: Uuid,
    projects: Vec<remote_term_shared::WorkspaceProject>,
) -> Option<Uuid> {
    if ensure_device_owner(&state.pool, user_id, device_id)
        .await
        .is_err()
    {
        return None;
    }
    if let Err(err) = upsert_projects(&state.pool, device_id, &projects).await {
        error!(?err, "failed to upsert projects");
    }
    notify_mobiles(
        state,
        user_id,
        RealtimeMessage::ProjectsSnapshot {
            device_id,
            projects,
        },
    )
    .await;
    Some(device_id)
}

async fn handle_ai_sessions_snapshot(
    state: &Arc<AppState>,
    user_id: Uuid,
    device_id: Uuid,
    sessions: Vec<remote_term_shared::AiSession>,
) -> Option<Uuid> {
    if ensure_device_owner(&state.pool, user_id, device_id)
        .await
        .is_err()
    {
        return None;
    }
    if let Err(err) = upsert_ai_sessions(&state.pool, user_id, device_id, &sessions).await {
        error!(?err, "failed to upsert ai sessions");
    }
    notify_mobiles(
        state,
        user_id,
        RealtimeMessage::AiSessionsSnapshot {
            device_id,
            sessions,
        },
    )
    .await;
    Some(device_id)
}

async fn handle_terminal_error(
    state: &Arc<AppState>,
    user_id: Uuid,
    device_id: Uuid,
    session_id: Option<&str>,
    err_message: &str,
) {
    insert_activity_log(
        &state.pool,
        ActivityLogInsert {
            user_id,
            device_id: Some(device_id),
            session_id,
            kind: "error",
            title: "终端错误",
            body: err_message,
            risky: false,
        },
    )
    .await;
}
