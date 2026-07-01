CREATE TABLE IF NOT EXISTS managed_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  account TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  role TEXT NOT NULL,
  department TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_login TEXT NOT NULL DEFAULT '未登录',
  remark TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner_user_id, account),
  CONSTRAINT managed_users_status_check CHECK (status IN ('active', 'pending', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_managed_users_owner_updated_at
  ON managed_users(owner_user_id, updated_at DESC);
