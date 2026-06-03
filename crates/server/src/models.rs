use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    pub exp: usize,
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: Uuid,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCodeResponse {
    pub code: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairDesktopRequest {
    pub code: String,
    pub name: String,
    pub os: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairDesktopResponse {
    pub device_id: Uuid,
    pub access_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDesktopPairingRequest {
    pub name: String,
    pub os: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPairingRequestResponse {
    pub code: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPairingStatusResponse {
    pub status: String,
    pub expires_at: DateTime<Utc>,
    pub device_id: Option<Uuid>,
    pub access_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceResponse {
    pub id: Uuid,
    pub name: String,
    pub os: String,
    pub online: bool,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDetailResponse {
    pub id: Uuid,
    pub name: String,
    pub os: String,
    pub online: bool,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub session_count: i64,
    pub tmux_count: i64,
    pub screen_count: i64,
    pub viewer_count: usize,
    pub latest_session_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityLogResponse {
    pub id: Uuid,
    pub device_id: Option<Uuid>,
    pub session_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub risky: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityLogQuery {
    pub device_id: Option<Uuid>,
    pub kind: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSettingsResponse {
    pub command_logging_enabled: bool,
    pub risk_confirmation_enabled: bool,
    pub output_buffer_lines: i32,
    pub auto_reconnect_enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAiSessionRequest {
    pub provider_id: String,
    pub project_id: Option<Uuid>,
    pub project_path: Option<String>,
    pub title: String,
    pub creation_mode: String,
    pub terminal_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub token: String,
}
