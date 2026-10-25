/**
 * The guard that keeps OAuth client secrets out of published packages (D753).
 *
 * Every secret-shaped fixture below is ASSEMBLED AT RUNTIME, so this spec file
 * never contains a value the guard (or a secret scanner) would flag.
 */
import { describe, expect, it } from 'vitest'

import { findClientSecrets, scanRepo } from '../check-no-client-secrets.js'

const hex = (n: number): string => 'a1b2c3d4e5f60718'.repeat(Math.ceil(n / 16)).slice(0, n)
const lwaSecret = (): string => ['amzn1', 'oa2-cs', 'v1', hex(64)].join('.')

describe('findClientSecrets', () => {
  it('catches the exact shape public-skill.ts carried', () => {
    const text = `export const PUBLIC_LWA_CLIENT_SECRET =\n  '${lwaSecret()}'\n`
    expect(findClientSecrets('x.ts', text)).toEqual([
      { file: 'x.ts', line: 2, pattern: 'lwa-client-secret' },
    ])
  })

  it('catches a Google OAuth client secret', () => {
    const text = `const s = '${'GOCSPX'}-${'Abc123_-'.repeat(4)}'`
    expect(findClientSecrets('g.ts', text).map((f) => f.pattern)).toEqual([
      'google-oauth-client-secret',
    ])
  })

  it('catches any client_secret / clientSecret assigned a long literal', () => {
    const value = hex(40)
    for (const line of [
      `clientSecret: '${value}'`,
      `client_secret = "${value}"`,
      `"client_secret": "${value}"`,
      `CLIENT-SECRET=\`${value}\``,
    ]) {
      expect(findClientSecrets('c.ts', line).map((f) => f.pattern)).toContain(
        'client-secret-literal',
      )
    }
  })

  it('does not flag placeholders, short fixtures, or reads from config', () => {
    for (const line of [
      "clientSecret: 's'",
      "lwaClientSecret: ''",
      "client_secret: '<your client secret>'",
      'params.set("client_secret", creds.clientSecret)',
      'clientSecret: secret.clientSecret',
      'amzn1.oa2-cs.v1.<hex>',
    ]) {
      expect(findClientSecrets('p.ts', line)).toEqual([])
    }
  })

  it('never reports the matched value itself', () => {
    const findings = findClientSecrets('x.ts', `k = '${lwaSecret()}'`)
    expect(JSON.stringify(findings)).not.toContain(hex(32))
  })
})

describe('the repository', () => {
  // The fail-without-fix test: before D753 this found
  // packages/addon-export-alexa/src/public-skill.ts.
  it('has no client-secret-shaped value in any publishable package', () => {
    expect(scanRepo(process.cwd())).toEqual([])
  }, 60_000)
})
