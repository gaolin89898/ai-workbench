use sqlx::{PgPool, Row};
use tracing::error;
use uuid::Uuid;

use crate::models::UserSettingsResponse;
use remote_term_shared::{
    AiProviderDefinition, AiSession, DesktopProviderStatus, TerminalSession, WorkspaceProject,
};

pub async fn ensure_device_owner(
    pool: &PgPool,
    user_id: Uuid,
    device_id: Uuid,
) -> Result<(), crate::error::ApiError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM desktop_devices WHERE id = $1 AND user_id = $2)",
    )
    .bind(device_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    exists
        .then_some(())
        .ok_or(crate::error::ApiError::Forbidden)
}

pub async fn ensure_project_owner(
    pool: &PgPool,
    device_id: Uuid,
    project_id: Uuid,
) -> Result<(), crate::error::ApiError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM workspace_projects WHERE id = $1 AND device_id = $2)",
    )
    .bind(project_id)
    .bind(device_id)
    .fetch_one(pool)
    .await?;
    exists
        .then_some(())
        .ok_or(crate::error::ApiError::Forbidden)
}

pub async fn ensure_ai_session_owner(
    pool: &PgPool,
    user_id: Uuid,
    ai_session_id: Uuid,
    device_id: Uuid,
) -> Result<(), crate::error::ApiError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM ai_sessions WHERE id = $1 AND user_id = $2 AND device_id = $3)",
    )
    .bind(ai_session_id)
    .bind(user_id)
    .bind(device_id)
    .fetch_one(pool)
    .await?;
    exists
        .then_some(())
        .ok_or(crate::error::ApiError::Forbidden)
}

pub async fn mark_device_online(
    pool: &PgPool,
    device_id: Uuid,
    online: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE desktop_devices SET online = $1, last_seen_at = NOW() WHERE id = $2")
        .bind(online)
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn upsert_provider_statuses(
    pool: &PgPool,
    device_id: Uuid,
    providers: &[DesktopProviderStatus],
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for provider in providers {
        sqlx::query(
            r#"
            INSERT INTO desktop_provider_status (device_id, provider_id, installed, version, auth_status, last_checked_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (device_id, provider_id)
            DO UPDATE SET installed = EXCLUDED.installed, version = EXCLUDED.version, auth_status = EXCLUDED.auth_status, last_checked_at = EXCLUDED.last_checked_at
            "#,
        )
        .bind(device_id)
        .bind(&provider.provider_id)
        .bind(provider.installed)
        .bind(&provider.version)
        .bind(serde_json::to_value(&provider.auth_status).unwrap().as_str().unwrap())
        .bind(provider.last_checked_at)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn upsert_projects(
    pool: &PgPool,
    device_id: Uuid,
    projects: &[WorkspaceProject],
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for project in projects {
        sqlx::query(
            r#"
            INSERT INTO workspace_projects (id, device_id, name, path, git_branch, git_dirty, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id)
            DO UPDATE SET device_id = EXCLUDED.device_id, name = EXCLUDED.name, path = EXCLUDED.path, git_branch = EXCLUDED.git_branch, git_dirty = EXCLUDED.git_dirty, updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(project.id)
        .bind(device_id)
        .bind(&project.name)
        .bind(&project.path)
        .bind(&project.git_branch)
        .bind(project.git_dirty)
        .bind(project.updated_at)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn upsert_ai_sessions(
    pool: &PgPool,
    user_id: Uuid,
    device_id: Uuid,
    sessions: &[AiSession],
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for session in sessions {
        sqlx::query(
            r#"
            INSERT INTO ai_sessions (id, user_id, device_id, project_id, provider_id, terminal_session_id, provider_session_id, title, status, summary, archived_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (id)
            DO UPDATE SET project_id = EXCLUDED.project_id, provider_id = EXCLUDED.provider_id, terminal_session_id = EXCLUDED.terminal_session_id, provider_session_id = EXCLUDED.provider_session_id, title = EXCLUDED.title, status = EXCLUDED.status, summary = EXCLUDED.summary, archived_at = EXCLUDED.archived_at, updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(session.id)
        .bind(user_id)
        .bind(device_id)
        .bind(session.project_id)
        .bind(&session.provider_id)
        .bind(&session.terminal_session_id)
        .bind(&session.provider_session_id)
        .bind(&session.title)
        .bind(serde_json::to_value(&session.status).unwrap().as_str().unwrap())
        .bind(&session.summary)
        .bind(session.archived_at)
        .bind(session.updated_at)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn upsert_sessions(
    pool: &PgPool,
    device_id: Uuid,
    sessions: &[TerminalSession],
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for session in sessions {
        sqlx::query(
            "INSERT INTO terminal_sessions (device_id, session_id, name, backend, tool, status, cwd, recent_output, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             ON CONFLICT (device_id, session_id)
             DO UPDATE SET name = EXCLUDED.name, backend = EXCLUDED.backend, tool = EXCLUDED.tool, status = EXCLUDED.status, cwd = EXCLUDED.cwd, recent_output = EXCLUDED.recent_output, updated_at = NOW()",
        )
        .bind(device_id)
        .bind(&session.session_id)
        .bind(&session.name)
        .bind(serde_json::to_value(&session.backend).unwrap().as_str().unwrap())
        .bind(serde_json::to_value(&session.tool).unwrap().as_str().unwrap())
        .bind(serde_json::to_value(&session.status).unwrap().as_str().unwrap())
        .bind(&session.cwd)
        .bind(&session.recent_output)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub fn row_to_session(row: sqlx::postgres::PgRow) -> anyhow::Result<TerminalSession> {
    Ok(TerminalSession {
        session_id: row.get("session_id"),
        name: row.get("name"),
        backend: serde_json::from_value(serde_json::Value::String(row.get("backend")))?,
        tool: serde_json::from_value(serde_json::Value::String(row.get("tool")))?,
        status: serde_json::from_value(serde_json::Value::String(row.get("status")))?,
        cwd: row.get("cwd"),
        recent_output: row.get("recent_output"),
    })
}

pub fn row_to_provider(row: sqlx::postgres::PgRow) -> AiProviderDefinition {
    AiProviderDefinition {
        id: row.get("id"),
        name: row.get("name"),
        command: row.get("command"),
        built_in: row.get("built_in"),
        enabled: row.get("enabled"),
    }
}

pub fn row_to_provider_status(row: sqlx::postgres::PgRow) -> anyhow::Result<DesktopProviderStatus> {
    Ok(DesktopProviderStatus {
        provider_id: row.get("provider_id"),
        installed: row.get("installed"),
        version: row.get("version"),
        auth_status: serde_json::from_value(serde_json::Value::String(row.get("auth_status")))?,
        last_checked_at: row.get("last_checked_at"),
    })
}

pub fn row_to_project(row: sqlx::postgres::PgRow) -> WorkspaceProject {
    WorkspaceProject {
        id: row.get("id"),
        device_id: row.get("device_id"),
        name: row.get("name"),
        path: row.get("path"),
        git_branch: row.get("git_branch"),
        git_dirty: row.get("git_dirty"),
        updated_at: row.get("updated_at"),
    }
}

pub fn row_to_ai_session(row: sqlx::postgres::PgRow) -> anyhow::Result<AiSession> {
    Ok(AiSession {
        id: row.get("id"),
        user_id: row.get("user_id"),
        device_id: row.get("device_id"),
        project_id: row.get("project_id"),
        provider_id: row.get("provider_id"),
        terminal_session_id: row.get("terminal_session_id"),
        provider_session_id: row.get("provider_session_id"),
        title: row.get("title"),
        status: serde_json::from_value(serde_json::Value::String(row.get("status")))?,
        summary: row.get("summary"),
        archived_at: row.get("archived_at"),
        updated_at: row.get("updated_at"),
    })
}

pub struct ActivityLogInsert<'a> {
    pub user_id: Uuid,
    pub device_id: Option<Uuid>,
    pub session_id: Option<&'a str>,
    pub kind: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub risky: bool,
}

pub async fn insert_activity_log(pool: &PgPool, item: ActivityLogInsert<'_>) {
    if let Err(err) = sqlx::query(
        "INSERT INTO activity_logs (user_id, device_id, session_id, kind, title, body, risky) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(item.user_id)
    .bind(item.device_id)
    .bind(item.session_id)
    .bind(item.kind)
    .bind(item.title)
    .bind(item.body)
    .bind(item.risky)
    .execute(pool)
    .await
    {
        error!(?err, "failed to insert activity log");
    }
}

pub async fn load_settings(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<UserSettingsResponse, sqlx::Error> {
    let row = sqlx::query(
        "SELECT command_logging_enabled, risk_confirmation_enabled, output_buffer_lines, auto_reconnect_enabled FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(row_to_settings(row))
}

pub fn default_settings() -> UserSettingsResponse {
    UserSettingsResponse {
        command_logging_enabled: true,
        risk_confirmation_enabled: true,
        output_buffer_lines: 10000,
        auto_reconnect_enabled: true,
    }
}

pub fn row_to_settings(row: sqlx::postgres::PgRow) -> UserSettingsResponse {
    UserSettingsResponse {
        command_logging_enabled: row.get("command_logging_enabled"),
        risk_confirmation_enabled: row.get("risk_confirmation_enabled"),
        output_buffer_lines: row.get("output_buffer_lines"),
        auto_reconnect_enabled: row.get("auto_reconnect_enabled"),
    }
}
