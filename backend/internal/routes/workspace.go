// Ported from crates/server/src/routes/workspace.rs.
//
// Implements AI provider listing, workspace project CRUD, and AI session
// CRUD. The create_ai_session handler also forwards an ai.session.create
// realtime message to the desktop over its WebSocket (mirroring
// ws::dispatch::forward_to_desktop); if the desktop is offline it logs an
// activity entry instead.
package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/gaolin89898/ai-workbench/backend/internal/auth"
	"github.com/gaolin89898/ai-workbench/backend/internal/db"
	"github.com/gaolin89898/ai-workbench/backend/internal/models"
	"github.com/gaolin89898/ai-workbench/backend/internal/protocol"
)

// aiProviderResponse mirrors the shared AiProviderDefinition.
type aiProviderResponse struct {
	Id       string `json:"id"`
	Name     string `json:"name"`
	Command  string `json:"command"`
	BuiltIn  bool   `json:"builtIn"`
	Enabled  bool   `json:"enabled"`
}

// workspaceProjectResponse mirrors the shared WorkspaceProject.
type workspaceProjectResponse struct {
	Id        string    `json:"id"`
	DeviceId  string    `json:"deviceId"`
	Name      string    `json:"name"`
	Path      string    `json:"path"`
	GitBranch *string   `json:"gitBranch"`
	GitDirty  bool      `json:"gitDirty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type createProjectRequest struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// aiSessionResponse mirrors the shared AiSession.
type aiSessionResponse struct {
	Id                string     `json:"id"`
	UserId            string     `json:"userId"`
	DeviceId          string     `json:"deviceId"`
	ProjectId         *string    `json:"projectId"`
	ProviderId        string     `json:"providerId"`
	TerminalSessionId *string    `json:"terminalSessionId"`
	ProviderSessionId *string    `json:"providerSessionId"`
	Title             string     `json:"title"`
	Status            string     `json:"status"`
	Summary           *string    `json:"summary"`
	ArchivedAt        *time.Time `json:"archivedAt"`
	UpdatedAt         time.Time  `json:"updatedAt"`
}

// createAiSessionRequest mirrors Rust CreateAiSessionRequest (camelCase).
type createAiSessionRequest struct {
	ProviderId        string  `json:"providerId"`
	ProjectId         *string `json:"projectId"`
	ProjectPath       *string `json:"projectPath"`
	Title             string  `json:"title"`
	CreationMode      string  `json:"creationMode"`
	TerminalSessionId *string `json:"terminalSessionId"`
}

// listProviders mirrors workspace::list_providers. Returns all enabled
// AI providers, built-in first then by name. Auth is required (validated by
// the middleware) but the user id itself is unused.
func (h *Handler) listProviders(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	rows, err := h.DB.Pool.Query(r.Context(),
		"SELECT id, name, command, built_in, enabled FROM ai_providers WHERE enabled = TRUE ORDER BY built_in DESC, name",
	)
	if err != nil {
		writeInternal(w)
		return
	}
	defer rows.Close()

	var providers []aiProviderResponse
	for rows.Next() {
		var p aiProviderResponse
		if err := rows.Scan(&p.Id, &p.Name, &p.Command, &p.BuiltIn, &p.Enabled); err != nil {
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
		providers = []aiProviderResponse{}
	}
	writeJSON(w, http.StatusOK, providers)
}

// listProjects mirrors workspace::list_projects. Returns workspace projects
// for the device, newest first.
func (h *Handler) listProjects(w http.ResponseWriter, r *http.Request) {
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
		"SELECT id, device_id, name, path, git_branch, git_dirty, updated_at FROM workspace_projects WHERE device_id = $1 ORDER BY updated_at DESC",
		deviceID,
	)
	if err != nil {
		writeInternal(w)
		return
	}
	defer rows.Close()

	var projects []workspaceProjectResponse
	for rows.Next() {
		var p workspaceProjectResponse
		if err := rows.Scan(&p.Id, &p.DeviceId, &p.Name, &p.Path, &p.GitBranch, &p.GitDirty, &p.UpdatedAt); err != nil {
			writeInternal(w)
			return
		}
		projects = append(projects, p)
	}
	if err := rows.Err(); err != nil {
		writeInternal(w)
		return
	}
	if projects == nil {
		projects = []workspaceProjectResponse{}
	}
	writeJSON(w, http.StatusOK, projects)
}

// createProject mirrors workspace::create_project. Upserts by (device_id,
// path) — on conflict it updates the name and refreshed updated_at.
func (h *Handler) createProject(w http.ResponseWriter, r *http.Request) {
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

	var req createProjectRequest
	if err := decodeJSON(r, &req); err != nil {
		writeBadRequest(w, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	path := strings.TrimSpace(req.Path)
	if name == "" || path == "" {
		writeBadRequest(w, "project name and path are required")
		return
	}

	var p workspaceProjectResponse
	err := h.DB.Pool.QueryRow(r.Context(),
		`INSERT INTO workspace_projects (device_id, name, path, updated_at)
		 VALUES ($1, $2, $3, NOW())
		 ON CONFLICT (device_id, path)
		 DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
		 RETURNING id, device_id, name, path, git_branch, git_dirty, updated_at`,
		deviceID, name, path,
	).Scan(&p.Id, &p.DeviceId, &p.Name, &p.Path, &p.GitBranch, &p.GitDirty, &p.UpdatedAt)
	if err != nil {
		writeInternal(w)
		return
	}

	// Forward project.created to the desktop so it can register the project
	// locally without waiting for the next 10s snapshot.
	h.forwardToDesktop(r.Context(), userID, deviceID, protocol.ProjectCreated{
		BaseMessage: protocol.BaseMessage{Type: "project.created"},
		DeviceId:    deviceID,
		Project: protocol.WorkspaceProject{
			Id:        p.Id,
			DeviceId:  p.DeviceId,
			Name:      p.Name,
			Path:      p.Path,
			GitBranch: p.GitBranch,
			GitDirty:  p.GitDirty,
			UpdatedAt: p.UpdatedAt,
		},
	})

	writeJSON(w, http.StatusOK, p)
}

// listAiSessions mirrors workspace::list_ai_sessions. Returns AI sessions for
// the device + user, newest first.
func (h *Handler) listAiSessions(w http.ResponseWriter, r *http.Request) {
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
		`SELECT id, user_id, device_id, project_id, provider_id, terminal_session_id, provider_session_id, title, status, summary, archived_at, updated_at
		 FROM ai_sessions
		 WHERE device_id = $1 AND user_id = $2
		 ORDER BY updated_at DESC`,
		deviceID, userID,
	)
	if err != nil {
		writeInternal(w)
		return
	}
	defer rows.Close()

	var sessions []aiSessionResponse
	for rows.Next() {
		s, err := scanAiSession(rows)
		if err != nil {
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
		sessions = []aiSessionResponse{}
	}
	writeJSON(w, http.StatusOK, sessions)
}

// createAiSession mirrors workspace::create_ai_session. Validates the
// request, optionally checks project ownership, inserts the session with
// status 'idle', then forwards an ai.session.create realtime message to the
// desktop (or logs an error if the desktop is offline).
func (h *Handler) createAiSession(w http.ResponseWriter, r *http.Request) {
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

	var req createAiSessionRequest
	if err := decodeJSON(r, &req); err != nil {
		writeBadRequest(w, "invalid request body")
		return
	}
	if strings.TrimSpace(req.ProviderId) == "" || strings.TrimSpace(req.Title) == "" {
		writeBadRequest(w, "providerId and title are required")
		return
	}

	// If a project_id is supplied, verify it belongs to this device.
	if req.ProjectId != nil && *req.ProjectId != "" {
		if err := h.DB.EnsureProjectOwner(r.Context(), deviceID, *req.ProjectId); err != nil {
			if errors.Is(err, db.ErrForbidden) {
				writeForbidden(w)
				return
			}
			writeInternal(w)
			return
		}
	}

	// NOTE: the Rust code binds req.project_path into the `summary` column
	// (parameter $7). This is preserved verbatim for contract compatibility.
	session, err := scanAiSession(h.DB.Pool.QueryRow(r.Context(),
		`INSERT INTO ai_sessions (user_id, device_id, project_id, provider_id, terminal_session_id, provider_session_id, title, status, summary, archived_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, NULL, $6, 'idle', $7, NULL, NOW())
		 RETURNING id, user_id, device_id, project_id, provider_id, terminal_session_id, provider_session_id, title, status, summary, archived_at, updated_at`,
		userID, deviceID, req.ProjectId, strings.TrimSpace(req.ProviderId),
		req.TerminalSessionId, strings.TrimSpace(req.Title), req.ProjectPath,
	))
	if err != nil {
		writeInternal(w)
		return
	}

	// Forward ai.session.create to the desktop, mirroring
	// ws::dispatch::forward_to_desktop. Uses the original (untrimmed) request
	// values, matching the Rust implementation.
	h.forwardToDesktop(r.Context(), userID, deviceID, protocol.AiSessionCreate{
		BaseMessage:       protocol.BaseMessage{Type: "ai.session.create"},
		DeviceId:          deviceID,
		RequestId:         uuid.NewString(),
		AiSessionId:       session.Id,
		ProviderId:        req.ProviderId,
		ProjectId:         req.ProjectId,
		ProjectPath:       req.ProjectPath,
		Title:             req.Title,
		CreationMode:      req.CreationMode,
		TerminalSessionId: req.TerminalSessionId,
	})

	writeJSON(w, http.StatusOK, session)
}

// getAiSession mirrors workspace::get_ai_session. Returns the session if it
// belongs to the authenticated user; otherwise 403.
func (h *Handler) getAiSession(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	sessionID := r.PathValue("sessionId")

	session, err := scanAiSession(h.DB.Pool.QueryRow(r.Context(),
		`SELECT id, user_id, device_id, project_id, provider_id, terminal_session_id, provider_session_id, title, status, summary, archived_at, updated_at
		 FROM ai_sessions
		 WHERE id = $1 AND user_id = $2`,
		sessionID, userID,
	))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeForbidden(w)
			return
		}
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusOK, session)
}

// forwardToDesktop mirrors ws::dispatch::forward_to_desktop. If the desktop
// is connected and owned by userID, the message is sent over its WebSocket.
// Otherwise an activity-log entry records that the desktop was offline.
func (h *Handler) forwardToDesktop(ctx context.Context, userID, deviceID string, msg protocol.Message) {
	deviceUUID, err := uuid.Parse(deviceID)
	if err != nil {
		return
	}
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return
	}

	if desktop := h.State.GetDesktop(deviceUUID); desktop != nil && desktop.UserID == userUUID {
		if data, err := protocol.MarshalMessage(msg); err == nil {
			_ = desktop.Send(data)
		}
		return
	}

	// Desktop offline or user mismatch: best-effort activity log.
	_ = h.DB.InsertActivityLog(ctx, models.ActivityLogInsert{
		UserId:   userID,
		DeviceId: &deviceID,
		Kind:     "error",
		Title:    "桌面端离线",
		Body:     "目标桌面没有在线 WebSocket 连接，消息未转发。",
	})
}

// scanAiSession scans a 12-column AI session row into aiSessionResponse.
// Works with both pgx.Row (QueryRow) and pgx.Rows (Query iteration).
func scanAiSession(row interface{ Scan(dest ...any) error }) (aiSessionResponse, error) {
	var s aiSessionResponse
	err := row.Scan(
		&s.Id, &s.UserId, &s.DeviceId, &s.ProjectId, &s.ProviderId,
		&s.TerminalSessionId, &s.ProviderSessionId, &s.Title, &s.Status,
		&s.Summary, &s.ArchivedAt, &s.UpdatedAt,
	)
	return s, err
}

// decodeJSON is a small wrapper around json.NewDecoder for request bodies.
func decodeJSON(r *http.Request, v any) error {
	return json.NewDecoder(r.Body).Decode(v)
}
