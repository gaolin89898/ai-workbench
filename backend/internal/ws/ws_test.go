package ws

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/gaolin89898/ai-workbench/backend/internal/auth"
	"github.com/gaolin89898/ai-workbench/backend/internal/protocol"
	"github.com/gaolin89898/ai-workbench/backend/internal/state"
)

const testSecret = "test-secret"

// newTestHandler builds a Handler without a DB. Tests only exercise code
// paths that do not touch the DB (dispatch of pure-forward messages, auth
// query, converters, in-memory forwarding). DB-touching branches are covered
// by the desktop/mobile integration tests that require PostgreSQL.
func newTestHandler() *Handler {
	return &Handler{
		State:  state.NewAppState(nil),
		Secret: testSecret,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
}

// dialUpgrade connects a real WebSocket client to a handler through an
// httptest server, mimicking the production upgrade path. It returns the
// server-side conn (the one upgrader returns and AddMobile/AddDesktop must
// register — writePump writes through it) and the client-side conn (the one
// tests read from to assert delivered messages).
func dialUpgrade(t *testing.T, h *Handler) (serverConn *websocket.Conn, clientConn *websocket.Conn) {
	t.Helper()
	serverConnCh := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := h.upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade failed: %v", err)
			return
		}
		serverConnCh <- conn
	}))
	t.Cleanup(srv.Close)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	clientConn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { _ = clientConn.Close() })
	serverConn = <-serverConnCh
	t.Cleanup(func() { _ = serverConn.Close() })
	return serverConn, clientConn
}

func TestAuthQuery(t *testing.T) {
	h := newTestHandler()

	t.Run("missing token is rejected", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/ws/desktop", nil)
		if _, _, ok := h.authQuery(r); ok {
			t.Fatal("authQuery = ok, want rejected")
		}
	})

	t.Run("invalid token is rejected", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/ws/desktop?token=not-a-jwt", nil)
		if _, _, ok := h.authQuery(r); ok {
			t.Fatal("authQuery = ok, want rejected")
		}
	})

	t.Run("valid token with device id round-trips", func(t *testing.T) {
		userID := uuid.New()
		deviceID := uuid.New()
		token, err := auth.GenerateAccessToken(userID.String(), deviceID.String(), testSecret)
		if err != nil {
			t.Fatalf("GenerateAccessToken: %v", err)
		}
		r := httptest.NewRequest(http.MethodGet, "/ws/desktop?token="+token, nil)
		gotUser, gotDevice, ok := h.authQuery(r)
		if !ok {
			t.Fatal("authQuery = rejected, want accepted")
		}
		if gotUser != userID {
			t.Errorf("userID = %s, want %s", gotUser, userID)
		}
		if gotDevice != deviceID {
			t.Errorf("deviceID = %s, want %s", gotDevice, deviceID)
		}
	})

	t.Run("valid token without device id gets a fresh id", func(t *testing.T) {
		userID := uuid.New()
		token, err := auth.GenerateAccessToken(userID.String(), "", testSecret)
		if err != nil {
			t.Fatalf("GenerateAccessToken: %v", err)
		}
		r := httptest.NewRequest(http.MethodGet, "/ws/desktop?token="+token, nil)
		gotUser, gotDevice, ok := h.authQuery(r)
		if !ok {
			t.Fatal("authQuery = rejected, want accepted")
		}
		if gotUser != userID {
			t.Errorf("userID = %s, want %s", gotUser, userID)
		}
		if gotDevice == uuid.Nil {
			t.Error("deviceID = Nil, want a fresh random id")
		}
	})

	t.Run("wrong secret is rejected", func(t *testing.T) {
		userID := uuid.New()
		token, err := auth.GenerateAccessToken(userID.String(), "", "other-secret")
		if err != nil {
			t.Fatalf("GenerateAccessToken: %v", err)
		}
		r := httptest.NewRequest(http.MethodGet, "/ws/desktop?token="+token, nil)
		if _, _, ok := h.authQuery(r); ok {
			t.Fatal("authQuery = ok, want rejected for wrong secret")
		}
	})
}

func TestHandleDesktopMessageDispatch(t *testing.T) {
	h := newTestHandler()
	userID := uuid.New()
	deviceID := uuid.New()

	t.Run("unknown message type is ignored", func(t *testing.T) {
		// BaseMessage alone satisfies the Message interface but is not a
		// recognized concrete type — must hit the default branch.
		msg := protocol.BaseMessage{Type: "totally.unknown.type"}
		if handled := h.handleDesktopMessage(msg, userID, deviceID); handled {
			t.Fatal("handleDesktopMessage = handled, want ignored")
		}
	})

	t.Run("pure-forward messages are handled without DB", func(t *testing.T) {
		for name, msg := range map[string]protocol.Message{
			"ai.message.delta": protocol.AiMessageDelta{
				BaseMessage: protocol.BaseMessage{Type: "ai.message.delta"},
				DeviceId:    deviceID.String(),
				AiSessionId: uuid.New().String(),
				Content:     "hello",
				Sequence:    1,
			},
			"ai.message.done": protocol.AiMessageDone{
				BaseMessage: protocol.BaseMessage{Type: "ai.message.done"},
				DeviceId:    deviceID.String(),
				AiSessionId: uuid.New().String(),
				Status:      protocol.AiSessionCompleted,
			},
			"ai.trace.update": protocol.AiTraceUpdate{
				BaseMessage: protocol.BaseMessage{Type: "ai.trace.update"},
				DeviceId:    deviceID.String(),
				AiSessionId: uuid.New().String(),
			},
			"ai.chat.output": protocol.AiChatOutput{
				BaseMessage: protocol.BaseMessage{Type: "ai.chat.output"},
				DeviceId:    deviceID.String(),
				AiSessionId: uuid.New().String(),
			},
			"git.status.snapshot": protocol.GitStatusSnapshotMessage{
				BaseMessage: protocol.BaseMessage{Type: "git.status.snapshot"},
			},
		} {
			if handled := h.handleDesktopMessage(msg, userID, deviceID); !handled {
				t.Errorf("%s: handleDesktopMessage = ignored, want handled", name)
			}
		}
	})

	t.Run("snapshot with empty device id short-circuits without DB", func(t *testing.T) {
		// The snapshot handlers return early on empty DeviceId, so they must
		// not panic even with a nil DB.
		msg := protocol.ProvidersSnapshot{
			BaseMessage: protocol.BaseMessage{Type: "providers.snapshot"},
		}
		if handled := h.handleDesktopMessage(msg, userID, deviceID); !handled {
			t.Fatal("providers.snapshot = ignored, want handled")
		}
	})
}

func TestConverters(t *testing.T) {
	t.Run("toModelProviders maps fields", func(t *testing.T) {
		version := "1.2.3"
		checked := time.Now()
		in := []protocol.DesktopProviderStatus{{
			ProviderId:    "codex",
			Installed:     true,
			Version:       &version,
			AuthStatus:    protocol.ProviderAuthSignedIn,
			LastCheckedAt: checked,
		}}
		out := toModelProviders(in)
		if len(out) != 1 {
			t.Fatalf("len = %d, want 1", len(out))
		}
		got := out[0]
		if got.ProviderId != "codex" || !got.Installed || got.Version != &version ||
			got.AuthStatus != string(protocol.ProviderAuthSignedIn) || !got.LastCheckedAt.Equal(checked) {
			t.Errorf("mapping mismatch: %+v", got)
		}
	})

	t.Run("toModelProjects maps fields", func(t *testing.T) {
		branch := "main"
		updated := time.Now()
		in := []protocol.WorkspaceProject{{
			Id:        "p1",
			DeviceId:  "dev1",
			Name:      "demo",
			Path:      "/tmp/demo",
			GitBranch: &branch,
			GitDirty:  true,
			UpdatedAt: updated,
		}}
		out := toModelProjects(in)
		if len(out) != 1 {
			t.Fatalf("len = %d, want 1", len(out))
		}
		got := out[0]
		if got.Id != "p1" || got.DeviceId != "dev1" || got.Name != "demo" ||
			got.Path != "/tmp/demo" || got.GitBranch != &branch || !got.GitDirty ||
			!got.UpdatedAt.Equal(updated) {
			t.Errorf("mapping mismatch: %+v", got)
		}
	})

	t.Run("toModelAiSessions maps fields", func(t *testing.T) {
		updated := time.Now()
		archived := time.Now()
		summary := "done"
		projectID := "p1"
		terminalID := "t1"
		providerSessionID := "ps1"
		in := []protocol.AiSession{{
			Id:                "s1",
			UserId:            "u1",
			DeviceId:          "dev1",
			ProjectId:         &projectID,
			ProviderId:        "codex",
			TerminalSessionId: &terminalID,
			ProviderSessionId: &providerSessionID,
			Title:             "fix login",
			Status:            protocol.AiSessionCompleted,
			Summary:           &summary,
			ArchivedAt:        &archived,
			UpdatedAt:         updated,
		}}
		out := toModelAiSessions(in)
		if len(out) != 1 {
			t.Fatalf("len = %d, want 1", len(out))
		}
		got := out[0]
		if got.Id != "s1" || got.UserId != "u1" || got.DeviceId != "dev1" ||
			got.ProjectId != &projectID || got.ProviderId != "codex" ||
			got.TerminalSessionId != &terminalID || got.ProviderSessionId != &providerSessionID ||
			got.Title != "fix login" || got.Status != string(protocol.AiSessionCompleted) ||
			got.Summary != &summary || got.ArchivedAt != &archived || !got.UpdatedAt.Equal(updated) {
			t.Errorf("mapping mismatch: %+v", got)
		}
	})
}

// TestNotifyMobilesForwarding verifies the core fan-out path: a message from
// a desktop (here injected via notifyMobiles) reaches every mobile connection
// of the same user over a real WebSocket.
func TestNotifyMobilesForwarding(t *testing.T) {
	h := newTestHandler()
	userID := uuid.New()

	serverConn, clientConn := dialUpgrade(t, h)
	h.State.AddMobile(userID, uuid.New(), serverConn)

	msg := protocol.DesktopHeartbeat{
		BaseMessage: protocol.BaseMessage{Type: "desktop.heartbeat"},
		DeviceId:    uuid.New().String(),
		Timestamp:   time.Now(),
	}
	h.notifyMobiles(userID, msg)

	_ = clientConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, data, err := clientConn.ReadMessage()
	if err != nil {
		t.Fatalf("mobile did not receive forwarded message: %v", err)
	}
	got, err := protocol.ParseMessage(data)
	if err != nil {
		t.Fatalf("received unparseable message: %v (%s)", err, data)
	}
	if got.GetType() != "desktop.heartbeat" {
		t.Errorf("received type = %q, want desktop.heartbeat", got.GetType())
	}
}

// TestForwardToDesktop verifies desktop-directed forwarding: exact deviceId
// match forwards; a deviceId owned by a different user is silently dropped.
func TestForwardToDesktop(t *testing.T) {
	t.Run("online desktop receives the message", func(t *testing.T) {
		h := newTestHandler()
		userID := uuid.New()
		deviceID := uuid.New()

		serverConn, clientConn := dialUpgrade(t, h)
		h.State.AddDesktop(userID, deviceID, serverConn)

		msg := protocol.ProjectCreated{
			BaseMessage: protocol.BaseMessage{Type: "project.created"},
			DeviceId:    deviceID.String(),
			Project: protocol.WorkspaceProject{
				Id: "p1", Name: "demo", Path: "/tmp/demo",
			},
		}
		h.forwardToDesktop(userID, deviceID.String(), msg)

		_ = clientConn.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, data, err := clientConn.ReadMessage()
		if err != nil {
			t.Fatalf("desktop did not receive forwarded message: %v", err)
		}
		got, err := protocol.ParseMessage(data)
		if err != nil {
			t.Fatalf("received unparseable message: %v", err)
		}
		if got.GetType() != "project.created" {
			t.Errorf("received type = %q, want project.created", got.GetType())
		}
	})

	t.Run("desktop owned by another user is dropped", func(t *testing.T) {
		h := newTestHandler()
		ownerID := uuid.New()
		deviceID := uuid.New()

		serverConn, clientConn := dialUpgrade(t, h)
		h.State.AddDesktop(ownerID, deviceID, serverConn)

		// A different user tries to forward to this device — must be dropped.
		otherUser := uuid.New()
		msg := protocol.ProjectCreated{
			BaseMessage: protocol.BaseMessage{Type: "project.created"},
			DeviceId:    deviceID.String(),
		}
		h.forwardToDesktop(otherUser, deviceID.String(), msg)

		_ = clientConn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
		if _, _, err := clientConn.ReadMessage(); err == nil {
			t.Fatal("desktop received a message from a foreign user, want drop")
		}
	})
}
