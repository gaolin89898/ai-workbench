// Package ws implements the WebSocket realtime transport for desktop and
// mobile clients. It ports crates/server/src/ws/{mod,dispatch,desktop,mobile}.rs:
// connections are authenticated via a JWT query parameter, upgraded to a
// WebSocket, registered in AppState, and drained by a read loop that
// dispatches each inbound message to the desktop/mobile handler. The write
// side is handled by state.Connection.writePump (started by AddMobile /
// AddDesktop), mirroring the Rust mpsc outgoing task.
package ws

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/gaolin89898/ai-workbench/backend/internal/auth"
	"github.com/gaolin89898/ai-workbench/backend/internal/db"
	"github.com/gaolin89898/ai-workbench/backend/internal/models"
	"github.com/gaolin89898/ai-workbench/backend/internal/protocol"
	"github.com/gaolin89898/ai-workbench/backend/internal/state"
)

// Handler is the WebSocket entrypoint shared by /ws/mobile and /ws/desktop.
type Handler struct {
	DB     *db.DB
	State  *state.AppState
	Secret string

	upgrader websocket.Upgrader
}

// NewHandler constructs a Handler. CheckOrigin accepts all origins, matching
// the Rust server's permissive CORS layer (production deployments should
// restrict this).
func NewHandler(d *db.DB, st *state.AppState, secret string) *Handler {
	return &Handler{
		DB:     d,
		State:  st,
		Secret: secret,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
}

// HandleMobileWS upgrades GET /ws/mobile to a WebSocket and runs the mobile
// read loop until the connection closes. Mirrors ws::ws_mobile in mod.rs.
func (h *Handler) HandleMobileWS(w http.ResponseWriter, r *http.Request) {
	userID, deviceID, ok := h.authQuery(r)
	if !ok {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	h.State.AddMobile(userID, deviceID, conn)
	h.readLoop(conn, userID, deviceID, false)
}

// HandleDesktopWS upgrades GET /ws/desktop to a WebSocket and runs the
// desktop read loop until the connection closes. Mirrors ws::ws_desktop.
func (h *Handler) HandleDesktopWS(w http.ResponseWriter, r *http.Request) {
	userID, deviceID, ok := h.authQuery(r)
	if !ok {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	h.State.AddDesktop(userID, deviceID, conn)
	h.readLoop(conn, userID, deviceID, true)
}

// authQuery extracts the userID and deviceID from the ?token= query parameter
// (mirroring the Rust WsQuery + authenticate_token flow). If the token carries
// no deviceId claim, a random UUID is generated so the connection can still be
// keyed in AppState — this mirrors the Rust mobile path, which keys mobiles by
// a fresh Uuid::new_v4 connection_id rather than a device id.
func (h *Handler) authQuery(r *http.Request) (uuid.UUID, uuid.UUID, bool) {
	token := r.URL.Query().Get("token")
	if token == "" {
		return uuid.Nil, uuid.Nil, false
	}
	claims, err := auth.ParseToken(token, h.Secret)
	if err != nil {
		return uuid.Nil, uuid.Nil, false
	}
	userID, err := uuid.Parse(claims.UserID)
	if err != nil {
		return uuid.Nil, uuid.Nil, false
	}
	var deviceID uuid.UUID
	if claims.DeviceID != "" {
		if d, err := uuid.Parse(claims.DeviceID); err == nil {
			deviceID = d
		}
	}
	if deviceID == uuid.Nil {
		deviceID = uuid.New()
	}
	return userID, deviceID, true
}

// readLoop drains inbound WebSocket frames and dispatches them. It returns
// when the connection closes (ReadMessage error), triggering cleanup via
// defer. For desktop connections, the disconnect DB side effects (mark
// offline, activity log, mobile heartbeat) only run if at least one inbound
// message was successfully handled — mirroring the Rust connected_device_id
// guard in desktop_socket.
func (h *Handler) readLoop(conn *websocket.Conn, userID, deviceID uuid.UUID, isDesktop bool) {
	activated := false
	defer func() {
		if isDesktop {
			h.cleanupDesktop(userID, deviceID, activated)
		} else {
			h.State.RemoveMobile(userID, deviceID)
		}
	}()
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		msg, err := protocol.ParseMessage(data)
		if err != nil {
			log.Printf("ws: invalid %s payload: %v", peerKind(isDesktop), err)
			continue
		}
		if isDesktop {
			if h.handleDesktopMessage(msg, userID, deviceID) {
				activated = true
			}
		} else {
			h.handleMobileMessage(msg, userID, deviceID)
		}
	}
}

func peerKind(isDesktop bool) string {
	if isDesktop {
		return "desktop"
	}
	return "mobile"
}

// notifyMobiles marshals msg and fans it out to every mobile connection owned
// by userID. Mirrors dispatch::notify_mobiles.
func (h *Handler) notifyMobiles(userID uuid.UUID, msg protocol.Message) {
	data, err := protocol.MarshalMessage(msg)
	if err != nil {
		return
	}
	h.State.SendToMobiles(userID, data)
}

// notifyMobilesHeartbeat sends a fresh DesktopHeartbeat to the user's mobiles
// so they can refresh device status. Mirrors dispatch::now_heartbeat +
// notify_mobiles.
func (h *Handler) notifyMobilesHeartbeat(userID, deviceID uuid.UUID) {
	hb := protocol.DesktopHeartbeat{
		BaseMessage: protocol.BaseMessage{Type: "desktop.heartbeat"},
		DeviceId:    deviceID.String(),
		Timestamp:   time.Now(),
	}
	h.notifyMobiles(userID, hb)
}

// forwardToDesktop sends msg to the desktop connection for deviceID. If the
// desktop is offline, an activity log entry is recorded. If the desktop
// exists but belongs to a different user, the message is silently dropped,
// matching dispatch::forward_to_desktop exactly.
//
// 查找策略：先按 deviceID 精确查找；找不到则按 userID 找第一个在线桌面。
// 后者兼容 token 没有 deviceId claim 的登录方式（如 OAuth access token
// 直接连 WS），避免桌面端用随机 UUID 注册导致 forwardToDesktop 失败。
func (h *Handler) forwardToDesktop(userID uuid.UUID, deviceID string, msg protocol.Message) {
	devUUID, err := uuid.Parse(deviceID)
	if err != nil {
		return
	}
	// 优先按 deviceID 精确查找
	if desktop := h.State.GetDesktop(devUUID); desktop != nil {
		if desktop.UserID == userID {
			if data, err := protocol.MarshalMessage(msg); err == nil {
				_ = desktop.Send(data)
			}
		}
		// Exists but user mismatch: silently drop (matches Rust).
		return
	}
	// 按 deviceID 找不到则按 userID 找第一个在线桌面
	if desktop := h.State.GetDesktopByUser(userID); desktop != nil {
		if data, err := protocol.MarshalMessage(msg); err == nil {
			_ = desktop.Send(data)
		}
		return
	}
	// Desktop not found: record the missed forwarding attempt.
	ctx := context.Background()
	devID := deviceID
	if err := h.DB.InsertActivityLog(ctx, models.ActivityLogInsert{
		UserId:   userID.String(),
		DeviceId: &devID,
		Kind:     "error",
		Title:    "桌面端离线",
		Body:     "目标桌面没有在线 WebSocket 连接，消息未转发。",
		Risky:    false,
	}); err != nil {
		log.Printf("ws: failed to insert desktop-offline activity log: %v", err)
	}
}
