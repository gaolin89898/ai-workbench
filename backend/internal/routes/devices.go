// Ported from crates/server/src/routes/devices.rs.
//
// Implements device listing, device detail (with aggregated session counts),
// terminal session listing, and per-device provider status listing. Each
// handler reads the user id from the context (set by AuthMiddleware) and
// guards device-scoped routes with db.EnsureDeviceOwner, returning 403 on
// ownership violations — mirroring ensure_device_owner in the Rust code.
package routes

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/gaolin89898/ai-workbench/backend/internal/auth"
	"github.com/gaolin89898/ai-workbench/backend/internal/db"
)

// deviceResponse mirrors Rust DeviceResponse.
type deviceResponse struct {
	Id         string     `json:"id"`
	Name       string     `json:"name"`
	Os         string     `json:"os"`
	Online     bool       `json:"online"`
	LastSeenAt *time.Time `json:"lastSeenAt"`
}

// deviceDetailResponse mirrors Rust DeviceDetailResponse, including the
// aggregated session counts and live mobile viewer count.
type deviceDetailResponse struct {
	Id              string     `json:"id"`
	Name            string     `json:"name"`
	Os              string     `json:"os"`
	Online          bool       `json:"online"`
	LastSeenAt      *time.Time `json:"lastSeenAt"`
	SessionCount    int64      `json:"sessionCount"`
	TmuxCount       int64      `json:"tmuxCount"`
	ScreenCount     int64      `json:"screenCount"`
	ViewerCount     int        `json:"viewerCount"`
	LatestSessionAt *time.Time `json:"latestSessionAt"`
}

// terminalSessionResponse mirrors the shared TerminalSession struct
// (sessionId, name, backend, tool, status, cwd, recentOutput).
type terminalSessionResponse struct {
	SessionId    string  `json:"sessionId"`
	Name         string  `json:"name"`
	Backend      string  `json:"backend"`
	Tool         string  `json:"tool"`
	Status       string  `json:"status"`
	Cwd          *string `json:"cwd"`
	RecentOutput *string `json:"recentOutput"`
}

// desktopProviderStatusResponse mirrors the shared DesktopProviderStatus.
type desktopProviderStatusResponse struct {
	ProviderId    string    `json:"providerId"`
	Installed     bool      `json:"installed"`
	Version       *string   `json:"version"`
	AuthStatus    string    `json:"authStatus"`
	LastCheckedAt time.Time `json:"lastCheckedAt"`
}

// listDevices mirrors devices::list_devices. Returns all desktop devices
// owned by the authenticated user, newest first.
func (h *Handler) listDevices(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	rows, err := h.DB.Pool.Query(r.Context(),
		`WITH base AS (
		   SELECT
		     id,
		     name,
		     os,
		     online,
		     last_seen_at,
		     created_at,
		     NULLIF(BTRIM(machine_id), '') AS machine_key,
		     LOWER(BTRIM(name)) || E'\x1f' || LOWER(BTRIM(os)) AS display_key
		   FROM desktop_devices
		   WHERE user_id = $1
		 ),
		 known_machine_devices AS (
		   SELECT
		     id,
		     name,
		     os,
		     online,
		     last_seen_at,
		     created_at,
		     ROW_NUMBER() OVER (
		       PARTITION BY machine_key
		       ORDER BY online DESC, last_seen_at DESC NULLS LAST, created_at DESC
		     ) AS rn
		   FROM base
		   WHERE machine_key IS NOT NULL
		 ),
		 legacy_devices AS (
		   SELECT
		     id,
		     name,
		     os,
		     online,
		     last_seen_at,
		     created_at,
		     ROW_NUMBER() OVER (
		       PARTITION BY display_key
		       ORDER BY online DESC, last_seen_at DESC NULLS LAST, created_at DESC
		     ) AS rn
		   FROM base b
		   WHERE machine_key IS NULL
		     AND NOT EXISTS (
		       SELECT 1
		       FROM base known
		       WHERE known.machine_key IS NOT NULL
		         AND known.display_key = b.display_key
		     )
		 ),
		 visible_devices AS (
		   SELECT id, name, os, online, last_seen_at, created_at
		   FROM known_machine_devices
		   WHERE rn = 1
		   UNION ALL
		   SELECT id, name, os, online, last_seen_at, created_at
		   FROM legacy_devices
		   WHERE rn = 1
		 )
		 SELECT id, name, os, online, last_seen_at
		 FROM visible_devices
		 ORDER BY online DESC, last_seen_at DESC NULLS LAST, created_at DESC`,
		userID,
	)
	if err != nil {
		writeInternal(w)
		return
	}
	defer rows.Close()

	var devices []deviceResponse
	for rows.Next() {
		var d deviceResponse
		if err := rows.Scan(&d.Id, &d.Name, &d.Os, &d.Online, &d.LastSeenAt); err != nil {
			writeInternal(w)
			return
		}
		devices = append(devices, d)
	}
	if err := rows.Err(); err != nil {
		writeInternal(w)
		return
	}
	if devices == nil {
		devices = []deviceResponse{}
	}
	writeJSON(w, http.StatusOK, devices)
}

// getDeviceDetail mirrors devices::get_device_detail. Joins terminal_sessions
// to compute session_count, tmux_count, screen_count, and latest_session_at.
// viewer_count comes from the live mobile connection map in AppState. A
// missing row (device doesn't exist or isn't owned by the user) → 403.
func (h *Handler) getDeviceDetail(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	deviceID := r.PathValue("deviceId")

	var d deviceDetailResponse
	err := h.DB.Pool.QueryRow(r.Context(),
		`SELECT d.id, d.name, d.os, d.online, d.last_seen_at,
		        COUNT(s.id)::BIGINT AS session_count,
		        COUNT(s.id) FILTER (WHERE s.backend = 'tmux')::BIGINT AS tmux_count,
		        COUNT(s.id) FILTER (WHERE s.backend = 'screen')::BIGINT AS screen_count,
		        MAX(s.updated_at) AS latest_session_at
		 FROM desktop_devices d
		 LEFT JOIN terminal_sessions s ON s.device_id = d.id
		 WHERE d.id = $1 AND d.user_id = $2
		 GROUP BY d.id`,
		deviceID, userID,
	).Scan(&d.Id, &d.Name, &d.Os, &d.Online, &d.LastSeenAt,
		&d.SessionCount, &d.TmuxCount, &d.ScreenCount, &d.LatestSessionAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeForbidden(w)
			return
		}
		writeInternal(w)
		return
	}

	// viewer_count = number of live mobile WebSocket connections for this user.
	d.ViewerCount = h.mobileViewerCount(userID)

	writeJSON(w, http.StatusOK, d)
}

// listSessions mirrors devices::list_sessions. Returns terminal sessions for
// the device, ordered by name.
func (h *Handler) listSessions(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	deviceID := r.PathValue("deviceId")

	if err := h.DB.EnsureDeviceOwner(r.Context(), userID, deviceID); err != nil {
		if errors.Is(err, db.ErrForbidden) {
			writeForbidden(w)
			return
		}
		writeInternal(w)
		return
	}

	rows, err := h.DB.Pool.Query(r.Context(),
		"SELECT session_id, name, backend, tool, status, cwd, recent_output FROM terminal_sessions WHERE device_id = $1 ORDER BY name",
		deviceID,
	)
	if err != nil {
		writeInternal(w)
		return
	}
	defer rows.Close()

	var sessions []terminalSessionResponse
	for rows.Next() {
		var s terminalSessionResponse
		if err := rows.Scan(&s.SessionId, &s.Name, &s.Backend, &s.Tool, &s.Status, &s.Cwd, &s.RecentOutput); err != nil {
			writeInternal(w)
			return
		}
		sessions = append(sessions, s)
	}
	if err := rows.Err(); err != nil {
		writeInternal(w)
		return
	}
	if sessions == nil {
		sessions = []terminalSessionResponse{}
	}
	writeJSON(w, http.StatusOK, sessions)
}

// listDeviceProviders mirrors devices::list_device_providers. Returns the
// per-provider installation/auth status reported by the desktop, ordered by
// provider_id.
func (h *Handler) listDeviceProviders(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	deviceID := r.PathValue("deviceId")

	if err := h.DB.EnsureDeviceOwner(r.Context(), userID, deviceID); err != nil {
		if errors.Is(err, db.ErrForbidden) {
			writeForbidden(w)
			return
		}
		writeInternal(w)
		return
	}

	rows, err := h.DB.Pool.Query(r.Context(),
		"SELECT provider_id, installed, version, auth_status, last_checked_at FROM desktop_provider_status WHERE device_id = $1 ORDER BY provider_id",
		deviceID,
	)
	if err != nil {
		writeInternal(w)
		return
	}
	defer rows.Close()

	var providers []desktopProviderStatusResponse
	for rows.Next() {
		var p desktopProviderStatusResponse
		if err := rows.Scan(&p.ProviderId, &p.Installed, &p.Version, &p.AuthStatus, &p.LastCheckedAt); err != nil {
			writeInternal(w)
			return
		}
		providers = append(providers, p)
	}
	if err := rows.Err(); err != nil {
		writeInternal(w)
		return
	}
	if providers == nil {
		providers = []desktopProviderStatusResponse{}
	}
	writeJSON(w, http.StatusOK, providers)
}

// mobileViewerCount returns the number of live mobile connections for userID,
// mirroring AppState::mobile_viewer_count. Returns 0 if the userID isn't a
// valid UUID (defensive — should not happen for an authenticated user).
func (h *Handler) mobileViewerCount(userID string) int {
	uid, err := uuid.Parse(userID)
	if err != nil {
		return 0
	}
	return len(h.State.GetMobilesByUser(uid))
}
