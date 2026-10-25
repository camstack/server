/**
 * `camstack login --admin` / `--admin-days` are gone (D895: one login, one
 * token). An old invocation still parses, so a script does not break, but it is
 * told in one line that the flag does nothing instead of being silently ignored.
 */
import { parseArgs } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  LEGACY_LOGIN_FLAG_OPTIONS,
  legacyLoginFlagWarnings,
} from '../commands/login-legacy-flags.js'

describe('camstack login legacy --admin / --admin-days', () => {
  it('still parses in strict mode, so an old script does not abort', () => {
    expect(() =>
      parseArgs({
        args: ['--admin', '--admin-days', '7', '192.0.2.20'],
        options: {
          ...LEGACY_LOGIN_FLAG_OPTIONS,
          server: { type: 'string', short: 's' },
        },
        allowPositionals: true,
        strict: true,
      }),
    ).not.toThrow()
  })

  it('warns once per legacy flag, naming the one-login rule', () => {
    const warnings = legacyLoginFlagWarnings({
      admin: true,
      'admin-days': '7',
    })
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('one login, one token — drop --admin')
    expect(warnings[1]).toContain('--admin-days')
  })

  it('says nothing for a plain login', () => {
    expect(legacyLoginFlagWarnings({ server: 'hub.local' })).toEqual([])
  })
})
