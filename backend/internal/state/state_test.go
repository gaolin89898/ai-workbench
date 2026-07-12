package state

import (
	"testing"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

func TestRemoveDesktopIfCurrentKeepsReplacement(t *testing.T) {
	deviceID := uuid.New()
	staleConn := &websocket.Conn{}
	currentConn := &websocket.Conn{}
	current := &DesktopConnection{Conn: currentConn, done: make(chan struct{})}
	state := &AppState{Desktops: map[uuid.UUID]*DesktopConnection{deviceID: current}}

	state.RemoveDesktopIfCurrent(deviceID, staleConn)

	if got := state.GetDesktop(deviceID); got != current {
		t.Fatal("stale cleanup removed the replacement desktop connection")
	}
	select {
	case <-current.done:
		t.Fatal("stale cleanup closed the replacement desktop connection")
	default:
	}

	state.RemoveDesktopIfCurrent(deviceID, currentConn)
	if state.GetDesktop(deviceID) != nil {
		t.Fatal("current desktop connection was not removed")
	}
}

func TestRemoveMobileIfCurrentKeepsReplacement(t *testing.T) {
	userID := uuid.New()
	deviceID := uuid.New()
	staleConn := &websocket.Conn{}
	currentConn := &websocket.Conn{}
	current := &MobileConnection{Conn: currentConn, done: make(chan struct{})}
	state := &AppState{Mobiles: map[uuid.UUID]map[uuid.UUID]*MobileConnection{
		userID: {deviceID: current},
	}}

	state.RemoveMobileIfCurrent(userID, deviceID, staleConn)

	if got := state.GetMobilesByUser(userID); len(got) != 1 || got[0] != current {
		t.Fatal("stale cleanup removed the replacement mobile connection")
	}
	select {
	case <-current.done:
		t.Fatal("stale cleanup closed the replacement mobile connection")
	default:
	}

	state.RemoveMobileIfCurrent(userID, deviceID, currentConn)
	if got := state.GetMobilesByUser(userID); len(got) != 0 {
		t.Fatal("current mobile connection was not removed")
	}
}
