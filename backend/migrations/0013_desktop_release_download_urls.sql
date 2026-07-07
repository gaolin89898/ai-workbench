ALTER TABLE app_releases
  ADD COLUMN IF NOT EXISTS windows_download_url TEXT,
  ADD COLUMN IF NOT EXISTS linux_download_url TEXT;
