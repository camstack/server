import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendShellLog, formatFatal } from '../shell-log'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-log-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('appendShellLog', () => {
  it('appends one timestamped line per call', () => {
    const file = path.join(dir, 'shell.log')
    appendShellLog(file, 'first', { maxBytes: 1_000, now: () => 0 })
    appendShellLog(file, 'second', { maxBytes: 1_000, now: () => 0 })
    expect(fs.readFileSync(file, 'utf-8')).toBe(
      '1970-01-01T00:00:00.000Z first\n1970-01-01T00:00:00.000Z second\n',
    )
  })

  it('rotates to one previous file once the bound is exceeded, so the log stays bounded', () => {
    const file = path.join(dir, 'shell.log')
    for (let i = 0; i < 50; i += 1) {
      appendShellLog(file, `line ${i} ${'x'.repeat(40)}`, {
        maxBytes: 500,
        now: () => 0,
      })
    }
    expect(fs.existsSync(`${file}.1`)).toBe(true)
    expect(fs.statSync(file).size).toBeLessThan(500 + 100)
    expect(fs.readFileSync(file, 'utf-8')).toContain('line 49')
  })

  it('never throws, even when the directory cannot be written', () => {
    expect(() =>
      appendShellLog(path.join(dir, 'missing', 'deeper', 'x.log'), 'x', {
        maxBytes: 10,
      }),
    ).not.toThrow()
  })
})

describe('formatFatal', () => {
  it('keeps the stack of an Error and stringifies anything else', () => {
    expect(formatFatal('uncaughtException', new Error('boom'))).toContain('Error: boom')
    expect(formatFatal('unhandledRejection', 'plain')).toBe('unhandledRejection: plain')
  })
})
