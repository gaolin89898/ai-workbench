pub mod desktop;
pub mod dispatch;
pub mod mobile;

use axum::{
    extract::{ws::WebSocketUpgrade, Query, State},
    response::IntoResponse,
};
use std::sync::Arc;

use crate::auth::authenticate_token;
use crate::error::ApiError;
use crate::models::WsQuery;
use crate::state::AppState;

pub async fn ws_mobile(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(query): Query<WsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let user_id = authenticate_token(&state, &query.token)?;
    Ok(ws.on_upgrade(move |socket| mobile::mobile_socket(state, user_id, socket)))
}

pub async fn ws_desktop(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(query): Query<WsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let user_id = authenticate_token(&state, &query.token)?;
    Ok(ws.on_upgrade(move |socket| desktop::desktop_socket(state, user_id, socket)))
}
