ALTER TABLE users
  ADD COLUMN risk_confirmation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN output_buffer_lines INTEGER NOT NULL DEFAULT 10000,
  ADD COLUMN auto_reconnect_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE activity_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES desktop_devices(id) ON DELETE CASCADE,
  session_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  risky BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activity_logs_user_id_created_at ON activity_logs(user_id, created_at DESC);
CREATE INDEX idx_activity_logs_device_id_created_at ON activity_logs(device_id, created_at DESC);
