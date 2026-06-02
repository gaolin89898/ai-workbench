use axum::{http::StatusCode, response::IntoResponse, Json};

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
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
