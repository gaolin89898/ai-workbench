DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'risk_confirmation_enabled') THEN
    ALTER TABLE users ADD COLUMN risk_confirmation_enabled BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'output_buffer_lines') THEN
    ALTER TABLE users ADD COLUMN output_buffer_lines INTEGER NOT NULL DEFAULT 10000;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'auto_reconnect_enabled') THEN
    ALTER TABLE users ADD COLUMN auto_reconnect_enabled BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS activity_logs (
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

CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id_created_at ON activity_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_device_id_created_at ON activity_logs(device_id, created_at DESC);
