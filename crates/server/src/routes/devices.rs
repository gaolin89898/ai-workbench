use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use sqlx::Row;
use std::sync::Arc;
use uuid::Uuid;

use remote_term_shared::{DesktopProviderStatus, TerminalSession};

use crate::auth::authenticate_headers;
use crate::db::{ensure_device_owner, row_to_provider_status, row_to_session};
use crate::error::ApiError;
use crate::models::{DeviceDetailResponse, DeviceResponse};
use crate::state::AppState;

pub async fn list_devices(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<DeviceResponse>>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    let rows = sqlx::query(
        "SELECT id, name, os, online, last_seen_at FROM desktop_devices WHERE user_id = $1 ORDER BY created_at DESC",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    let devices = rows
        .into_iter()
        .map(|row| DeviceResponse {
            id: row.get("id"),
            name: row.get("name"),
            os: row.get("os"),
            online: row.get("online"),
            last_seen_at: row.get("last_seen_at"),
        })
        .collect();
    Ok(Json(devices))
}

pub async fn get_device_detail(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(device_id): Path<Uuid>,
) -> Result<Json<DeviceDetailResponse>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    let row = sqlx::query(
        r#"
        SELECT
          d.id,
          d.name,
          d.os,
          d.online,
          d.last_seen_at,
          COUNT(s.id)::BIGINT AS session_count,
          COUNT(s.id) FILTER (WHERE s.backend = 'tmux')::BIGINT AS tmux_count,
          COUNT(s.id) FILTER (WHERE s.backend = 'screen')::BIGINT AS screen_count,
          MAX(s.updated_at) AS latest_session_at
        FROM desktop_devices d
        LEFT JOIN terminal_sessions s ON s.device_id = d.id
        WHERE d.id = $1 AND d.user_id = $2
        GROUP BY d.id
        "#,
    )
    .bind(device_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::Forbidden)?;

    Ok(Json(DeviceDetailResponse {
        id: row.get("id"),
        name: row.get("name"),
        os: row.get("os"),
        online: row.get("online"),
        last_seen_at: row.get("last_seen_at"),
        session_count: row.get("session_count"),
        tmux_count: row.get("tmux_count"),
        screen_count: row.get("screen_count"),
        viewer_count: state.mobile_viewer_count(user_id).await,
        latest_session_at: row.get("latest_session_at"),
    }))
}

pub async fn list_device_providers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(device_id): Path<Uuid>,
) -> Result<Json<Vec<DesktopProviderStatus>>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    ensure_device_owner(&state.pool, user_id, device_id).await?;
    let rows = sqlx::query(
        "SELECT provider_id, installed, version, auth_status, last_checked_at FROM desktop_provider_status WHERE device_id = $1 ORDER BY provider_id",
    )
    .bind(device_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(row_to_provider_status)
            .collect::<Result<Vec<_>, _>>()?,
    ))
}

pub async fn list_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(device_id): Path<Uuid>,
) -> Result<Json<Vec<TerminalSession>>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    ensure_device_owner(&state.pool, user_id, device_id).await?;
    let rows = sqlx::query(
        "SELECT session_id, name, backend, tool, status, cwd, recent_output FROM terminal_sessions WHERE device_id = $1 ORDER BY name",
    )
    .bind(device_id)
    .fetch_all(&state.pool)
    .await?;
    let sessions = rows
        .into_iter()
        .map(row_to_session)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(sessions))
}
