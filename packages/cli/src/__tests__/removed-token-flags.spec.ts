import { parseArgs } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  assertNoRemovedTokenFlags,
  REMOVED_TOKEN_FLAG_OPTIONS,
  RemovedTokenFlagError,
} from '../commands/removed-token-flags.js'

function parse(args: readonly string[]): Record<string, string | boolean | undefined> {
  const { values } = parseArgs({
    args: [...args],
    options: { server: { type: 'string', short: 's' }, ...REMOVED_TOKEN_FLAG_OPTIONS },
    strict: true,
    allowPositionals: true,
  })
  return values
}

// D1101: the `camstack login` session is the only client credential.
describe('removed token flags', () => {
  it('a command without them passes', () => {
    expect(() => assertNoRemovedTokenFlags(parse(['-s', 'hub.lan']))).not.toThrow()
  })

  it.each([
    ['--token', 'abc'],
    ['-t', 'abc'],
    ['--token-file', '/tmp/x'],
  ])('%s fails with a "removed, use camstack login" message instead of an unknown option', (flag, v) => {
    const values = parse([flag, v])
    expect(() => assertNoRemovedTokenFlags(values)).toThrow(RemovedTokenFlagError)
    expect(() => assertNoRemovedTokenFlags(values)).toThrow(/removed/)
    expect(() => assertNoRemovedTokenFlags(values)).toThrow(/camstack login <host>/)
  })

  it('never echoes the value it was given', () => {
    const values = parse(['--token', 'secret-value-123'])
    try {
      assertNoRemovedTokenFlags(values)
    } catch (err) {
      expect(String(err)).not.toContain('secret-value-123')
    }
  })
})
