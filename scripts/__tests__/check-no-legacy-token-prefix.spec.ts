import { describe, expect, it } from 'vitest'
import { ALLOWED_FILES, findLegacyTokenPrefixes, inScope } from '../check-no-legacy-token-prefix.js'

// The retired prefixes, spelled from parts: this spec is in the guard's scope too.
const ADMIN = ['cs', 'a_'].join('')
const SCOPED = ['cs', 't_'].join('')
const SHARE = ['cs', 'v_'].join('')

describe('check-no-legacy-token-prefix', () => {
  it('flags each retired prefix — in code, in a fixture, in a comment', () => {
    const old = [
      `if (bearer.startsWith('${ADMIN}')) return legacyAdminToken(bearer)`,
      `const TOKEN_PREFIX = '${SCOPED}'`,
      ` * a \`${SHARE}*\` share link carried in the #t= fragment`,
      `token: '${SCOPED}session',`,
    ].join('\n')
    expect(findLegacyTokenPrefixes('x.ts', old).map((f) => f.line)).toEqual([1, 2, 3, 4])
  })

  it('lets the refresh token, look-alike identifiers and the one format through', () => {
    const fine = [
      "const REFRESH_TOKEN_PREFIX = 'csr_'",
      'const metrics_csv_export = toCsv(rows)',
      "const kind = 'credential' // auth.mintToken",
      "auth.signCredentialToken({ kind: 'credential', sub, jti, scopes })",
    ].join('\n')
    expect(findLegacyTokenPrefixes('x.ts', fine)).toEqual([])
  })

  it('reads every authored source, not prose or built bundles', () => {
    expect(inScope('server/backend/src/auth/credential-verifier.ts')).toBe(true)
    expect(inScope('scripts/dev-cluster.sh')).toBe(true)
    expect(inScope('packages/addon-admin-ui/src/components/access/Tokens.tsx')).toBe(true)
    expect(inScope('docs/decisions/adr-0892.md')).toBe(false)
    expect(inScope('releases/v1.1.53.json')).toBe(false)
    expect(inScope('packages/addon-pipeline-orchestrator/assets/viewer/_expo/x.js')).toBe(false)
    expect(inScope('packages/cli/dist/cli.js')).toBe(false)
  })

  it('the allowlist is empty, by decision (D895)', () => {
    expect(ALLOWED_FILES).toEqual([])
  })
})
