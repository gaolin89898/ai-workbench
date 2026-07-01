// Ported from crates/shared/src/lib.rs.
package protocol

import (
	"bytes"
	"encoding/json"
	"testing"
)

// roundTrip parses input, marshals it, re-parses and re-marshals, then
// asserts that marshalling is idempotent and the type is preserved.
func roundTrip(t *testing.T, input string, wantType string) {
	t.Helper()

	first, err := ParseMessage([]byte(input))
	if err != nil {
		t.Fatalf("ParseMessage failed: %v", err)
	}
	if got := first.GetType(); got != wantType {
		t.Fatalf("GetType = %q, want %q", got, wantType)
	}

	b1, err := MarshalMessage(first)
	if err != nil {
		t.Fatalf("MarshalMessage (1) failed: %v", err)
	}
	second, err := ParseMessage(b1)
	if err != nil {
		t.Fatalf("re-ParseMessage failed: %v", err)
	}
	if second.GetType() != wantType {
		t.Fatalf("re-parsed type = %q, want %q", second.GetType(), wantType)
	}
	b2, err := MarshalMessage(second)
	if err != nil {
		t.Fatalf("MarshalMessage (2) failed: %v", err)
	}
	if !bytes.Equal(b1, b2) {
		t.Fatalf("marshal not idempotent:\n first:  %s\n second: %s", b1, b2)
	}
}

func TestParseDesktopHeartbeat(t *testing.T) {
	roundTrip(t, `{"type":"desktop.heartbeat","deviceId":"11111111-1111-1111-1111-111111111111","timestamp":"2024-01-02T03:04:05Z"}`, "desktop.heartbeat")
}

func TestParseProvidersSnapshot(t *testing.T) {
	roundTrip(t, `{"type":"providers.snapshot","deviceId":"11111111-1111-1111-1111-111111111111","providers":[{"providerId":"codex","installed":true,"version":"0.1.0","authStatus":"signedIn","lastCheckedAt":"2024-01-02T03:04:05Z"}]}`, "providers.snapshot")
}

func TestParseAiMessageSend(t *testing.T) {
	roundTrip(t, `{"type":"ai.message.send","deviceId":"11111111-1111-1111-1111-111111111111","aiSessionId":"22222222-2222-2222-2222-222222222222","content":"hello","confirmedRisk":false}`, "ai.message.send")
}

func TestParseAiApprovalRespond(t *testing.T) {
	roundTrip(t, `{"type":"ai.approval.respond","deviceId":"11111111-1111-1111-1111-111111111111","aiSessionId":"22222222-2222-2222-2222-222222222222","approvalId":"approval-1","decision":"approved"}`, "ai.approval.respond")
}

func TestParseAiSessionArchive(t *testing.T) {
	roundTrip(t, `{"type":"ai.session.archive","deviceId":"11111111-1111-1111-1111-111111111111","aiSessionId":"22222222-2222-2222-2222-222222222222","archived":true}`, "ai.session.archive")
}

func TestParseAiChatOutput(t *testing.T) {
	roundTrip(t, `{"type":"ai.chat.output","deviceId":"11111111-1111-1111-1111-111111111111","aiSessionId":"22222222-2222-2222-2222-222222222222","kind":"status","text":"running","stepId":"runtime-status","segment":{"type":"status","stepId":"runtime-status","label":"Codex 正在执行","icon":"think"},"segments":[{"type":"status","stepId":"runtime-status","label":"Codex 正在执行","icon":"think"}]}`, "ai.chat.output")
}

func TestParseAiHistoryResponseStructuredContent(t *testing.T) {
	roundTrip(t, `{"type":"ai.history.response","deviceId":"11111111-1111-1111-1111-111111111111","aiSessionId":"22222222-2222-2222-2222-222222222222","requestId":"33333333-3333-4333-8333-333333333333","messages":[{"role":"assistant","content":{"text":"完成","segments":[{"type":"status","stepId":"runtime-status","label":"已完成","icon":"check"}]},"createdAt":"2024-01-02T03:04:05Z"}]}`, "ai.history.response")
}

func TestParseGitStatusSnapshot(t *testing.T) {
	roundTrip(t, `{"type":"git.status.snapshot","snapshot":{"deviceId":"11111111-1111-1111-1111-111111111111","projectId":"33333333-3333-3333-3333-333333333333","branch":"main","dirty":true,"files":["a.go","b.go"]}}`, "git.status.snapshot")
}

func TestParseUnknownType(t *testing.T) {
	if _, err := ParseMessage([]byte(`{"type":"nope.notreal"}`)); err == nil {
		t.Fatal("expected error for unknown message type")
	}
}

func TestParseInvalidJSON(t *testing.T) {
	if _, err := ParseMessage([]byte(`{not json`)); err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

// TestAiMessageSendFieldNames guards the wire-compatible camelCase field names
// the existing Rust clients depend on.
func TestAiMessageSendFieldNames(t *testing.T) {
	src := `{"type":"ai.message.send","deviceId":"d","aiSessionId":"s","content":"hi","confirmedRisk":true}`
	m, err := ParseMessage([]byte(src))
	if err != nil {
		t.Fatalf("ParseMessage: %v", err)
	}
	send, ok := m.(AiMessageSend)
	if !ok {
		t.Fatalf("expected AiMessageSend, got %T", m)
	}
	if send.DeviceId != "d" || send.AiSessionId != "s" || send.Content != "hi" || !send.ConfirmedRisk {
		t.Fatalf("unexpected fields: %+v", send)
	}
	out, err := json.Marshal(send)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"type":"ai.message.send","deviceId":"d","aiSessionId":"s","content":"hi","confirmedRisk":true}`
	if string(out) != want {
		t.Fatalf("marshal mismatch:\n got:  %s\n want: %s", out, want)
	}
}

// TestAiMessageDeltaUsesContentField documents that the delta variant uses
// `content` (matching the Rust source), not `delta`.
func TestAiMessageDeltaUsesContentField(t *testing.T) {
	src := `{"type":"ai.message.delta","deviceId":"d","aiSessionId":"s","content":"chunk","sequence":3}`
	m, err := ParseMessage([]byte(src))
	if err != nil {
		t.Fatalf("ParseMessage: %v", err)
	}
	d, ok := m.(AiMessageDelta)
	if !ok {
		t.Fatalf("expected AiMessageDelta, got %T", m)
	}
	if d.Content != "chunk" || d.Sequence != 3 {
		t.Fatalf("unexpected fields: %+v", d)
	}
}
