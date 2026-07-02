ALTER TABLE desktop_devices
  ADD COLUMN IF NOT EXISTS machine_id TEXT;

CREATE INDEX IF NOT EXISTS idx_desktop_devices_user_machine
  ON desktop_devices(user_id, machine_id)
  WHERE machine_id IS NOT NULL;

ALTER TABLE desktop_pairing_requests
  ADD COLUMN IF NOT EXISTS machine_id TEXT;
