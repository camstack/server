import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  causeOfStderrLine,
  lastCauseAfterChunk,
  readRunnerDisplayName,
} from '../runner-failure-info.js'

describe('runner failure info', () => {
  it('extracts the cause out of the runner Init failed line', () => {
    expect(causeOfStderrLine('[addon-runner] Init failed for "core-block-abc": fetch failed')).toBe(
      'fetch failed',
    )
  })

  it('an Init failed line outranks the noise that follows it', () => {
    const cause = lastCauseAfterChunk(
      undefined,
      '[addon-runner] Init failed for "core-block-abc": fetch failed\nEXIT code=1\n',
    )
    expect(cause?.text).toBe('fetch failed')
  })

  it('a credential in the stderr cause is redacted before it travels', () => {
    const cause = lastCauseAfterChunk(undefined, 'Error: spawn failed --token abc123secret\n')
    expect(cause?.text).not.toContain('abc123secret')
  })

  it('without an Init failed line the last stderr line is the cause', () => {
    expect(
      lastCauseAfterChunk({ text: 'old', fromInit: false }, 'a\nTypeError: boom\n')?.text,
    ).toBe('TypeError: boom')
  })

  it('reads the display name from the package manifest, and nothing when unreadable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-name-'))
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        camstack: { addons: [{ id: 'core-block-abc', name: 'Programmazione TV' }] },
      }),
    )
    expect(readRunnerDisplayName([dir], 'core-block-abc')).toBe('Programmazione TV')
    expect(readRunnerDisplayName([path.join(dir, 'missing')], 'x')).toBeUndefined()
  })
})
