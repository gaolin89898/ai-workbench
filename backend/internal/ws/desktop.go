// Desktop-side WebSocket message handling. Ports crates/server/src/ws/desktop.rs.
//
// DB side effects mirror the Rust source exactly:
//   - DesktopHeartbeat: ensure_device_owner + mark_device_online(true) +
//     insert_activity_log("桌面代理已连接") + notify_mobiles(heartbeat).
//   - ProvidersSnapshot: ensure_device_owner + upsert_provider_statuses +
//     notify_mobiles(message).
//   - ProjectsSnapshot: ensure_device_owner + upsert_projects +
//     notify_mobiles(message).
//   - AiSessionsSnapshot: ensure_device_owner + upsert_ai_sessions +
//     notify_mobiles(message).
//   - AiMessageDelta / AiMessageDone / AiHistoryResponse / AiChatOutput /
//     GitStatusSnapshot: pure forward to mobiles, no DB writes.
//
// The desktop is registered in AppState at upgrade time (see ws.go), so
// handleDesktopHeartbeat does not re-register — unlike Rust, which lazily
// registers on the first heartbeat. This is the one deliberate behavioral
// difference required by the Go state.Connection API (AddDesktop starts the
// write goroutine and must be called before any outbound send).
package ws

import (
	"context"
	"log"

	"github.com/google/uuid"

	"github.com/gaolin89898/ai-workbench/backend/internal/models"
	"github.com/gaolin89898/ai-workbench/backend/internal/protocol"
)

// handleDesktopMessage dispatches an inbound desktop message. It returns true
// when the message type was recognized (matching the Rust Option::Some return
// that sets connected_device_id), so readLoop can track whether disconnect
// cleanup should emit DB side effects.
func (h *Handler) handleDesktopMessage(msg protocol.Message, userID, deviceID uuid.UUID) bool {
	switch m := msg.(type) {
	case protocol.DesktopHeartbeat:
		h.handleDesktopHeartbeat(userID, m)
		return true
	case protocol.ProvidersSnapshot:
		h.handleProvidersSnapshot(userID, m)
		return true
	case protocol.ProjectsSnapshot:
		h.handleProjectsSnapshot(userID, m)
		return true
	case protocol.AiSessionsSnapshot:
		h.handleAiSessionsSnapshot(userID, m)
		return true
	case protocol.AiMessageDelta, protocol.AiMessageDone, protocol.AiHistoryResponse, protocol.AiChatOutput, protocol.GitStatusSnapshotMessage:
		// Pure forward to mobiles; no DB side effects.
		h.notifyMobiles(userID, msg)
		return true
	default:
		// Unknown/unhandled desktop message: ignore (matches Rust `_ => None`).
		return false
	}
}

// handleDesktopHeartbeat mirrors handle_heartbeat in desktop.rs: verify device
// ownership, mark the device online, log the connection, and notify mobiles
// with a fresh heartbeat. The Rust version inserts the desktop into
// state.desktops here; in the Go port the connection is already registered at
// upgrade time, so that step is skipped.
func (h *Handler) handleDesktopHeartbeat(userID uuid.UUID, m protocol.DesktopHeartbeat) {
	if m.DeviceId == "" {
		return
	}
	ctx := context.Background()
	if err := h.DB.EnsureDeviceOwner(ctx, userID.String(), m.DeviceId); err != nil {
		return
	}
	if err := h.DB.MarkDeviceOnline(ctx, m.DeviceId, true); err != nil {
		log.Printf("ws: failed to mark desktop online: %v", err)
	}
	devID := m.DeviceId
	if err := h.DB.InsertActivityLog(ctx, models.ActivityLogInsert{
		UserId:   userID.String(),
		DeviceId: &devID,
		Kind:     "connection",
		Title:    "桌面代理已连接",
		Body:     "桌面端 WebSocket 心跳已恢复，设备标记为在线。",
		Risky:    false,
	}); err != nil {
		log.Printf("ws: failed to insert desktop-online activity log: %v", err)
	}
	if devUUID, err := uuid.Parse(m.DeviceId); err == nil {
		h.notifyMobilesHeartbeat(userID, devUUID)
	}
}

// handleProvidersSnapshot mirrors handle_providers_snapshot in desktop.rs.
func (h *Handler) handleProvidersSnapshot(userID uuid.UUID, m protocol.ProvidersSnapshot) {
	if m.DeviceId == "" {
		return
	}
	ctx := context.Background()
	if err := h.DB.EnsureDeviceOwner(ctx, userID.String(), m.DeviceId); err != nil {
		return
	}
	if err := h.DB.UpsertProviderStatuses(ctx, m.DeviceId, toModelProviders(m.Providers)); err != nil {
		log.Printf("ws: failed to upsert provider statuses: %v", err)
	}
	h.notifyMobiles(userID, m)
}

// handleProjectsSnapshot mirrors handle_projects_snapshot in desktop.rs.
func (h *Handler) handleProjectsSnapshot(userID uuid.UUID, m protocol.ProjectsSnapshot) {
	if m.DeviceId == "" {
		return
	}
	ctx := context.Background()
	if err := h.DB.EnsureDeviceOwner(ctx, userID.String(), m.DeviceId); err != nil {
		return
	}
	if err := h.DB.UpsertProjects(ctx, m.DeviceId, toModelProjects(m.Projects)); err != nil {
		log.Printf("ws: failed to upsert projects: %v", err)
	}
	h.notifyMobiles(userID, m)
}

// handleAiSessionsSnapshot mirrors handle_ai_sessions_snapshot in desktop.rs.
// The Rust upsert_ai_sessions takes user_id and device_id; the Go port passes
// the same.
func (h *Handler) handleAiSessionsSnapshot(userID uuid.UUID, m protocol.AiSessionsSnapshot) {
	if m.DeviceId == "" {
		return
	}
	ctx := context.Background()
	if err := h.DB.EnsureDeviceOwner(ctx, userID.String(), m.DeviceId); err != nil {
		return
	}
	if err := h.DB.UpsertAiSessions(ctx, userID.String(), m.DeviceId, toModelAiSessions(m.Sessions)); err != nil {
		log.Printf("ws: failed to upsert ai sessions: %v", err)
	}
	h.notifyMobiles(userID, m)
}

// cleanupDesktop tears down a desktop connection: remove it from AppState,
// mark the device offline, log the disconnection, and notify mobiles with a
// fresh heartbeat. DB side effects only run if the connection was activated
// (at least one inbound message handled), mirroring the Rust
// connected_device_id guard in desktop_socket.
func (h *Handler) cleanupDesktop(userID, deviceID uuid.UUID, activated bool) {
	h.State.RemoveDesktop(deviceID)
	if !activated {
		return
	}
	ctx := context.Background()
	if err := h.DB.MarkDeviceOnline(ctx, deviceID.String(), false); err != nil {
		log.Printf("ws: failed to mark desktop offline: %v", err)
	}
	devID := deviceID.String()
	if err := h.DB.InsertActivityLog(ctx, models.ActivityLogInsert{
		UserId:   userID.String(),
		DeviceId: &devID,
		Kind:     "connection",
		Title:    "桌面代理已离线",
		Body:     "桌面端 WebSocket 已断开，设备标记为离线。",
		Risky:    false,
	}); err != nil {
		log.Printf("ws: failed to insert desktop-offline activity log: %v", err)
	}
	h.notifyMobilesHeartbeat(userID, deviceID)
}

// ---- protocol -> models converters ----
//
// protocol and models define parallel structs (protocol carries the wire
// layout, models the DB column layout). The db upsert helpers take []models.X,
// so inbound protocol payloads are converted here. Nullable pointer fields and
// time.Time fields are copied by value.

func toModelProviders(ps []protocol.DesktopProviderStatus) []models.DesktopProviderStatus {
	out := make([]models.DesktopProviderStatus, len(ps))
	for i, p := range ps {
		out[i] = models.DesktopProviderStatus{
			ProviderId:    p.ProviderId,
			Installed:     p.Installed,
			Version:       p.Version,
			AuthStatus:    string(p.AuthStatus),
			LastCheckedAt: p.LastCheckedAt,
		}
	}
	return out
}

func toModelProjects(ps []protocol.WorkspaceProject) []models.WorkspaceProject {
	out := make([]models.WorkspaceProject, len(ps))
	for i, p := range ps {
		out[i] = models.WorkspaceProject{
			Id:        p.Id,
			DeviceId:  p.DeviceId,
			Name:      p.Name,
			Path:      p.Path,
			GitBranch: p.GitBranch,
			GitDirty:  p.GitDirty,
			UpdatedAt: p.UpdatedAt,
		}
	}
	return out
}

func toModelAiSessions(ss []protocol.AiSession) []models.AiSession {
	out := make([]models.AiSession, len(ss))
	for i, s := range ss {
		out[i] = models.AiSession{
			Id:                s.Id,
			UserId:            s.UserId,
			DeviceId:          s.DeviceId,
			ProjectId:         s.ProjectId,
			ProviderId:        s.ProviderId,
			TerminalSessionId: s.TerminalSessionId,
			ProviderSessionId: s.ProviderSessionId,
			Title:             s.Title,
			Status:            string(s.Status),
			Summary:           s.Summary,
			ArchivedAt:        s.ArchivedAt,
			UpdatedAt:         s.UpdatedAt,
		}
	}
	return out
}
