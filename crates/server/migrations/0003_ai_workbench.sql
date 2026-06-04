CREATE TABLE ai_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  built_in BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ai_providers (id, name, command, built_in, enabled) VALUES
  ('codex', 'Codex', 'codex', TRUE, TRUE),
  ('claude', 'Claude Code', 'claude', TRUE, TRUE),
  ('opencode', 'OpenCode', 'opencode', TRUE, TRUE),
  ('deepseek', 'DeepSeek TUI', 'deepseek', TRUE, TRUE)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE desktop_provider_status (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id UUID NOT NULL REFERENCES desktop_devices(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  installed BOOLEAN NOT NULL DEFAULT FALSE,
  version TEXT,
  auth_status TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(device_id, provider_id)
);

CREATE TABLE workspace_projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id UUID NOT NULL REFERENCES desktop_devices(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  git_branch TEXT,
  git_dirty BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(device_id, path)
);

CREATE TABLE ai_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES desktop_devices(id) ON DELETE CASCADE,
  project_id UUID REFERENCES workspace_projects(id) ON DELETE SET NULL,
  provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE RESTRICT,
  terminal_session_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  summary TEXT,
  archived_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_desktop_provider_status_device_id ON desktop_provider_status(device_id);
CREATE INDEX idx_workspace_projects_device_id ON workspace_projects(device_id);
CREATE INDEX idx_ai_sessions_device_id_updated_at ON ai_sessions(device_id, updated_at DESC);
CREATE INDEX idx_ai_sessions_user_id_updated_at ON ai_sessions(user_id, updated_at DESC);
