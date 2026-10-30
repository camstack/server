/** Redact secrets and credential paths from tool outputs before they leave the MCP. */

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bglsa_[A-Za-z0-9_-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+=/]{20,}\b/gi,
  /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^\s'"]{8,}/gi,
  /(?:\/Users\/[^/\s]+\/\.camstack\/[^\s'"]+)/g,
  /(?:~\/\.camstack\/[^\s'"]+)/g,
]

export function scrubSecrets(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]')
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubSecrets(value)
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((v) => scrubValue(v))
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const keyLower = k.toLowerCase()
      // `confirm_token` is the mutation gate's one-shot, argument-bound,
      // short-lived handle — the operator must be able to read it back.
      if (k === 'confirm_token') {
        out[k] = v
      } else if (
        keyLower.includes('token') ||
        keyLower.includes('password') ||
        keyLower.includes('secret') ||
        keyLower === 'authorization'
      ) {
        out[k] = '[REDACTED]'
      } else {
        out[k] = scrubValue(v)
      }
    }
    return out
  }
  return value
}
