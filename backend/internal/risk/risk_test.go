// Ported from crates/shared/src/lib.rs (assess_command_risk tests).
package risk

import (
	"strings"
	"testing"
)

func TestRiskyCommands(t *testing.T) {
	cases := []string{
		"rm -rf /",
		"sudo rm -rf /home",
		"mkfs.ext4 /dev/sda",
		"shutdown -h now",
		"reboot",
		"dd if=/dev/zero of=/dev/sda",
		"chmod -R 777 /var",
		"cat ~/.ssh/id_rsa",
		"cat /home/user/.ssh/config",
		"echo my private key here",
		"export TOKEN=abc123",
		"export SECRET=value",
		"export API_KEY=sk-xxx",
		"apikey=12345",
		"access_token=xyz",
	}
	for _, cmd := range cases {
		res := AssessCommandRisk(cmd)
		if !res.Risky {
			t.Errorf("AssessCommandRisk(%q) = risky=false, want true (reason=%q category=%q)", cmd, res.Reason, res.Category)
		}
		if res.Reason == "" || res.Category == "" {
			t.Errorf("AssessCommandRisk(%q) missing reason/category: %+v", cmd, res)
		}
	}
}

func TestSafeCommands(t *testing.T) {
	cases := []string{
		"ls -la",
		"please review this project",
		"git status",
		"cargo build --release",
		"echo hello world",
	}
	for _, cmd := range cases {
		res := AssessCommandRisk(cmd)
		if res.Risky {
			t.Errorf("AssessCommandRisk(%q) = risky=true, want false (%+v)", cmd, res)
		}
		if res.Reason != "" || res.Category != "" {
			t.Errorf("AssessCommandRisk(%q) safe result should have empty reason/category: %+v", cmd, res)
		}
	}
}

// TestMultipleMatches mirrors the Rust "detects_risky_commands" test:
// "sudo rm -rf ~/.ssh" should match rm -rf, sudo rm and .ssh simultaneously.
func TestMultipleMatches(t *testing.T) {
	res := AssessCommandRisk("sudo rm -rf ~/.ssh")
	if !res.Risky {
		t.Fatal("expected risky=true")
	}
	// Reason joins all matched rules; verify all three reasons are present.
	for _, want := range []string{
		"recursive force deletion",
		"privileged removal",
		"SSH directory",
	} {
		if !strings.Contains(res.Reason, want) {
			t.Errorf("reason %q missing fragment %q", res.Reason, want)
		}
	}
	// Category comes from the first match (rm -rf -> destructive).
	if res.Category != "destructive" {
		t.Errorf("category = %q, want destructive", res.Category)
	}
}

// TestApiKeyRequiresEquals documents faithful behavior: the Rust rule matches
// "api_key=" (with the equals sign). A bare "echo $API_KEY" does NOT match,
// while assigning the variable does. This keeps the Go port behaviorally
// identical to the existing Rust server.
func TestApiKeyRequiresEquals(t *testing.T) {
	if res := AssessCommandRisk("echo $API_KEY"); res.Risky {
		t.Errorf("echo $API_KEY should not be flagged (rule needs 'api_key='): %+v", res)
	}
	if res := AssessCommandRisk("export API_KEY=sk-xxx"); !res.Risky {
		t.Errorf("export API_KEY=... should be flagged: %+v", res)
	}
}

func TestCaseInsensitive(t *testing.T) {
	res := AssessCommandRisk("SUDO RM -RF /")
	if !res.Risky {
		t.Errorf("uppercase variant should still match: %+v", res)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
