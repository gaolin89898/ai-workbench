package routes

import (
	"encoding/json"
	"testing"
)

func TestDingTalkTokenRequestBodyEscapesValues(t *testing.T) {
	body, err := dingTalkTokenRequestBody(
		"client-id",
		`secret"with\chars`,
		`code"with\chars`,
	)
	if err != nil {
		t.Fatalf("dingTalkTokenRequestBody returned error: %v", err)
	}

	var got dingTalkTokenRequest
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("request body is not valid JSON: %v\nbody=%s", err, body)
	}
	if got.ClientID != "client-id" {
		t.Fatalf("ClientID = %q, want %q", got.ClientID, "client-id")
	}
	if got.ClientSecret != `secret"with\chars` {
		t.Fatalf("ClientSecret = %q, want %q", got.ClientSecret, `secret"with\chars`)
	}
	if got.Code != `code"with\chars` {
		t.Fatalf("Code = %q, want %q", got.Code, `code"with\chars`)
	}
	if got.GrantType != "authorization_code" {
		t.Fatalf("GrantType = %q, want authorization_code", got.GrantType)
	}
}

func TestShortExternalID(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "empty", in: "", want: ""},
		{name: "short", in: "abc", want: "abc"},
		{name: "eight", in: "12345678", want: "12345678"},
		{name: "long", in: "123456789", want: "12345678"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shortExternalID(tt.in); got != tt.want {
				t.Fatalf("shortExternalID(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
