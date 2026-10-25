/**
 * The gate every ops call passes before a byte leaves the machine:
 * query-only, tier-checked, and never a credential-bearing method.
 */
import type { CredentialTier } from '@camstack/develop'
import type { ApiIndex, ApiMethod } from './api-index.js'

export type GateDecision =
  | { readonly allowed: true; readonly method: ApiMethod }
  | { readonly allowed: false; readonly reason: string }

/**
 * Methods that return secret material even though they are `query` and
 * admin-gated: the keychain's plaintext resolver and reveal, a camera's
 * credentials, anything named for a secret. The ops toolset never reads them
 * (D783: a tool, like a log line, is not a place a secret may land).
 */
const SECRET_BEARING_ROUTERS: ReadonlySet<string> = new Set(['keychain', 'keychainAdmin'])
const SECRET_BEARING_NAME = /secret|password|passphrase|recoverykey|reveal|getcredentials|jwt/i

export function isSecretBearing(methodPath: string): boolean {
  const [router = '', ...rest] = methodPath.split('.')
  if (SECRET_BEARING_ROUTERS.has(router)) return true
  return SECRET_BEARING_NAME.test(rest.join('.'))
}

export function gateQuery(index: ApiIndex, methodPath: string, tier: CredentialTier): GateDecision {
  const method = index.get(methodPath)
  if (!method) {
    return {
      allowed: false,
      reason: `${methodPath} is not in the generated API index (docs/reference/api.md) — check the path, or run \`npm run docs:generate\` if it is new.`,
    }
  }
  if (method.kind !== 'query') {
    return {
      allowed: false,
      reason: `${methodPath} is a ${method.kind}; the ops toolset is read-only and only calls queries.`,
    }
  }
  if (isSecretBearing(methodPath)) {
    return {
      allowed: false,
      reason: `${methodPath} returns secret material; the ops toolset never reads it.`,
    }
  }
  if (method.auth === 'admin' && tier !== 'admin') {
    return {
      allowed: false,
      reason: `${methodPath} is admin-tier and this credential is not admin-scoped. Log in with an admin account via \`camstack login\`.`,
    }
  }
  return { allowed: true, method }
}
