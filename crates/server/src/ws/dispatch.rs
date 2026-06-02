use chrono::Utc;
use std::sync::Arc;
use uuid::Uuid;

use remote_term_shared::{RealtimeMessage, TerminalErrorCode};

use crate::db::{insert_activity_log, ActivityLogInsert};
use crate::state::AppState;

pub async fn forward_to_desktop(
    state: &Arc<AppState>,
    user_id: Uuid,
    device_id: Uuid,
    message: RealtimeMessage,
) {
    let desktops = state.desktops.read().await;
    if let Some(desktop) = desktops.get(&device_id) {
        if desktop.user_id == user_id {
            let _ = desktop.tx.send(message);
        }
    } else {
        insert_activity_log(
            &state.pool,
            ActivityLogInsert {
                user_id,
                device_id: Some(device_id),
                session_id: None,
                kind: "error",
                title: "桌面端离线",
                body: "目标桌面没有在线 WebSocket 连接，消息未转发。",
                risky: false,
            },
        )
        .await;
        notify_mobiles(
            state,
            user_id,
            RealtimeMessage::TerminalError {
                device_id,
                session_id: None,
                code: TerminalErrorCode::DesktopOffline,
                message: "Desktop is offline.".to_string(),
            },
        )
        .await;
    }
}

pub async fn notify_mobiles(state: &Arc<AppState>, user_id: Uuid, message: RealtimeMessage) {
    if let Some(mobiles) = state.mobiles.read().await.get(&user_id) {
        for mobile in mobiles.values() {
            let _ = mobile.tx.send(message.clone());
        }
    }
}

pub fn now_heartbeat(device_id: Uuid) -> RealtimeMessage {
    RealtimeMessage::DesktopHeartbeat {
        device_id,
        timestamp: Utc::now(),
    }
}
