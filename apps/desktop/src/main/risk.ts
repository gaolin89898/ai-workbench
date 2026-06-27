// Risk command assessment — TypeScript port of `assess_command_risk`
// from backend/internal/risk/risk.go. Rule set and labels must stay in sync.

export type RiskAssessment = {
  risky: boolean;
  matchedRules: string[];
};

// Each tuple is [needle (lowercased), label (original casing)].
// The input is lowercased before matching, so needles must already be lowercase.
const RISK_RULES: ReadonlyArray<readonly [string, string]> = [
  ["rm -rf", "rm -rf"],
  ["sudo rm", "sudo rm"],
  ["mkfs", "mkfs"],
  ["shutdown", "shutdown"],
  ["reboot", "reboot"],
  ["dd if=", "dd if="],
  ["chmod -r 777", "chmod -R 777"],
  [".ssh", ".ssh"],
  ["id_rsa", "id_rsa"],
  ["private key", "private key"],
  ["export token=", "export TOKEN="],
  ["export secret=", "export SECRET="],
  ["api_key=", "api_key="],
  ["apikey=", "apikey="],
  ["access_token=", "access_token="],
];

export function assessCommandRisk(input: string): RiskAssessment {
  const lowered = input.toLowerCase();
  const matchedRules: string[] = [];
  for (const [needle, label] of RISK_RULES) {
    if (lowered.includes(needle)) {
      matchedRules.push(label);
    }
  }
  return {
    risky: matchedRules.length > 0,
    matchedRules,
  };
}
