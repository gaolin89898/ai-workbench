pub mod auth;
pub mod devices;
pub mod meta;
pub mod workspace;

use axum::{
    routing::{get, post},
    Router,
};
use std::sync::Arc;

use crate::state::AppState;
use crate::ws::{ws_desktop, ws_mobile};

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(meta::health))
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/pairing/codes", post(auth::create_pairing_code))
        .route("/desktop/pair", post(auth::pair_desktop))
        .route("/providers", get(workspace::list_providers))
        .route("/devices", get(devices::list_devices))
        .route("/devices/{device_id}", get(devices::get_device_detail))
        .route("/devices/{device_id}/sessions", get(devices::list_sessions))
        .route(
            "/devices/{device_id}/providers",
            get(devices::list_device_providers),
        )
        .route(
            "/devices/{device_id}/projects",
            get(workspace::list_projects).post(workspace::create_project),
        )
        .route(
            "/devices/{device_id}/ai-sessions",
            get(workspace::list_ai_sessions).post(workspace::create_ai_session),
        )
        .route("/ai-sessions/{session_id}", get(workspace::get_ai_session))
        .route("/activity-logs", get(meta::list_activity_logs))
        .route(
            "/settings",
            get(meta::get_settings).put(meta::update_settings),
        )
        .route("/ws/mobile", get(ws_mobile))
        .route("/ws/desktop", get(ws_desktop))
        .with_state(state)
}
