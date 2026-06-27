// Ported from crates/shared/src/lib.rs (assess_command_risk).
//
// The Rust source only returns the matched rule labels. To support the richer
// feedback the Go API layer needs, each rule is augmented here with a human
// readable reason and a category, while the matching logic (needles, order,
// case-insensitive substring matching) is preserved verbatim.
package risk

import "strings"

// RiskResult is the outcome of AssessCommandRisk.
type RiskResult struct {
	Risky    bool   `json:"risky"`
	Reason   string `json:"reason"`
	Category string `json:"category"`
}

// rule is one risk rule. Needle is matched case-insensitively as a substring
// of the lowered input. The order of commandRiskRules mirrors the Rust array
// exactly so multi-rule matching behaves the same.
type rule struct {
	Needle   string
	Label    string
	Reason   string
	Category string
}

// commandRiskRules is the 15-rule table ported from assess_command_risk.
// Categories: "destructive" for system/file damaging commands, "secrets" for
// credential/key exposure.
var commandRiskRules = []rule{
	{"rm -rf", "rm -rf", "recursive force deletion can destroy files", "destructive"},
	{"sudo rm", "sudo rm", "privileged removal executed with sudo", "destructive"},
	{"mkfs", "mkfs", "filesystem formatting wipes the target device", "destructive"},
	{"shutdown", "shutdown", "system shutdown command", "destructive"},
	{"reboot", "reboot", "system reboot command", "destructive"},
	{"dd if=", "dd if=", "raw disk write via dd can overwrite data", "destructive"},
	{"chmod -r 777", "chmod -R 777", "world-writable permissions applied recursively", "destructive"},
	{".ssh", ".ssh", "references SSH directory which may hold keys", "secrets"},
	{"id_rsa", "id_rsa", "references an SSH private key", "secrets"},
	{"private key", "private key", "references a private key", "secrets"},
	{"export token=", "export TOKEN=", "assigns a token environment variable", "secrets"},
	{"export secret=", "export SECRET=", "assigns a secret environment variable", "secrets"},
	{"api_key=", "api_key=", "assigns an API key", "secrets"},
	{"apikey=", "apikey=", "assigns an API key", "secrets"},
	{"access_token=", "access_token=", "assigns an access token", "secrets"},
}

// AssessCommandRisk evaluates a command string against the 15 risk rules.
// When at least one rule matches, Risky is true, Reason joins every matched
// rule's reason, and Category is the category of the first match. The input
// is matched case-insensitively.
func AssessCommandRisk(input string) RiskResult {
	lower := strings.ToLower(input)

	var reasons []string
	var category string
	for _, r := range commandRiskRules {
		if strings.Contains(lower, r.Needle) {
			reasons = append(reasons, r.Reason)
			if category == "" {
				category = r.Category
			}
		}
	}

	if len(reasons) == 0 {
		return RiskResult{}
	}
	return RiskResult{
		Risky:    true,
		Reason:   strings.Join(reasons, "; "),
		Category: category,
	}
}
