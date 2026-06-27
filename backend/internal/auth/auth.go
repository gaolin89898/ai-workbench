// Package auth implements JWT issuance/verification, password hashing, and
// HTTP auth middleware for the relay server. Ported from
// crates/server/src/auth.rs (token logic) and crates/server/src/state.rs
// (argon2 password hashing). Token TTLs and the JWT payload mirror the Rust
// implementation: access 12h, refresh 30d, desktop pairing 180d.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/argon2"
)

// argon2id parameters. The Rust server uses the argon2 crate's defaults
// (m=19456, t=2, p=1, output_len=32); the Go port mirrors those values.
const (
	argon2Memory      = 19456
	argon2Iterations  = 2
	argon2Parallelism = 1
	argon2SaltLength  = 16
	argon2KeyLength   = 32
)

// contextKey is an unexported type so context keys defined in this package
// cannot collide with keys defined elsewhere.
type contextKey string

const (
	userIDContextKey   contextKey = "userID"
	deviceIDContextKey contextKey = "deviceID"
)

// Claims mirrors the Rust Claims struct ({ sub, exp }) and extends it with
// an optional deviceId claim used by access and desktop-pairing tokens.
// UserID is tagged `json:"sub"`; because it sits at a shallower embedding
// depth than RegisteredClaims.Subject (which also carries `json:"sub"`),
// standard encoding/json field-visibility rules make UserID the winner, so
// it serializes/deserializes as the standard JWT `sub` claim.
type Claims struct {
	UserID   string `json:"sub"`
	DeviceID string `json:"deviceId,omitempty"`
	jwt.RegisteredClaims
}

// GenerateAccessToken signs a 12h access token. Mirrors auth_response in
// auth.rs, which calls token_for with Duration::hours(12). The token carries
// the user id as `sub` and the optional device id as `deviceId`.
func GenerateAccessToken(userID, deviceID, secret string) (string, error) {
	now := time.Now()
	claims := Claims{
		UserID:   userID,
		DeviceID: deviceID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(12 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(now),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(secret))
}

// GenerateRefreshToken signs a 30d refresh token. auth.rs uses
// Duration::days(30). Refresh tokens are not bound to a device, so no
// deviceId claim is set.
func GenerateRefreshToken(userID, secret string) (string, error) {
	now := time.Now()
	claims := Claims{
		UserID: userID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(30 * 24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(now),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(secret))
}

// GenerateDesktopPairingToken signs a 180d token used by paired desktop
// clients. routes/auth.rs uses Duration::days(180) for both pair_desktop and
// approve_desktop_pairing_request. The token carries the user id and the
// newly created device id.
func GenerateDesktopPairingToken(userID, deviceID, secret string) (string, error) {
	now := time.Now()
	claims := Claims{
		UserID:   userID,
		DeviceID: deviceID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(180 * 24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(now),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(secret))
}

// ParseToken parses and validates tokenString against secret, returning the
// claims on success. Mirrors authenticate_token in auth.rs, which uses
// jsonwebtoken::decode with Validation::default() (validates exp). The
// keyfunc rejects any non-HMAC signing method to prevent algorithm
// confusion attacks.
func ParseToken(tokenString, secret string) (*Claims, error) {
	claims := &Claims{}
	token, err := jwt.ParseWithClaims(tokenString, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return []byte(secret), nil
	})
	if err != nil {
		return nil, err
	}
	if !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	return claims, nil
}

// HashPassword hashes password with argon2id and returns the standard PHC
// encoded string `$argon2id$v=19$m=19456,t=2,p=1$<b64 salt>$<b64 hash>`.
// Mirrors AppState::hash_password in state.rs, which uses Argon2::default()
// (the same m/t/p params) and a random SaltString from OsRng.
func HashPassword(password string) (string, error) {
	salt := make([]byte, argon2SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}
	hash := argon2.IDKey(
		[]byte(password), salt,
		argon2Iterations, argon2Memory, argon2Parallelism, argon2KeyLength,
	)
	b64Salt := base64.RawStdEncoding.EncodeToString(salt)
	b64Hash := base64.RawStdEncoding.EncodeToString(hash)
	return fmt.Sprintf(
		"$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		argon2Memory, argon2Iterations, argon2Parallelism, b64Salt, b64Hash,
	), nil
}

// VerifyPassword verifies password against the PHC-encoded hash produced by
// HashPassword (or any argon2id PHC string with the same layout). Returns
// nil on a match, a non-nil error otherwise. Mirrors
// AppState::verify_password in state.rs. Comparison is constant-time.
func VerifyPassword(hashed, password string) error {
	parts := strings.Split(hashed, "$")
	if len(parts) != 6 {
		return fmt.Errorf("invalid hash format")
	}
	if parts[1] != "argon2id" {
		return fmt.Errorf("unsupported hash type: %s", parts[1])
	}
	if parts[2] != "v=19" {
		return fmt.Errorf("unsupported argon2 version: %s", parts[2])
	}
	var memory, iterations, parallelism uint32
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism); err != nil {
		return fmt.Errorf("parse params: %w", err)
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return fmt.Errorf("decode salt: %w", err)
	}
	expectedHash, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return fmt.Errorf("decode hash: %w", err)
	}
	actualHash := argon2.IDKey(
		[]byte(password), salt,
		iterations, memory, uint8(parallelism), uint32(len(expectedHash)),
	)
	if subtle.ConstantTimeCompare(actualHash, expectedHash) != 1 {
		return fmt.Errorf("password does not match")
	}
	return nil
}

// AuthMiddleware wraps next, requiring a valid `Authorization: Bearer <token>`
// header. On success the user id (and optional device id) are injected into
// the request context. On failure it responds 401 with
// `{"error":"unauthorized"}`, mirroring ApiError::Unauthorized in error.rs
// and authenticate_headers in auth.rs.
func AuthMiddleware(secret string, next http.Handler) http.Handler {
	const prefix = "Bearer "
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		// Case-sensitive prefix match, matching Rust's str::strip_prefix("Bearer ").
		if !strings.HasPrefix(authHeader, prefix) {
			writeUnauthorized(w)
			return
		}
		token := authHeader[len(prefix):]
		claims, err := ParseToken(token, secret)
		if err != nil {
			writeUnauthorized(w)
			return
		}
		ctx := context.WithValue(r.Context(), userIDContextKey, claims.UserID)
		if claims.DeviceID != "" {
			ctx = context.WithValue(ctx, deviceIDContextKey, claims.DeviceID)
		}
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
}

// UserIDFromContext returns the user id injected by AuthMiddleware, or "" if
// the context carries none (e.g. the request did not pass the middleware).
func UserIDFromContext(ctx context.Context) string {
	v, _ := ctx.Value(userIDContextKey).(string)
	return v
}

// DeviceIDFromContext returns the device id injected by AuthMiddleware, or ""
// if the token carried no deviceId claim.
func DeviceIDFromContext(ctx context.Context) string {
	v, _ := ctx.Value(deviceIDContextKey).(string)
	return v
}

// GeneratePairingCode returns an 8-character uppercase alphanumeric code,
// matching random_pairing_code in auth.rs (Alphanumeric samples 0-9a-zA-Z,
// then to_ascii_uppercase collapses the result to 0-9A-Z). Uses
// crypto/rand so the code is not predictable.
func GeneratePairingCode() string {
	const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	max := big.NewInt(int64(len(charset)))
	out := make([]byte, 8)
	for i := range out {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			// crypto/rand should never fail on a working system.
			panic(fmt.Sprintf("crypto/rand failed: %v", err))
		}
		out[i] = charset[n.Int64()]
	}
	return string(out)
}

// GenerateDeviceID returns a random UUID v4, used as the desktop device id
// when pairing a new desktop client.
func GenerateDeviceID() string {
	return uuid.NewString()
}
