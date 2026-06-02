use axum::http::{header::AUTHORIZATION, HeaderMap};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::{distributions::Alphanumeric, Rng};
use uuid::Uuid;

use crate::error::ApiError;
use crate::models::{AuthResponse, Claims};
use crate::state::AppState;

pub fn validate_credentials(email: &str, password: &str) -> Result<(), ApiError> {
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

pub fn auth_response(state: &AppState, user_id: Uuid) -> Result<AuthResponse, ApiError> {
    Ok(AuthResponse {
        access_token: token_for(state, user_id, Duration::hours(12))?,
        refresh_token: token_for(state, user_id, Duration::days(30))?,
        user_id,
    })
}

pub fn token_for(state: &AppState, user_id: Uuid, ttl: Duration) -> Result<String, ApiError> {
    let exp = (Utc::now() + ttl).timestamp() as usize;
    Ok(encode(
        &Header::default(),
        &Claims { sub: user_id, exp },
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    )?)
}

pub fn authenticate_headers(state: &AppState, headers: &HeaderMap) -> Result<Uuid, ApiError> {
    let value = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    let token = value
        .strip_prefix("Bearer ")
        .ok_or(ApiError::Unauthorized)?;
    authenticate_token(state, token)
}

pub fn authenticate_token(state: &AppState, token: &str) -> Result<Uuid, ApiError> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(state.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| ApiError::Unauthorized)?;
    Ok(data.claims.sub)
}

pub fn random_pairing_code() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(8)
        .map(char::from)
        .collect::<String>()
        .to_ascii_uppercase()
}

pub fn is_unique_violation(err: &sqlx::Error) -> bool {
    err.as_database_error().and_then(|db| db.code()).as_deref() == Some("23505")
}
