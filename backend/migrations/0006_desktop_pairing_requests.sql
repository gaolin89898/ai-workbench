CREATE TABLE desktop_pairing_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  os TEXT NOT NULL,
  approved_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES desktop_devices(id) ON DELETE CASCADE,
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_desktop_pairing_requests_code ON desktop_pairing_requests(code);
CREATE INDEX idx_desktop_pairing_requests_expires_at ON desktop_pairing_requests(expires_at);
