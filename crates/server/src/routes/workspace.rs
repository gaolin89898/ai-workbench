use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use remote_term_shared::{AiProviderDefinition, AiSession, RealtimeMessage, WorkspaceProject};
use std::sync::Arc;
use uuid::Uuid;

use crate::auth::authenticate_headers;
use crate::db::{ensure_device_owner, ensure_project_owner, row_to_ai_session, row_to_project, row_to_provider};
use crate::error::ApiError;
use crate::models::CreateAiSessionRequest;
use crate::state::AppState;
use crate::ws::dispatch::forward_to_desktop;

pub async fn list_providers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<AiProviderDefinition>>, ApiError> {
    let _user_id = authenticate_headers(&state, &headers)?;
    let rows = sqlx::query(
        "SELECT id, name, command, built_in, enabled FROM ai_providers WHERE enabled = TRUE ORDER BY built_in DESC, name",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows.into_iter().map(row_to_provider).collect()))
}

pub async fn list_projects(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(device_id): Path<Uuid>,
) -> Result<Json<Vec<WorkspaceProject>>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    ensure_device_owner(&state.pool, user_id, device_id).await?;
    let rows = sqlx::query(
        "SELECT id, device_id, name, path, git_branch, git_dirty, updated_at FROM workspace_projects WHERE device_id = $1 ORDER BY updated_at DESC",
    )
    .bind(device_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows.into_iter().map(row_to_project).collect()))
}

pub async fn create_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(device_id): Path<Uuid>,
    Json(req): Json<crate::models::CreateProjectRequest>,
) -> Result<Json<WorkspaceProject>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    ensure_device_owner(&state.pool, user_id, device_id).await?;
    if req.name.trim().is_empty() || req.path.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "project name and path are required".to_string(),
        ));
    }
    let row = sqlx::query(
        r#"
        INSERT INTO workspace_projects (device_id, name, path, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (device_id, path)
        DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
        RETURNING id, device_id, name, path, git_branch, git_dirty, updated_at
        "#,
    )
    .bind(device_id)
    .bind(req.name.trim())
    .bind(req.path.trim())
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(row_to_project(row)))
}

pub async fn list_ai_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(device_id): Path<Uuid>,
) -> Result<Json<Vec<AiSession>>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    ensure_device_owner(&state.pool, user_id, device_id).await?;
    let rows = sqlx::query(
        "SELECT id, user_id, device_id, project_id, provider_id, terminal_session_id, title, status, summary, archived_at, updated_at FROM ai_sessions WHERE device_id = $1 AND user_id = $2 ORDER BY updated_at DESC",
    )
    .bind(device_id)
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(row_to_ai_session)
            .collect::<Result<Vec<_>, _>>()?,
    ))
}

pub async fn create_ai_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(device_id): Path<Uuid>,
    Json(req): Json<CreateAiSessionRequest>,
) -> Result<Json<AiSession>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    ensure_device_owner(&state.pool, user_id, device_id).await?;
    if req.provider_id.trim().is_empty() || req.title.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "providerId and title are required".to_string(),
        ));
    }
    if let Some(project_id) = req.project_id {
        ensure_project_owner(&state.pool, device_id, project_id).await?;
    }
    let row = sqlx::query(
        r#"
        INSERT INTO ai_sessions (user_id, device_id, project_id, provider_id, terminal_session_id, title, status, summary, archived_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'idle', $7, NULL, NOW())
        RETURNING id, user_id, device_id, project_id, provider_id, terminal_session_id, title, status, summary, archived_at, updated_at
        "#,
    )
    .bind(user_id)
    .bind(device_id)
    .bind(req.project_id)
    .bind(req.provider_id.trim())
    .bind(req.terminal_session_id.as_deref())
    .bind(req.title.trim())
    .bind(req.project_path.as_deref())
    .fetch_one(&state.pool)
    .await?;
    let session = row_to_ai_session(row)?;
    forward_to_desktop(
        &state,
        user_id,
        device_id,
        RealtimeMessage::AiSessionCreate {
            device_id,
            request_id: Uuid::new_v4(),
            provider_id: req.provider_id,
            project_id: req.project_id,
            project_path: req.project_path,
            title: req.title,
            creation_mode: req.creation_mode,
            terminal_session_id: req.terminal_session_id,
        },
    )
    .await;
    Ok(Json(session))
}

pub async fn get_ai_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<Uuid>,
) -> Result<Json<AiSession>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    let row = sqlx::query(
        "SELECT id, user_id, device_id, project_id, provider_id, terminal_session_id, title, status, summary, archived_at, updated_at FROM ai_sessions WHERE id = $1 AND user_id = $2",
    )
    .bind(session_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::Forbidden)?;
    Ok(Json(row_to_ai_session(row)?))
}
