CREATE TABLE IF NOT EXISTS app_releases (
  platform TEXT PRIMARY KEY CHECK (platform IN ('desktop', 'mobile')),
  latest_version TEXT NOT NULL DEFAULT '',
  min_supported_version TEXT,
  download_url TEXT,
  release_url TEXT,
  release_notes TEXT,
  force BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'github')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
