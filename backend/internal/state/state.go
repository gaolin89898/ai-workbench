// Ported from crates/server/src/state.rs.
//
// This package holds the shared AppState for the relay server and tracks live
// mobile/desktop WebSocket connections. Mobiles are indexed by userID then
// deviceID; desktops are indexed by deviceID. Map mutations are guarded by an
// RWMutex; per-connection writes run through a dedicated write goroutine fed
// by a buffered Outbound channel, mirroring the Rust mpsc model.
package state

import (
	"errors"
	"log"
	"sync"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/gaolin89898/ai-workbench/backend/internal/db"
)

// outboundBufferSize is the per-connection outbound buffer. When full, new
// messages are dropped and logged, matching the Rust sender's behavior.
const outboundBufferSize = 256

// Sentinel errors returned by Send.
var (
	errOutboundFull     = errors.New("outbound channel full, dropping message")
	errConnectionClosed = errors.New("connection closed")
)

// MobileConnection 移动端连接
type MobileConnection struct {
	UserID   uuid.UUID
	DeviceID uuid.UUID
	Conn     *websocket.Conn
	Outbound chan []byte
	mu       sync.Mutex // 保护 Conn.WriteMessage（write goroutine 模式下为备用）

	// done is closed to signal the write goroutine to exit; once is used to
	// make close idempotent. Closing done (rather than Outbound) avoids
	// send-on-closed-channel panics from concurrent Send calls.
	done chan struct{}
	once sync.Once
}

// DesktopConnection 桌面端连接
type DesktopConnection struct {
	UserID   uuid.UUID
	DeviceID uuid.UUID
	Conn     *websocket.Conn
	Outbound chan []byte
	mu       sync.Mutex

	done chan struct{}
	once sync.Once
}

// AppState 全局状态
type AppState struct {
	DB       *db.DB
	Mobiles  map[uuid.UUID]map[uuid.UUID]*MobileConnection // userID -> deviceID -> connection
	Desktops map[uuid.UUID]*DesktopConnection              // deviceID -> connection
	mu       sync.RWMutex
}

// NewAppState creates an empty AppState backed by d.
func NewAppState(d *db.DB) *AppState {
	return &AppState{
		DB:       d,
		Mobiles:  make(map[uuid.UUID]map[uuid.UUID]*MobileConnection),
		Desktops: make(map[uuid.UUID]*DesktopConnection),
	}
}

// ---- Mobile 连接管理 ----

// AddMobile registers a mobile connection and starts its write goroutine. If
// a connection already exists for the same (userID, deviceID) pair it is
// closed first, mirroring the Rust behavior of dropping the previous sender.
func (s *AppState) AddMobile(userID, deviceID uuid.UUID, conn *websocket.Conn) *MobileConnection {
	c := &MobileConnection{
		UserID:   userID,
		DeviceID: deviceID,
		Conn:     conn,
		Outbound: make(chan []byte, outboundBufferSize),
		done:     make(chan struct{}),
	}
	go c.writePump()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Mobiles[userID] == nil {
		s.Mobiles[userID] = make(map[uuid.UUID]*MobileConnection)
	}
	if existing := s.Mobiles[userID][deviceID]; existing != nil {
		existing.close()
	}
	s.Mobiles[userID][deviceID] = c
	return c
}

// RemoveMobile removes a mobile connection and signals its write goroutine to
// exit. Mirrors AppState::remove_mobile in state.rs, including dropping the
// per-user map when it becomes empty.
func (s *AppState) RemoveMobile(userID, deviceID uuid.UUID) {
	s.mu.Lock()
	defer s.mu.Unlock()

	userMobiles := s.Mobiles[userID]
	if userMobiles == nil {
		return
	}
	c, ok := userMobiles[deviceID]
	if !ok {
		return
	}
	delete(userMobiles, deviceID)
	if len(userMobiles) == 0 {
		delete(s.Mobiles, userID)
	}
	c.close()
}

// GetMobilesByUser returns a snapshot of all mobile connections for a user.
// The slice is safe to iterate and Send after the lock is released.
func (s *AppState) GetMobilesByUser(userID uuid.UUID) []*MobileConnection {
	s.mu.RLock()
	defer s.mu.RUnlock()

	userMobiles := s.Mobiles[userID]
	if len(userMobiles) == 0 {
		return nil
	}
	out := make([]*MobileConnection, 0, len(userMobiles))
	for _, c := range userMobiles {
		out = append(out, c)
	}
	return out
}

// ---- Desktop 连接管理 ----

// AddDesktop registers a desktop connection and starts its write goroutine.
// Any existing connection for the same deviceID is closed first.
func (s *AppState) AddDesktop(userID, deviceID uuid.UUID, conn *websocket.Conn) *DesktopConnection {
	c := &DesktopConnection{
		UserID:   userID,
		DeviceID: deviceID,
		Conn:     conn,
		Outbound: make(chan []byte, outboundBufferSize),
		done:     make(chan struct{}),
	}
	go c.writePump()

	s.mu.Lock()
	defer s.mu.Unlock()
	if existing := s.Desktops[deviceID]; existing != nil {
		existing.close()
	}
	s.Desktops[deviceID] = c
	return c
}

// RemoveDesktop removes a desktop connection and signals its write goroutine
// to exit.
func (s *AppState) RemoveDesktop(deviceID uuid.UUID) {
	s.mu.Lock()
	defer s.mu.Unlock()

	c, ok := s.Desktops[deviceID]
	if !ok {
		return
	}
	delete(s.Desktops, deviceID)
	c.close()
}

// GetDesktop returns the desktop connection for deviceID, or nil.
func (s *AppState) GetDesktop(deviceID uuid.UUID) *DesktopConnection {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.Desktops[deviceID]
}

// GetDesktopByUser returns the first desktop connection belonging to userID,
// or nil. Desktops are keyed by deviceID, so this scans the map.
func (s *AppState) GetDesktopByUser(userID uuid.UUID) *DesktopConnection {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, c := range s.Desktops {
		if c.UserID == userID {
			return c
		}
	}
	return nil
}

// ---- 消息发送（线程安全） ----

// SendToMobiles sends data to every mobile connection owned by userID.
func (s *AppState) SendToMobiles(userID uuid.UUID, data []byte) {
	for _, c := range s.GetMobilesByUser(userID) {
		_ = c.Send(data)
	}
}

// SendToDesktop sends data to the desktop connection for deviceID. It returns
// false if no such connection exists or the send was dropped.
func (s *AppState) SendToDesktop(deviceID uuid.UUID, data []byte) bool {
	c := s.GetDesktop(deviceID)
	if c == nil {
		return false
	}
	return c.Send(data) == nil
}

// BroadcastToDesktop sends data to every desktop connection owned by userID.
func (s *AppState) BroadcastToDesktop(userID uuid.UUID, data []byte) {
	s.mu.RLock()
	targets := make([]*DesktopConnection, 0, 1)
	for _, c := range s.Desktops {
		if c.UserID == userID {
			targets = append(targets, c)
		}
	}
	s.mu.RUnlock()

	for _, c := range targets {
		_ = c.Send(data)
	}
}

// ---- Connection 写方法 ----

// Send enqueues data onto the mobile connection's outbound channel. It is
// non-blocking: a full buffer drops the message and logs it; a closed
// connection returns errConnectionClosed.
func (c *MobileConnection) Send(data []byte) error {
	select {
	case <-c.done:
		return errConnectionClosed
	case c.Outbound <- data:
		return nil
	default:
		log.Printf("state: mobile outbound full, dropping message for user=%s device=%s", c.UserID, c.DeviceID)
		return errOutboundFull
	}
}

// Send enqueues data onto the desktop connection's outbound channel.
func (c *DesktopConnection) Send(data []byte) error {
	select {
	case <-c.done:
		return errConnectionClosed
	case c.Outbound <- data:
		return nil
	default:
		log.Printf("state: desktop outbound full, dropping message for user=%s device=%s", c.UserID, c.DeviceID)
		return errOutboundFull
	}
}

// close signals the write goroutine to exit. Safe to call multiple times.
func (c *MobileConnection) close() {
	c.once.Do(func() { close(c.done) })
}

func (c *DesktopConnection) close() {
	c.once.Do(func() { close(c.done) })
}

// writePump drains the outbound channel and writes frames to the WebSocket.
// It exits when the outbound channel is closed or the connection's done
// channel is closed, then closes the underlying WebSocket. There is a single
// writer per connection, so WriteMessage needs no extra synchronization.
func (c *MobileConnection) writePump() {
	defer c.Conn.Close()
	for {
		select {
		case data, ok := <-c.Outbound:
			if !ok {
				return
			}
			if err := c.Conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		case <-c.done:
			return
		}
	}
}

func (c *DesktopConnection) writePump() {
	defer c.Conn.Close()
	for {
		select {
		case data, ok := <-c.Outbound:
			if !ok {
				return
			}
			if err := c.Conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		case <-c.done:
			return
		}
	}
}
