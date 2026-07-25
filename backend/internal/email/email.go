// Package email provides SMTP-based email delivery for the relay server.
//
// It supports the two common port/mode combinations used by mainstream mail
// providers:
//
//   - port 465: implicit TLS (SMTPS) — a TLS handshake is performed before any
//     SMTP command, via crypto/tls.Dial.
//   - port 587 / 25: plain connection upgraded with STARTTLS, handled
//     automatically by net/smtp.SendMail.
//
// The package intentionally avoids third-party mail libraries to keep the
// backend dependency surface minimal (see go.mod).
package email

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"strings"
)

// Sender holds the SMTP credentials and envelope From used to deliver mail.
// A Sender is safe for concurrent use: Send dials a fresh connection per call.
type Sender struct {
	Host     string // SMTP server host, e.g. "smtp.example.com"
	Port     string // SMTP server port, e.g. "465" or "587"
	Username string // SMTP auth username (usually the same as From)
	Password string // SMTP auth password / app-specific password
	From     string // envelope From address
	FromName string // display name for the From header
}

// NewSender constructs a Sender. Host/Username/Password/From must be non-empty;
// callers should gate on config.SMTPConfigured() before constructing.
func NewSender(host, port, username, password, from, fromName string) *Sender {
	return &Sender{
		Host: host, Port: port, Username: username, Password: password,
		From: from, FromName: fromName,
	}
}

// Send delivers a single message to one recipient. The message body must
// already be a complete RFC 822 message (headers + blank line + body). The
// routing differs by port: 465 uses implicit TLS, everything else uses
// net/smtp.SendMail (which negotiates STARTTLS when the server advertises it).
func (s *Sender) Send(to, subject, htmlBody, textBody string) error {
	msg := s.buildMessage(to, subject, htmlBody, textBody)
	addr := net.JoinHostPort(s.Host, s.Port)
	auth := smtp.PlainAuth("", s.Username, s.Password, s.Host)

	if s.Port == "465" {
		return s.sendImplicitTLS(addr, auth, to, msg)
	}
	return s.sendStartTLS(addr, auth, to, msg)
}

// sendImplicitTLS connects with crypto/tls.Dial (port 465) and runs the SMTP
// transaction manually. STARTTLS is not issued because the connection is
// already encrypted.
func (s *Sender) sendImplicitTLS(addr string, auth smtp.Auth, to string, msg []byte) error {
	conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: s.Host})
	if err != nil {
		return fmt.Errorf("smtp dial (implicit tls): %w", err)
	}
	defer conn.Close()

	c, err := smtp.NewClient(conn, s.Host)
	if err != nil {
		return fmt.Errorf("smtp new client: %w", err)
	}
	defer c.Close()

	if err := c.Hello("localhost"); err != nil {
		return fmt.Errorf("smtp hello: %w", err)
	}
	if ok, _ := c.Extension("AUTH"); ok {
		if err := c.Auth(auth); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := c.Mail(s.From); err != nil {
		return fmt.Errorf("smtp mail: %w", err)
	}
	if err := c.Rcpt(to); err != nil {
		return fmt.Errorf("smtp rcpt: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp data: %w", err)
	}
	if _, err := w.Write(msg); err != nil {
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp close: %w", err)
	}
	return c.Quit()
}

// sendStartTLS delegates to net/smtp.SendMail, which dials in plaintext and
// upgrades via STARTTLS when the server supports it (port 587/25).
func (s *Sender) sendStartTLS(addr string, auth smtp.Auth, to string, msg []byte) error {
	if err := smtp.SendMail(addr, auth, s.From, []string{to}, msg); err != nil {
		return fmt.Errorf("smtp sendmail: %w", err)
	}
	return nil
}

// buildMessage assembles a multipart/alternative RFC 822 message carrying both
// an HTML and a plain-text part so the verification code renders on every
// client (GUI clients prefer HTML, terminal readers prefer text).
func (s *Sender) buildMessage(to, subject, htmlBody, textBody string) []byte {
	var b strings.Builder
	fromHeader := s.From
	if s.FromName != "" {
		fromHeader = fmt.Sprintf("%s <%s>", s.FromName, s.From)
	}
	b.WriteString("From: " + fromHeader + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + subject + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: multipart/alternative; boundary=codehub-alt-boundary\r\n\r\n")
	b.WriteString("--codehub-alt-boundary\r\n")
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: 7bit\r\n\r\n")
	b.WriteString(textBody + "\r\n\r\n")
	b.WriteString("--codehub-alt-boundary\r\n")
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: 7bit\r\n\r\n")
	b.WriteString(htmlBody + "\r\n\r\n")
	b.WriteString("--codehub-alt-boundary--\r\n")
	return []byte(b.String())
}
