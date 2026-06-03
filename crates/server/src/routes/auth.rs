use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use chrono::{Duration, Utc};
use sqlx::Row;
use std::sync::Arc;
use uuid::Uuid;

use crate::auth::{
    auth_response, authenticate_headers, is_unique_violation, random_pairing_code, token_for,
    validate_credentials,
};
use crate::error::ApiError;
use crate::models::{
    AuthResponse, CreateDesktopPairingRequest, DesktopPairingRequestResponse,
    DesktopPairingStatusResponse, LoginRequest, PairDesktopRequest, PairDesktopResponse,
    PairingCodeResponse, RegisterRequest,
};
use crate::state::AppState;

pub async fn register(
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

pub async fn login(
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

pub async fn create_pairing_code(
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

pub async fn pair_desktop(
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

pub async fn create_desktop_pairing_request(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateDesktopPairingRequest>,
) -> Result<Json<DesktopPairingRequestResponse>, ApiError> {
    let name = req.name.trim();
    let os = req.os.trim();
    if name.is_empty() || os.is_empty() {
        return Err(ApiError::BadRequest(
            "desktop name and os are required".to_string(),
        ));
    }
    let code = random_pairing_code();
    let expires_at = Utc::now() + Duration::minutes(10);
    sqlx::query(
        "INSERT INTO desktop_pairing_requests (code, name, os, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(&code)
    .bind(name)
    .bind(os)
    .bind(expires_at)
    .execute(&state.pool)
    .await?;
    Ok(Json(DesktopPairingRequestResponse { code, expires_at }))
}

pub async fn approve_desktop_pairing_request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Result<Json<PairDesktopResponse>, ApiError> {
    let user_id = authenticate_headers(&state, &headers)?;
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query(
        "SELECT id, name, os FROM desktop_pairing_requests WHERE code = $1 AND used_at IS NULL AND expires_at > NOW() FOR UPDATE",
    )
    .bind(code.trim())
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::BadRequest("pairing request is invalid or expired".to_string()))?;
    let request_id: Uuid = row.get("id");
    let name: String = row.get("name");
    let os: String = row.get("os");
    let device_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO desktop_devices (user_id, name, os, online, last_seen_at) VALUES ($1, $2, $3, FALSE, NOW()) RETURNING id",
    )
    .bind(user_id)
    .bind(name.trim())
    .bind(os.trim())
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("UPDATE desktop_pairing_requests SET approved_user_id = $1, device_id = $2, used_at = NOW() WHERE id = $3")
        .bind(user_id)
        .bind(device_id)
        .bind(request_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(PairDesktopResponse {
        device_id,
        access_token: token_for(&state, user_id, Duration::days(180))?,
    }))
}

pub async fn get_desktop_pairing_request_status(
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
) -> Result<Json<DesktopPairingStatusResponse>, ApiError> {
    let row = sqlx::query(
        r#"
        SELECT
          request.expires_at,
          request.approved_user_id,
          request.device_id
        FROM desktop_pairing_requests request
        WHERE request.code = $1
        "#,
    )
    .bind(code.trim())
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::BadRequest("pairing request was not found".to_string()))?;

    let expires_at: chrono::DateTime<Utc> = row.get("expires_at");
    let approved_user_id: Option<Uuid> = row.get("approved_user_id");
    let device_id: Option<Uuid> = row.get("device_id");
    if Utc::now() >= expires_at && approved_user_id.is_none() {
        return Ok(Json(DesktopPairingStatusResponse {
            status: "expired".to_string(),
            expires_at,
            device_id: None,
            access_token: None,
        }));
    }

    let access_token = match approved_user_id {
        Some(user_id) => Some(token_for(&state, user_id, Duration::days(180))?),
        None => None,
    };
    Ok(Json(DesktopPairingStatusResponse {
        status: if approved_user_id.is_some() {
            "approved".to_string()
        } else {
            "pending".to_string()
        },
        expires_at,
        device_id,
        access_token,
    }))
}
