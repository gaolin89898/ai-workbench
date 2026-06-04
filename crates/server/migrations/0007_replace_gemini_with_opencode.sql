INSERT INTO ai_providers (id, name, command, built_in, enabled)
VALUES ('opencode', 'OpenCode', 'opencode', TRUE, TRUE)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  command = EXCLUDED.command,
  built_in = EXCLUDED.built_in,
  enabled = EXCLUDED.enabled;

UPDATE desktop_provider_status
SET provider_id = 'opencode'
WHERE provider_id = 'gemini'
  AND NOT EXISTS (
    SELECT 1
    FROM desktop_provider_status existing
    WHERE existing.device_id = desktop_provider_status.device_id
      AND existing.provider_id = 'opencode'
  );

UPDATE ai_sessions
SET provider_id = 'opencode'
WHERE provider_id = 'gemini';

DELETE FROM desktop_provider_status
WHERE provider_id = 'gemini';

DELETE FROM ai_providers
WHERE id = 'gemini';
