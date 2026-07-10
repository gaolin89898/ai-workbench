// Mobile-side WebSocket message handling. Ports crates/server/src/ws/mobile.rs.
//
// DB side effects mirror the Rust source exactly:
//   - AiMessageSend: ensure_ai_session_owner + risk.AssessCommandRisk; if risky
//     and not confirmed the message is silently dropped (no response, no
//     forwarding — matches Rust, which simply `return`s). Otherwise an
//     activity_log entry is inserted (kind "risk"/"command") and the message
//     is forwarded to the desktop via forwardToDesktop.
//   - AiHistoryRequest: ensure_ai_session_owner + forwardToDesktop.
//   - AiSessionArchive: ensure_ai_session_owner + insert_activity_log
//     (kind "settings") + forwardToDesktop.
//
// Note: the Rust mobile handler writes to activity_logs (via
// insert_activity_log), NOT to command_audit_logs. The Go port does the same
// (db.InsertActivityLog); there is no InsertCommandAuditLog call because the
// Rust source does not write that table here.
//
// AiSessionCreate and any other mobile-originated variant not listed above are
// ignored (Rust `_ => {}`).
package ws

import (
	"context"
	"fmt"
	"log"

	"github.com/google/uuid"

	"github.com/gaolin89898/ai-workbench/backend/internal/models"
	"github.com/gaolin89898/ai-workbench/backend/internal/protocol"
	"github.com/gaolin89898/ai-workbench/backend/internal/risk"
)

// handleMobileMessage dispatches an inbound mobile message. Mirrors
// handle_mobile_message in mobile.rs.
func (h *Handler) handleMobileMessage(msg protocol.Message, userID, deviceID uuid.UUID) {
	switch m := msg.(type) {
	case protocol.AiMessageSend:
		h.handleAiMessageSend(userID, m)
	case protocol.AiMessageStop:
		h.handleAiMessageStop(userID, m)
	case protocol.AiApprovalRespond:
		h.handleAiApprovalRespond(userID, m)
	case protocol.AiRunSettingsUpdate:
		h.handleAiRunSettingsUpdate(userID, m)
	case protocol.AiHistoryRequest:
		h.handleAiHistoryRequest(userID, m)
	case protocol.AiSessionArchive:
		h.handleAiSessionArchive(userID, m)
	default:
		// Unknown/unhandled mobile message: ignore (matches Rust `_ => {}`).
	}
}

// handleAiMessageSend mirrors handle_ai_message_send in mobile.rs: verify
// session ownership, assess risk, log the command, and forward to desktop.
// When the content is risky and the user has not confirmed, the message is
// silently dropped (no AiMessageDone failure response, no forwarding) — this
// matches the Rust source, which simply returns without sending anything.
func (h *Handler) handleAiMessageSend(userID uuid.UUID, m protocol.AiMessageSend) {
	ctx := context.Background()
	if err := h.DB.EnsureAiSessionOwner(ctx, userID.String(), m.AiSessionId, m.DeviceId); err != nil {
		return
	}
	r := risk.AssessCommandRisk(m.Content)
	if r.Risky && !m.ConfirmedRisk {
		return
	}
	body := fmt.Sprintf("AI 会话 %s：%s", m.AiSessionId, truncate(m.Content, 160))
	kind := "command"
	title := "AI 消息已发送"
	if r.Risky {
		kind = "risk"
		title = "高危 AI 消息已确认"
	}
	devID := m.DeviceId
	if err := h.DB.InsertActivityLog(ctx, models.ActivityLogInsert{
		UserId:   userID.String(),
		DeviceId: &devID,
		Kind:     kind,
		Title:    title,
		Body:     body,
		Risky:    r.Risky,
	}); err != nil {
		log.Printf("ws: failed to insert ai message activity log: %v", err)
	}
	h.forwardToDesktop(userID, m.DeviceId, m)
}

func (h *Handler) handleAiMessageStop(userID uuid.UUID, m protocol.AiMessageStop) {
	ctx := context.Background()
	if err := h.DB.EnsureAiSessionOwner(ctx, userID.String(), m.AiSessionId, m.DeviceId); err != nil {
		return
	}
	h.forwardToDesktop(userID, m.DeviceId, m)
}

func (h *Handler) handleAiApprovalRespond(userID uuid.UUID, m protocol.AiApprovalRespond) {
	ctx := context.Background()
	if err := h.DB.EnsureAiSessionOwner(ctx, userID.String(), m.AiSessionId, m.DeviceId); err != nil {
		return
	}
	if m.Decision != "approved" && m.Decision != "denied" {
		return
	}
	h.forwardToDesktop(userID, m.DeviceId, m)
}

func (h *Handler) handleAiRunSettingsUpdate(userID uuid.UUID, m protocol.AiRunSettingsUpdate) {
	if m.DeviceId == "" {
		return
	}
	if m.ProviderId != "codex" && m.ProviderId != "claude" {
		return
	}
	ctx := context.Background()
	if err := h.DB.EnsureDeviceOwner(ctx, userID.String(), m.DeviceId); err != nil {
		return
	}
	h.forwardToDesktop(userID, m.DeviceId, m)
}

// handleAiHistoryRequest mirrors handle_ai_history_request in mobile.rs.
func (h *Handler) handleAiHistoryRequest(userID uuid.UUID, m protocol.AiHistoryRequest) {
	ctx := context.Background()
	if err := h.DB.EnsureAiSessionOwner(ctx, userID.String(), m.AiSessionId, m.DeviceId); err != nil {
		return
	}
	h.forwardToDesktop(userID, m.DeviceId, m)
}

// handleAiSessionArchive mirrors handle_ai_session_archive in mobile.rs.
func (h *Handler) handleAiSessionArchive(userID uuid.UUID, m protocol.AiSessionArchive) {
	ctx := context.Background()
	if err := h.DB.EnsureAiSessionOwner(ctx, userID.String(), m.AiSessionId, m.DeviceId); err != nil {
		return
	}
	title := "AI 会话已请求恢复"
	if m.Archived {
		title = "AI 会话已请求归档"
	}
	devID := m.DeviceId
	if err := h.DB.InsertActivityLog(ctx, models.ActivityLogInsert{
		UserId:   userID.String(),
		DeviceId: &devID,
		Kind:     "settings",
		Title:    title,
		Body:     "移动端请求桌面端更新本地 AI 会话归档状态。",
		Risky:    false,
	}); err != nil {
		log.Printf("ws: failed to insert archive activity log: %v", err)
	}
	h.forwardToDesktop(userID, m.DeviceId, m)
}

// truncate returns the first n runes of s, mirroring Rust's
// content.chars().take(n).collect::<String>().
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}
