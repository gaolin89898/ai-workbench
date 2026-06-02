mod auth;
mod db;
mod error;
mod models;
mod routes;
mod state;
mod ws;

use anyhow::Context;
use sqlx::PgPool;
use std::{net::SocketAddr, sync::Arc};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::info;

use crate::state::AppState;

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
    let app = routes::router(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = bind.parse()?;
    info!("relay server listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
