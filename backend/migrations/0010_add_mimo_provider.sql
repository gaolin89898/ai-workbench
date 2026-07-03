INSERT INTO ai_providers (id, name, command, built_in, enabled)
VALUES ('mimo', 'MiMo Code', 'mimo', TRUE, TRUE)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  command = EXCLUDED.command,
  built_in = EXCLUDED.built_in,
  enabled = EXCLUDED.enabled;
