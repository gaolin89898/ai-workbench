package config

import "testing"

func TestValidateJWTSecret(t *testing.T) {
	cases := []struct {
		secret string
		valid  bool
	}{
		{"", false},
		{"dev-secret-change-me", false},
		{"change-this-in-production", false},
		{"secret", false},
		{"short", false},
		{"a-very-long-random-secret-string-0123456789abcdef", true},
	}
	for _, tc := range cases {
		err := ValidateJWTSecret(tc.secret)
		if tc.valid && err != nil {
			t.Errorf("ValidateJWTSecret(%q) = %v, want valid", tc.secret, err)
		}
		if !tc.valid && err == nil {
			t.Errorf("ValidateJWTSecret(%q) = nil, want error", tc.secret)
		}
	}
}
