const secretAssignment =
  /\b(OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|GH_TOKEN|AWS_SECRET_ACCESS_KEY)\s*=\s*([^\s]+)/gi;
const bearerToken = /(Authorization\s*:\s*Bearer\s+)([^\s]+)/gi;

export function redactSecrets(value: string): string {
  return value
    .replace(secretAssignment, (_match, name: string) => `${name}=[REDACTED]`)
    .replace(bearerToken, "$1[REDACTED]");
}
