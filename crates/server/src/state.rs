use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use remote_term_shared::RealtimeMessage;
use sqlx::PgPool;
use std::collections::HashMap;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

pub struct AppState {
    pub pool: PgPool,
    pub jwt_secret: String,
    pub mobiles: RwLock<HashMap<Uuid, HashMap<Uuid, MobileConnection>>>,
    pub desktops: RwLock<HashMap<Uuid, DesktopConnection>>,
}

pub struct MobileConnection {
    pub tx: mpsc::UnboundedSender<RealtimeMessage>,
}

#[derive(Clone)]
pub struct DesktopConnection {
    pub user_id: Uuid,
    pub tx: mpsc::UnboundedSender<RealtimeMessage>,
}

impl AppState {
    pub fn new(pool: PgPool, jwt_secret: String) -> Self {
        Self {
            pool,
            jwt_secret,
            mobiles: RwLock::new(HashMap::new()),
            desktops: RwLock::new(HashMap::new()),
        }
    }

    pub fn hash_password(&self, password: &str) -> anyhow::Result<String> {
        let salt = SaltString::generate(&mut OsRng);
        Ok(Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map_err(|err| anyhow::anyhow!("failed to hash password: {err}"))?
            .to_string())
    }

    pub fn verify_password(&self, password: &str, hash: &str) -> anyhow::Result<bool> {
        let parsed = PasswordHash::new(hash)
            .map_err(|err| anyhow::anyhow!("invalid password hash: {err}"))?;
        Ok(Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok())
    }

    pub async fn remove_mobile(&self, user_id: Uuid, connection_id: Uuid) {
        let mut mobiles = self.mobiles.write().await;
        if let Some(user_mobiles) = mobiles.get_mut(&user_id) {
            user_mobiles.remove(&connection_id);
            if user_mobiles.is_empty() {
                mobiles.remove(&user_id);
            }
        }
    }

    pub async fn mobile_viewer_count(&self, user_id: Uuid) -> usize {
        self.mobiles
            .read()
            .await
            .get(&user_id)
            .map(|connections| connections.len())
            .unwrap_or_default()
    }
}
