-- OAuth 登录支持：放宽 users.password_hash 约束（OAuth 用户没有密码），
-- 新增 user_oauth_identities 表存储第三方账号与本地用户的绑定关系。
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE IF NOT EXISTS user_oauth_identities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_user_oauth_identities_provider_external
  ON user_oauth_identities(provider, external_id);
CREATE INDEX IF NOT EXISTS idx_user_oauth_identities_user_id
  ON user_oauth_identities(user_id);
