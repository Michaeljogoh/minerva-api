/**
 * Heuristic for actions that must call ask_human before execution (§8).
 * Used by agent tools / gateway — not a substitute for model instruction.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /\bsubmit\b/i,
  /\bconfirm\b/i,
  /\bdelete\b/i,
  /\bpayment\b/i,
  /\bpay\b/i,
  /\bcategorize\b/i,
  /\bpost\b/i,
  /\bclear\b/i,
  /\bmatch-?clear\b/i,
  /\bfile(?:\s+\w+){0,2}\s+(?:return|tax|form)\b/i,
  /\bsend(?:\s+payment|\s+transfer|\s+wire|\s+funds)\b/i,
];

export function looksSensitiveAction(text: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(text));
}
