mod state;

use anyhow::Context;
use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State, WebSocketUpgrade,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::{Duration, Utc};
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::{distributions::Alphanumeric, Rng};
use remote_term_shared::{
    assess_command_risk, AiProviderDefinition, AiSession, DesktopProviderStatus, GitStatusSnapshot,
    RealtimeMessage, TerminalErrorCode, TerminalSession, WorkspaceProject,
};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use state::{AppState, DesktopConnection, MobileConnection};
use std::{net::SocketAddr, sync::Arc};
use tokio::sync::mpsc;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::{error, info};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: Uuid,
    exp: usize,
}

#[derive(Debug, Deserialize)]
struct RegisterRequest {
    email: String,
    password: String,
}

#[derive(Debug, Deserialize)]
struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthResponse {
    access_token: String,
    refresh_token: String,
    user_id: Uuid,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingCodeResponse {
    code: String,
    expires_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairDesktopRequest {
    code: String,
    name: String,
    os: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairDesktopResponse {
    device_id: Uuid,
    access_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceResponse {
    id: Uuid,
    name: String,
    os: String,
    online: bool,
    last_seen_at: Option<chrono::DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceDetailResponse {
    id: Uuid,
    name: String,
    os: String,
    online: bool,
    last_seen_at: Option<chrono::DateTime<Utc>>,
    session_count: i64,
    tmux_count: i64,
    screen_count: i64,
    viewer_count: usize,
    latest_session_at: Option<chrono::DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityLogResponse {
    id: Uuid,
    device_id: Option<Uuid>,
    session_id: Option<String>,
    kind: String,
    title: String,
    body: String,
    risky: bool,
    created_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityLogQuery {
    device_id: Option<Uuid>,
    kind: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserSettingsResponse {
    command_logging_enabled: bool,
    risk_confirmation_enabled: bool,
    output_buffer_lines: i32,
    auto_reconnect_enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectRequest {
    name: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAiSessionRequest {
    provider_id: String,
    project_id: Option<Uuid>,
    project_path: Option<String>,
    title: String,
    creation_mode: String,
    terminal_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WsQuery {
    token: String,
}

#[derive(Debug, thiserror::Error)]
enum ApiError {
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("conflict: {0}")]
    Conflict(String),
    #[error(transparent)]
    Anyhow(#[from] anyhow::Error),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Jwt(#[from] jsonwebtoken::errors::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let status = match self {
            ApiError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ApiError::Unauthorized => StatusCode::UNAUTHORIZED,
            ApiError::Forbidden => StatusCode::FORBIDDEN,
            ApiError::Conflict(_) => StatusCode::CONFLICT,
            ApiError::Anyhow(_) | ApiError::Sqlx(_) | ApiError::Jwt(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        let body = Json(serde_json::json!({ "error": self.to_string() }));
        (status, body).into_response()
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .context("DATABASE_URL must point at a PostgreSQL database")?;
    let jwt_secret =
        std::env::var("JWT_SECRET").unwrap_or_else(|_| "dev-secret-change-me".to_string());
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".to_string());

    let pool = PgPool::connect(&database_url).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;

    let state = Arc::new(AppState::new(pool, jwt_secret));
    let app = Router::new()
        .route("/health", get(health))
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/pairing/codes", post(create_pairing_code))
        .route("/desktop/pair", post(pair_desktop))
        .route("/providers", get(list_providers))
        .route("/devices", get(list_devices))
        .route("/devices/{device_id}", get(get_device_detail))
        .route("/devices/{device_id}/sessions", get(list_sessions))
        .route(
            "/devices/{device_id}/providers",
            get(list_device_providers),
        )
        .route(
            "/devices/{device_id}/projects",
            get(list_projects).post(create_project),
        )
        .route(
            "/devices/{device_id}/ai-sessions",
            get(list_ai_sessions).post(create_ai_session),
        )
        .route("/ai-sessions/{session_id}", get(get_ai_session))
        .route("/activity-logs", get(list_activity_logs))
        .route("/settings", get(get_settings).put(update_settings))
        .route("/ws/mobile", get(ws_mobile))
        .route("/ws/desktop", get(ws_desktop))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr: SocketAddr = bind.parse()?;
    info!("relay server listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

async fn register(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>, ApiError> {
    validate_credentials(&req.email, &req.password)?;
    let password_hash = state.hash_password(&req.password)?;
    let user_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
    )
    .bind(req.email.to_ascii_lowercase())
    .bind(password_hash)
    .fetch_one(&state.pool)
    .await
    .map_err(|err| {
        if is_unique_violation(&err) {
            ApiError::Conflict("email already registered".to_string())
        } else {
            ApiError::Sqlx(err)
        }
    })?;

    Ok(Json(auth_response(&state, user_id)?))
}

async fn login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, ApiError> {
    let row = sqlx::query("SELECT id, password_hash FROM users WHERE email = $1")
        .bind(req.email.to_ascii_lowercase())
        .fetch_optional(&state.pool)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    let user_id: Uuid = row.get("id");
    let password_hash: String = row.get("password_hash");
    if !state.verify_password(&req.password, &password_hash)? {
        return Err(ApiError::Unauthorized);
    }
    Ok(Json(auth_response(&state, user_id)?))
}

async fn create_pairing_code(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<PairingCodeResponse>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    let code = random_pairing_code();
    let expires_at = Utc::now() + Duration::minutes(10);
    sqlx::query("INSERT INTO pairing_codes (user_id, code, expires_at) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(&code)
        .bind(expires_at)
        .execute(&state.pool)
        .await?;
    Ok(Json(PairingCodeResponse { code, expires_at }))
}

async fn pair_desktop(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PairDesktopRequest>,
) -> Result<Json<PairDesktopResponse>, ApiError> {
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query(
        "SELECT id, user_id FROM pairing_codes WHERE code = $1 AND used_at IS NULL AND expires_at > NOW() FOR UPDATE",
    )
    .bind(req.code.trim())
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::BadRequest("pairing code is invalid or expired".to_string()))?;
    let code_id: Uuid = row.get("id");
    let user_id: Uuid = row.get("user_id");
    let device_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO desktop_devices (user_id, name, os, online, last_seen_at) VALUES ($1, $2, $3, FALSE, NOW()) RETURNING id",
    )
    .bind(user_id)
    .bind(req.name.trim())
    .bind(req.os.trim())
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("UPDATE pairing_codes SET used_at = NOW() WHERE id = $1")
        .bind(code_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(PairDesktopResponse {
        device_id,
        access_token: token_for(&state, user_id, Duration::days(180))?,
    }))
}

async fn list_providers(
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

async fn list_devices(
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

async fn list_device_providers(
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

async fn list_projects(
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

async fn create_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(device_id): Path<Uuid>,
    Json(req): Json<CreateProjectRequest>,
) -> Result<Json<WorkspaceProject>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    ensure_device_owner(&state.pool, user_id, device_id).await?;
    if req.name.trim().is_empty() || req.path.trim().is_empty() {
        return Err(ApiError::BadRequest("project name and path are required".to_string()));
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

async fn list_ai_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(device_id): Path<Uuid>,
) -> Result<Json<Vec<AiSession>>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    ensure_device_owner(&state.pool, user_id, device_id).await?;
    let rows = sqlx::query(
        "SELECT id, user_id, device_id, project_id, provider_id, terminal_session_id, title, status, summary, updated_at FROM ai_sessions WHERE device_id = $1 AND user_id = $2 ORDER BY updated_at DESC",
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

async fn create_ai_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(device_id): Path<Uuid>,
    Json(req): Json<CreateAiSessionRequest>,
) -> Result<Json<AiSession>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    ensure_device_owner(&state.pool, user_id, device_id).await?;
    if req.provider_id.trim().is_empty() || req.title.trim().is_empty() {
        return Err(ApiError::BadRequest("providerId and title are required".to_string()));
    }
    if let Some(project_id) = req.project_id {
        ensure_project_owner(&state.pool, device_id, project_id).await?;
    }
    let row = sqlx::query(
        r#"
        INSERT INTO ai_sessions (user_id, device_id, project_id, provider_id, terminal_session_id, title, status, summary, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'idle', $7, NOW())
        RETURNING id, user_id, device_id, project_id, provider_id, terminal_session_id, title, status, summary, updated_at
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

async fn get_ai_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<Uuid>,
) -> Result<Json<AiSession>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    let row = sqlx::query(
        "SELECT id, user_id, device_id, project_id, provider_id, terminal_session_id, title, status, summary, updated_at FROM ai_sessions WHERE id = $1 AND user_id = $2",
    )
    .bind(session_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::Forbidden)?;
    Ok(Json(row_to_ai_session(row)?))
}

async fn get_device_detail(
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

async fn list_sessions(
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

async fn list_activity_logs(
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

async fn get_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<UserSettingsResponse>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    Ok(Json(load_settings(&state.pool, user_id).await?))
}

async fn update_settings(
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

async fn ws_mobile(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(query): Query<WsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let user_id = authenticate_token(&state, &query.token)?;
    Ok(ws.on_upgrade(move |socket| mobile_socket(state, user_id, socket)))
}

async fn ws_desktop(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(query): Query<WsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let user_id = authenticate_token(&state, &query.token)?;
    Ok(ws.on_upgrade(move |socket| desktop_socket(state, user_id, socket)))
}

async fn mobile_socket(state: Arc<AppState>, user_id: Uuid, socket: WebSocket) {
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

async fn desktop_socket(state: Arc<AppState>, user_id: Uuid, socket: WebSocket) {
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
        notify_mobiles(
            &state,
            user_id,
            RealtimeMessage::DesktopHeartbeat {
                device_id,
                timestamp: Utc::now(),
            },
        )
        .await;
    }
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
        } => {
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
                .unwrap_or_else(|_| default_settings());
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
                        message: "This command requires confirmation before it can run."
                            .to_string(),
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
        RealtimeMessage::TerminalControl {
            device_id,
            session_id,
            control,
        } => {
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
        RealtimeMessage::AiMessageSend {
            device_id,
            ai_session_id,
            content,
            confirmed_risk,
        } => {
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
                        message: "This AI message requires confirmation before it can run."
                            .to_string(),
                    },
                )
                .await;
                return;
            }
            let body = format!("AI 会话 {ai_session_id}：{}", content.chars().take(160).collect::<String>());
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
        RealtimeMessage::AiHistoryRequest {
            device_id,
            ai_session_id,
            request_id,
        } => {
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
        _ => {}
    }
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
        } => {
            if ensure_device_owner(&state.pool, user_id, device_id)
                .await
                .is_err()
            {
                return None;
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
            let heartbeat = RealtimeMessage::DesktopHeartbeat {
                device_id,
                timestamp: Utc::now(),
            };
            notify_mobiles(state, user_id, heartbeat).await;
            Some(device_id)
        }
        RealtimeMessage::SessionsSnapshot {
            device_id,
            sessions,
        } => {
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
        RealtimeMessage::TerminalOutput { device_id, .. }
        | RealtimeMessage::TerminalError { device_id, .. } => {
            if let RealtimeMessage::TerminalError {
                session_id,
                message,
                ..
            } = &message
            {
                insert_activity_log(
                    &state.pool,
                    ActivityLogInsert {
                        user_id,
                        device_id: Some(device_id),
                        session_id: session_id.as_deref(),
                        kind: "error",
                        title: "终端错误",
                        body: message,
                        risky: false,
                    },
                )
                .await;
            }
            notify_mobiles(state, user_id, message).await;
            Some(device_id)
        }
        RealtimeMessage::ProvidersSnapshot {
            device_id,
            providers,
        } => {
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
        RealtimeMessage::ProjectsSnapshot {
            device_id,
            projects,
        } => {
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
        RealtimeMessage::AiSessionsSnapshot {
            device_id,
            sessions,
        } => {
            if ensure_device_owner(&state.pool, user_id, device_id)
                .await
                .is_err()
            {
                return None;
            }
            if let Err(err) = upsert_ai_sessions(&state.pool, &sessions).await {
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
        RealtimeMessage::AiMessageDelta { device_id, .. }
        | RealtimeMessage::AiMessageDone { device_id, .. }
        | RealtimeMessage::AiHistoryResponse { device_id, .. }
        | RealtimeMessage::GitStatusSnapshot {
            snapshot: GitStatusSnapshot { device_id, .. },
        } => {
            notify_mobiles(state, user_id, message).await;
            Some(device_id)
        }
        _ => None,
    }
}

async fn forward_to_desktop(
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

async fn notify_mobiles(state: &Arc<AppState>, user_id: Uuid, message: RealtimeMessage) {
    if let Some(mobiles) = state.mobiles.read().await.get(&user_id) {
        for mobile in mobiles.values() {
            let _ = mobile.tx.send(message.clone());
        }
    }
}

struct ActivityLogInsert<'a> {
    user_id: Uuid,
    device_id: Option<Uuid>,
    session_id: Option<&'a str>,
    kind: &'a str,
    title: &'a str,
    body: &'a str,
    risky: bool,
}

async fn insert_activity_log(pool: &PgPool, item: ActivityLogInsert<'_>) {
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

async fn load_settings(pool: &PgPool, user_id: Uuid) -> Result<UserSettingsResponse, sqlx::Error> {
    let row = sqlx::query(
        "SELECT command_logging_enabled, risk_confirmation_enabled, output_buffer_lines, auto_reconnect_enabled FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(row_to_settings(row))
}

fn default_settings() -> UserSettingsResponse {
    UserSettingsResponse {
        command_logging_enabled: true,
        risk_confirmation_enabled: true,
        output_buffer_lines: 10000,
        auto_reconnect_enabled: true,
    }
}

fn row_to_settings(row: sqlx::postgres::PgRow) -> UserSettingsResponse {
    UserSettingsResponse {
        command_logging_enabled: row.get("command_logging_enabled"),
        risk_confirmation_enabled: row.get("risk_confirmation_enabled"),
        output_buffer_lines: row.get("output_buffer_lines"),
        auto_reconnect_enabled: row.get("auto_reconnect_enabled"),
    }
}

async fn ensure_device_owner(
    pool: &PgPool,
    user_id: Uuid,
    device_id: Uuid,
) -> Result<(), ApiError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM desktop_devices WHERE id = $1 AND user_id = $2)",
    )
    .bind(device_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    exists.then_some(()).ok_or(ApiError::Forbidden)
}

async fn ensure_project_owner(
    pool: &PgPool,
    device_id: Uuid,
    project_id: Uuid,
) -> Result<(), ApiError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM workspace_projects WHERE id = $1 AND device_id = $2)",
    )
    .bind(project_id)
    .bind(device_id)
    .fetch_one(pool)
    .await?;
    exists.then_some(()).ok_or(ApiError::Forbidden)
}

async fn ensure_ai_session_owner(
    pool: &PgPool,
    user_id: Uuid,
    ai_session_id: Uuid,
    device_id: Uuid,
) -> Result<(), ApiError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM ai_sessions WHERE id = $1 AND user_id = $2 AND device_id = $3)",
    )
    .bind(ai_session_id)
    .bind(user_id)
    .bind(device_id)
    .fetch_one(pool)
    .await?;
    exists.then_some(()).ok_or(ApiError::Forbidden)
}

async fn mark_device_online(
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

async fn upsert_provider_statuses(
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

async fn upsert_projects(
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
            ON CONFLICT (device_id, path)
            DO UPDATE SET name = EXCLUDED.name, git_branch = EXCLUDED.git_branch, git_dirty = EXCLUDED.git_dirty, updated_at = EXCLUDED.updated_at
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

async fn upsert_ai_sessions(pool: &PgPool, sessions: &[AiSession]) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for session in sessions {
        sqlx::query(
            r#"
            INSERT INTO ai_sessions (id, user_id, device_id, project_id, provider_id, terminal_session_id, title, status, summary, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id)
            DO UPDATE SET project_id = EXCLUDED.project_id, provider_id = EXCLUDED.provider_id, terminal_session_id = EXCLUDED.terminal_session_id, title = EXCLUDED.title, status = EXCLUDED.status, summary = EXCLUDED.summary, updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(session.id)
        .bind(session.user_id)
        .bind(session.device_id)
        .bind(session.project_id)
        .bind(&session.provider_id)
        .bind(&session.terminal_session_id)
        .bind(&session.title)
        .bind(serde_json::to_value(&session.status).unwrap().as_str().unwrap())
        .bind(&session.summary)
        .bind(session.updated_at)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn upsert_sessions(
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

fn row_to_session(row: sqlx::postgres::PgRow) -> anyhow::Result<TerminalSession> {
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

fn row_to_provider(row: sqlx::postgres::PgRow) -> AiProviderDefinition {
    AiProviderDefinition {
        id: row.get("id"),
        name: row.get("name"),
        command: row.get("command"),
        built_in: row.get("built_in"),
        enabled: row.get("enabled"),
    }
}

fn row_to_provider_status(row: sqlx::postgres::PgRow) -> anyhow::Result<DesktopProviderStatus> {
    Ok(DesktopProviderStatus {
        provider_id: row.get("provider_id"),
        installed: row.get("installed"),
        version: row.get("version"),
        auth_status: serde_json::from_value(serde_json::Value::String(row.get("auth_status")))?,
        last_checked_at: row.get("last_checked_at"),
    })
}

fn row_to_project(row: sqlx::postgres::PgRow) -> WorkspaceProject {
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

fn row_to_ai_session(row: sqlx::postgres::PgRow) -> anyhow::Result<AiSession> {
    Ok(AiSession {
        id: row.get("id"),
        user_id: row.get("user_id"),
        device_id: row.get("device_id"),
        project_id: row.get("project_id"),
        provider_id: row.get("provider_id"),
        terminal_session_id: row.get("terminal_session_id"),
        title: row.get("title"),
        status: serde_json::from_value(serde_json::Value::String(row.get("status")))?,
        summary: row.get("summary"),
        updated_at: row.get("updated_at"),
    })
}

fn validate_credentials(email: &str, password: &str) -> Result<(), ApiError> {
    if !email.contains('@') {
        return Err(ApiError::BadRequest("email is invalid".to_string()));
    }
    if password.len() < 8 {
        return Err(ApiError::BadRequest(
            "password must be at least 8 characters".to_string(),
        ));
    }
    Ok(())
}

fn auth_response(state: &AppState, user_id: Uuid) -> Result<AuthResponse, ApiError> {
    Ok(AuthResponse {
        access_token: token_for(state, user_id, Duration::hours(12))?,
        refresh_token: token_for(state, user_id, Duration::days(30))?,
        user_id,
    })
}

fn token_for(state: &AppState, user_id: Uuid, ttl: Duration) -> Result<String, ApiError> {
    let exp = (Utc::now() + ttl).timestamp() as usize;
    Ok(encode(
        &Header::default(),
        &Claims { sub: user_id, exp },
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    )?)
}

fn authenticate_headers(state: &AppState, headers: &HeaderMap) -> Result<Uuid, ApiError> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    let token = value
        .strip_prefix("Bearer ")
        .ok_or(ApiError::Unauthorized)?;
    authenticate_token(state, token)
}

fn authenticate_token(state: &AppState, token: &str) -> Result<Uuid, ApiError> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(state.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| ApiError::Unauthorized)?;
    Ok(data.claims.sub)
}

fn random_pairing_code() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(8)
        .map(char::from)
        .collect::<String>()
        .to_ascii_uppercase()
}

fn is_unique_violation(err: &sqlx::Error) -> bool {
    err.as_database_error().and_then(|db| db.code()).as_deref() == Some("23505")
}
