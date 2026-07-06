// Ported from crates/server/src/db.rs.
//
// This package wraps a pgxpool connection pool and ports every public
// function from the Rust db.rs module. SQL statements are preserved verbatim
// (same INSERT ... ON CONFLICT upserts, same EXISTS ownership checks). Row
// scan helpers mirror the row_to_* functions and read exactly the column set
// the Rust versions read; nullable columns are scanned into pointers.
package db

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/gaolin89898/ai-workbench/backend/internal/models"
)

// ErrForbidden is returned by the Ensure*Owner helpers when the caller does
// not own the resource. It mirrors ApiError::Forbidden in error.rs; the
// routes layer can map it to HTTP 403.
var ErrForbidden = errors.New("forbidden")

// DB wraps a pgxpool connection pool.
type DB struct {
	Pool *pgxpool.Pool
}

// New creates a DB backed by a new pgxpool connected to databaseURL.
// The pool is explicitly configured with sane max conns / idle timeout so the
// server does not exhaust database connections under sustained load.
func New(ctx context.Context, databaseURL string) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 20
	cfg.MinConns = 2
	cfg.MaxConnIdleTime = 30 * time.Minute
	cfg.MaxConnLifetime = 2 * time.Hour
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &DB{Pool: pool}, nil
}

// Close releases the underlying pool's resources.
func (d *DB) Close() {
	d.Pool.Close()
}

// RunMigrations reads every .sql file in migrationsDir (sorted by name) and
// executes each one once. Older deployments did not track applied migrations,
// so the first run with this table may re-apply the current idempotent files
// and then record them; subsequent restarts skip them.
func (d *DB) RunMigrations(ctx context.Context, migrationsDir string) error {
	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)
	if _, err := d.Pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		name TEXT PRIMARY KEY,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`); err != nil {
		return fmt.Errorf("ensure schema_migrations: %w", err)
	}
	for _, name := range files {
		var applied bool
		if err := d.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name = $1)", name).Scan(&applied); err != nil {
			return fmt.Errorf("check migration %s: %w", name, err)
		}
		if applied {
			continue
		}
		content, err := os.ReadFile(filepath.Join(migrationsDir, name))
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		tx, err := d.Pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin migration %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, string(content)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("apply migration %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations (name) VALUES ($1)", name); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("record migration %s: %w", name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit migration %s: %w", name, err)
		}
	}
	return nil
}

// ---- Ownership guards (ensure_* in db.rs) ----

// EnsureDeviceOwner returns ErrForbidden if the device does not belong to the
// user.
func (d *DB) EnsureDeviceOwner(ctx context.Context, userID, deviceID string) error {
	var exists bool
	err := d.Pool.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM desktop_devices WHERE id = $1 AND user_id = $2)",
		deviceID, userID,
	).Scan(&exists)
	if err != nil {
		return err
	}
	if !exists {
		return ErrForbidden
	}
	return nil
}

// EnsureProjectOwner returns ErrForbidden if the project does not belong to
// the device.
func (d *DB) EnsureProjectOwner(ctx context.Context, deviceID, projectID string) error {
	var exists bool
	err := d.Pool.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM workspace_projects WHERE id = $1 AND device_id = $2)",
		projectID, deviceID,
	).Scan(&exists)
	if err != nil {
		return err
	}
	if !exists {
		return ErrForbidden
	}
	return nil
}

// EnsureAiSessionOwner returns ErrForbidden if the AI session does not belong
// to the user. The deviceID parameter is retained for API compatibility but
// no longer used in the query — a user owns all sessions across all their
// devices, and the desktop's local SQLite is the source of truth for history.
func (d *DB) EnsureAiSessionOwner(ctx context.Context, userID, aiSessionID, deviceID string) error {
	var exists bool
	err := d.Pool.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM ai_sessions WHERE id = $1 AND user_id = $2)",
		aiSessionID, userID,
	).Scan(&exists)
	if err != nil {
		return err
	}
	if !exists {
		return ErrForbidden
	}
	return nil
}

// ---- Device state ----

// MarkDeviceOnline flips the device's online flag and refreshes last_seen_at.
func (d *DB) MarkDeviceOnline(ctx context.Context, deviceID string, online bool) error {
	_, err := d.Pool.Exec(ctx,
		"UPDATE desktop_devices SET online = $1, last_seen_at = NOW() WHERE id = $2",
		online, deviceID,
	)
	return err
}

// ---- Upserts (each runs in a transaction, matching db.rs) ----

// UpsertProviderStatuses upserts the per-device provider status rows.
func (d *DB) UpsertProviderStatuses(ctx context.Context, deviceID string, providers []models.DesktopProviderStatus) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	const sql = `
            INSERT INTO desktop_provider_status (device_id, provider_id, installed, version, auth_status, last_checked_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (device_id, provider_id)
            DO UPDATE SET installed = EXCLUDED.installed, version = EXCLUDED.version, auth_status = EXCLUDED.auth_status, last_checked_at = EXCLUDED.last_checked_at`
	for _, p := range providers {
		if _, err := tx.Exec(ctx, sql,
			deviceID, p.ProviderId, p.Installed, p.Version, p.AuthStatus, p.LastCheckedAt,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// UpsertProjects upserts the device's workspace projects.
func (d *DB) UpsertProjects(ctx context.Context, deviceID string, projects []models.WorkspaceProject) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	const sql = `
            INSERT INTO workspace_projects (id, device_id, name, path, git_branch, git_dirty, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id)
            DO UPDATE SET device_id = EXCLUDED.device_id, name = EXCLUDED.name, path = EXCLUDED.path, git_branch = EXCLUDED.git_branch, git_dirty = EXCLUDED.git_dirty, updated_at = EXCLUDED.updated_at`
	for _, p := range projects {
		if _, err := tx.Exec(ctx, sql,
			p.Id, deviceID, p.Name, p.Path, p.GitBranch, p.GitDirty, p.UpdatedAt,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// UpsertAiSessions upserts the device's AI sessions.
func (d *DB) UpsertAiSessions(ctx context.Context, userID, deviceID string, sessions []models.AiSession) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	const sql = `
            INSERT INTO ai_sessions (id, user_id, device_id, project_id, provider_id, terminal_session_id, provider_session_id, title, status, summary, archived_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (id)
            DO UPDATE SET device_id = EXCLUDED.device_id, project_id = EXCLUDED.project_id, provider_id = EXCLUDED.provider_id, terminal_session_id = EXCLUDED.terminal_session_id, provider_session_id = EXCLUDED.provider_session_id, title = EXCLUDED.title, status = EXCLUDED.status, summary = EXCLUDED.summary, archived_at = EXCLUDED.archived_at, updated_at = EXCLUDED.updated_at`
	for _, s := range sessions {
		if _, err := tx.Exec(ctx, sql,
			s.Id, userID, deviceID, s.ProjectId, s.ProviderId,
			s.TerminalSessionId, s.ProviderSessionId, s.Title, s.Status,
			s.Summary, s.ArchivedAt, s.UpdatedAt,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// UpsertSessions upserts the device's terminal sessions.
func (d *DB) UpsertSessions(ctx context.Context, deviceID string, sessions []models.TerminalSession) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	const sql = `INSERT INTO terminal_sessions (device_id, session_id, name, backend, tool, status, cwd, recent_output, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             ON CONFLICT (device_id, session_id)
             DO UPDATE SET name = EXCLUDED.name, backend = EXCLUDED.backend, tool = EXCLUDED.tool, status = EXCLUDED.status, cwd = EXCLUDED.cwd, recent_output = EXCLUDED.recent_output, updated_at = NOW()`
	for _, s := range sessions {
		if _, err := tx.Exec(ctx, sql,
			deviceID, s.SessionId, s.Name, s.Backend, s.Tool, s.Status, s.Cwd, s.RecentOutput,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ---- Row scan helpers (row_to_* in db.rs) ----
//
// Each helper scans exactly the column set the Rust row_to_* functions read;
// callers must SELECT those columns in the same order. Nullable columns are
// scanned into pointers.

// rowScanner is satisfied by both pgx.Row (QueryRow) and pgx.Rows (Query).
type rowScanner interface {
	Scan(dest ...any) error
}

// ScanTerminalSession scans a row into a TerminalSession (row_to_session).
func ScanTerminalSession(row rowScanner) (models.TerminalSession, error) {
	var s models.TerminalSession
	err := row.Scan(
		&s.SessionId, &s.Name, &s.Backend, &s.Tool, &s.Status, &s.Cwd, &s.RecentOutput,
	)
	return s, err
}

// ScanAiProvider scans a row into an AiProvider (row_to_provider).
func ScanAiProvider(row rowScanner) (models.AiProvider, error) {
	var p models.AiProvider
	err := row.Scan(&p.Id, &p.Name, &p.Command, &p.BuiltIn, &p.Enabled)
	return p, err
}

// ScanDesktopProviderStatus scans a row into a DesktopProviderStatus
// (row_to_provider_status).
func ScanDesktopProviderStatus(row rowScanner) (models.DesktopProviderStatus, error) {
	var s models.DesktopProviderStatus
	err := row.Scan(&s.ProviderId, &s.Installed, &s.Version, &s.AuthStatus, &s.LastCheckedAt)
	return s, err
}

// ScanWorkspaceProject scans a row into a WorkspaceProject (row_to_project).
func ScanWorkspaceProject(row rowScanner) (models.WorkspaceProject, error) {
	var p models.WorkspaceProject
	err := row.Scan(&p.Id, &p.DeviceId, &p.Name, &p.Path, &p.GitBranch, &p.GitDirty, &p.UpdatedAt)
	return p, err
}

// ScanAiSession scans a row into an AiSession (row_to_ai_session).
func ScanAiSession(row rowScanner) (models.AiSession, error) {
	var s models.AiSession
	err := row.Scan(
		&s.Id, &s.UserId, &s.DeviceId, &s.ProjectId, &s.ProviderId,
		&s.TerminalSessionId, &s.ProviderSessionId, &s.Title, &s.Status,
		&s.Summary, &s.ArchivedAt, &s.UpdatedAt,
	)
	return s, err
}

// ScanUserSettings scans a row into a UserSettingsResponse (row_to_settings).
func ScanUserSettings(row rowScanner) (models.UserSettingsResponse, error) {
	var s models.UserSettingsResponse
	err := row.Scan(
		&s.CommandLoggingEnabled, &s.RiskConfirmationEnabled,
		&s.OutputBufferLines, &s.AutoReconnectEnabled,
	)
	return s, err
}

// ---- Activity logs ----

// InsertActivityLog inserts an activity log entry. Unlike the Rust version
// (which swallows and logs the error), this returns the error so callers can
// decide; the error is otherwise unused by callers and matches the same
// best-effort intent.
func (d *DB) InsertActivityLog(ctx context.Context, item models.ActivityLogInsert) error {
	_, err := d.Pool.Exec(ctx,
		"INSERT INTO activity_logs (user_id, device_id, session_id, kind, title, body, risky) VALUES ($1, $2, $3, $4, $5, $6, $7)",
		item.UserId, item.DeviceId, item.SessionId, item.Kind, item.Title, item.Body, item.Risky,
	)
	return err
}

// ---- Token Usage ----

// InsertTokenUsage 写入一条 token 用量记录。
func (d *DB) InsertTokenUsage(ctx context.Context, item models.TokenUsageInsert) error {
	_, err := d.Pool.Exec(ctx,
		"INSERT INTO token_usage (user_id, device_id, ai_session_id, provider_id, input_tokens, output_tokens, reasoning_tokens, total_tokens) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
		item.UserId, item.DeviceId, item.AiSessionId, item.ProviderId, item.InputTokens, item.OutputTokens, item.ReasoningTokens, item.TotalTokens,
	)
	return err
}

// SumTokenUsageByProvider 按 provider 聚合指定用户的 token 用量。
func (d *DB) SumTokenUsageByProvider(ctx context.Context, userID string) ([]models.TokenUsageSummary, error) {
	rows, err := d.Pool.Query(ctx,
		`SELECT provider_id,
		        COALESCE(SUM(input_tokens), 0),
		        COALESCE(SUM(output_tokens), 0),
		        COALESCE(SUM(reasoning_tokens), 0),
		        COALESCE(SUM(total_tokens), 0),
		        COUNT(*)
		 FROM token_usage
		 WHERE user_id = $1
		 GROUP BY provider_id
		 ORDER BY provider_id`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.TokenUsageSummary
	for rows.Next() {
		var s models.TokenUsageSummary
		if err := rows.Scan(&s.ProviderId, &s.InputTokens, &s.OutputTokens, &s.ReasoningTokens, &s.TotalTokens, &s.TurnCount); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ---- Settings ----

// LoadSettings loads a user's settings row (load_settings).
func (d *DB) LoadSettings(ctx context.Context, userID string) (models.UserSettingsResponse, error) {
	row := d.Pool.QueryRow(ctx,
		"SELECT command_logging_enabled, risk_confirmation_enabled, output_buffer_lines, auto_reconnect_enabled FROM users WHERE id = $1",
		userID,
	)
	return ScanUserSettings(row)
}

// DefaultSettings returns the default settings (default_settings).
func DefaultSettings() models.UserSettingsResponse {
	return models.UserSettingsResponse{
		CommandLoggingEnabled:   true,
		RiskConfirmationEnabled: true,
		OutputBufferLines:       10000,
		AutoReconnectEnabled:    true,
	}
}
