use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use sqlx::Row;
use std::sync::Arc;

use crate::auth::authenticate_headers;
use crate::db::{
    ensure_device_owner, insert_activity_log, load_settings, row_to_settings, ActivityLogInsert,
};
use crate::error::ApiError;
use crate::models::{ActivityLogQuery, ActivityLogResponse, UserSettingsResponse};
use crate::state::AppState;

pub async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

pub async fn list_activity_logs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ActivityLogQuery>,
) -> Result<Json<Vec<ActivityLogResponse>>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    if let Some(device_id) = query.device_id {
        ensure_device_owner(&state.pool, user_id, device_id).await?;
    }
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let rows = sqlx::query(
        r#"
        SELECT id, device_id, session_id, kind, title, body, risky, created_at
        FROM activity_logs
        WHERE user_id = $1
          AND ($2::UUID IS NULL OR device_id = $2)
          AND ($3::TEXT IS NULL OR kind = $3)
        ORDER BY created_at DESC
        LIMIT $4
        "#,
    )
    .bind(user_id)
    .bind(query.device_id)
    .bind(query.kind.as_deref())
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|row| ActivityLogResponse {
                id: row.get("id"),
                device_id: row.get("device_id"),
                session_id: row.get("session_id"),
                kind: row.get("kind"),
                title: row.get("title"),
                body: row.get("body"),
                risky: row.get("risky"),
                created_at: row.get("created_at"),
            })
            .collect(),
    ))
}

pub async fn get_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<UserSettingsResponse>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    Ok(Json(load_settings(&state.pool, user_id).await?))
}

pub async fn update_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<UserSettingsResponse>,
) -> Result<Json<UserSettingsResponse>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    let output_buffer_lines = req.output_buffer_lines.clamp(1000, 20000);
    let row = sqlx::query(
        r#"
        UPDATE users
        SET command_logging_enabled = $1,
            risk_confirmation_enabled = $2,
            output_buffer_lines = $3,
            auto_reconnect_enabled = $4
        WHERE id = $5
        RETURNING command_logging_enabled, risk_confirmation_enabled, output_buffer_lines, auto_reconnect_enabled
        "#,
    )
    .bind(req.command_logging_enabled)
    .bind(req.risk_confirmation_enabled)
    .bind(output_buffer_lines)
    .bind(req.auto_reconnect_enabled)
    .bind(user_id)
    .fetch_one(&state.pool)
    .await?;

    let settings = row_to_settings(row);
    insert_activity_log(
        &state.pool,
        ActivityLogInsert {
            user_id,
            device_id: None,
            session_id: None,
            kind: "settings",
            title: "设置已更新",
            body: "移动端风险确认、自动重连、命令摘要或输出缓存设置已更新。",
            risky: false,
        },
    )
    .await;
    Ok(Json(settings))
}
