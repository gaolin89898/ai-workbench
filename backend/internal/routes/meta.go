// Ported from crates/server/src/routes/meta.rs.
//
// Implements health check, activity log listing, and user settings
// get/update. Each handler mirrors the Rust logic: same SQL, same JSON
// shapes (camelCase), same status codes and error messages.
package routes

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gaolin89898/ai-workbench/backend/internal/auth"
	"github.com/gaolin89898/ai-workbench/backend/internal/db"
	"github.com/gaolin89898/ai-workbench/backend/internal/models"
)

// activityLogResponse mirrors the Rust ActivityLogResponse DTO
// (serde rename_all = "camelCase").
type activityLogResponse struct {
	Id        string    `json:"id"`
	DeviceId  *string   `json:"deviceId"`
	SessionId *string   `json:"sessionId"`
	Kind      string    `json:"kind"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	Risky     bool      `json:"risky"`
	CreatedAt time.Time `json:"createdAt"`
}

// health mirrors meta::health. Returns a simple status payload.
func (h *Handler) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// listActivityLogs mirrors meta::list_activity_logs. Reads the user id from
// the context (set by AuthMiddleware), optionally filters by device_id and
// kind, clamps the limit to [1, 200], and returns the most recent logs.
func (h *Handler) listActivityLogs(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	// Optional query parameters. A nil interface{} is sent as SQL NULL so the
	// "$N::UUID IS NULL" / "$N::TEXT IS NULL" filter short-circuits to TRUE.
	var deviceID any
	if d := r.URL.Query().Get("deviceId"); d != "" {
		deviceID = d
		if err := h.DB.EnsureDeviceOwner(r.Context(), userID, d); err != nil {
			if errors.Is(err, db.ErrForbidden) {
				writeForbidden(w)
				return
			}
			writeInternal(w)
			return
		}
	}
	var kind any
	if k := r.URL.Query().Get("kind"); k != "" {
		kind = k
	}

	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil {
			limit = parsed
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}

	rows, err := h.DB.Pool.Query(r.Context(),
		`SELECT id, device_id, session_id, kind, title, body, risky, created_at
		 FROM activity_logs
		 WHERE user_id = $1
		   AND ($2::UUID IS NULL OR device_id = $2)
		   AND ($3::TEXT IS NULL OR kind = $3)
		 ORDER BY created_at DESC
		 LIMIT $4`,
		userID, deviceID, kind, limit,
	)
	if err != nil {
		writeInternal(w)
		return
	}
	defer rows.Close()

	var logs []activityLogResponse
	for rows.Next() {
		var l activityLogResponse
		if err := rows.Scan(&l.Id, &l.DeviceId, &l.SessionId, &l.Kind, &l.Title, &l.Body, &l.Risky, &l.CreatedAt); err != nil {
			writeInternal(w)
			return
		}
		logs = append(logs, l)
	}
	if err := rows.Err(); err != nil {
		writeInternal(w)
		return
	}

	if logs == nil {
		logs = []activityLogResponse{}
	}
	writeJSON(w, http.StatusOK, logs)
}

// getSettings mirrors meta::get_settings. Delegates to db.LoadSettings which
// reads the four settings columns from the users table.
func (h *Handler) getSettings(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	settings, err := h.DB.LoadSettings(r.Context(), userID)
	if err != nil {
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

// updateSettings mirrors meta::update_settings. Clamps output_buffer_lines to
// [1000, 20000], writes the row back, and inserts a best-effort activity log
// entry recording the change.
func (h *Handler) updateSettings(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req models.UserSettingsResponse
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "invalid request body")
		return
	}

	outputBufferLines := req.OutputBufferLines
	if outputBufferLines < 1000 {
		outputBufferLines = 1000
	}
	if outputBufferLines > 20000 {
		outputBufferLines = 20000
	}

	row := h.DB.Pool.QueryRow(r.Context(),
		`UPDATE users
		 SET command_logging_enabled = $1,
		     risk_confirmation_enabled = $2,
		     output_buffer_lines = $3,
		     auto_reconnect_enabled = $4
		 WHERE id = $5
		 RETURNING command_logging_enabled, risk_confirmation_enabled, output_buffer_lines, auto_reconnect_enabled`,
		req.CommandLoggingEnabled, req.RiskConfirmationEnabled, outputBufferLines, req.AutoReconnectEnabled, userID,
	)
	settings, err := db.ScanUserSettings(row)
	if err != nil {
		writeInternal(w)
		return
	}

	// Best-effort activity log, matching the Rust insert_activity_log call
	// whose result is discarded.
	_ = h.DB.InsertActivityLog(r.Context(), models.ActivityLogInsert{
		UserId: userID,
		Kind:   "settings",
		Title:  "设置已更新",
		Body:   "移动端风险确认、自动重连、命令摘要或输出缓存设置已更新。",
	})

	writeJSON(w, http.StatusOK, settings)
}
