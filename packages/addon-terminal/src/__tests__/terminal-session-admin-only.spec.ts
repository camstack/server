/**
 * The terminal is admin-only (#553): every `terminal-session` method — the
 * node shell's open, write, pull and close included — is gated on the admin
 * role in the generated access map the hub enforces. A method added without
 * `auth: 'admin'` fails here.
 */
import { METHOD_ACCESS_MAP, terminalSessionCapability } from '@camstack/types'
import { describe, expect, it } from 'vitest'

describe('terminal-session access', () => {
  const methodNames = Object.keys(terminalSessionCapability.methods)

  it('declares the node shell methods it gates', () => {
    expect(methodNames).toEqual(
      expect.arrayContaining([
        'openSession',
        'writeInput',
        'pullOutput',
        'close',
        'serverShellStatus',
      ]),
    )
  })

  it.each(methodNames)('requires the admin role for %s', (methodName) => {
    expect(METHOD_ACCESS_MAP[`terminalSession.${methodName}`]?.role).toBe('admin')
  })
})
