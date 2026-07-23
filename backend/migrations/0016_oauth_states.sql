-- GitHub OAuth 登录支持：oauth_states 表用于"后端中转+轮询"方案。
-- 客户端发起 OAuth 时后端生成 state 存入此表；GitHub 回调后端时把
-- 换得的 token / 用户信息写入 result 列；客户端轮询此表拿结果。
CREATE TABLE IF NOT EXISTS oauth_states (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  state TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending / done / error
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL              -- 整个流程最长存活 5 分钟
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON oauth_states(state);
