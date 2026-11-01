import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readTlsEnabled, writeTlsEnabled } from '../tls-status.js'

describe('tls/enabled marker', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-enabled-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is on when there is no marker (first boot)', () => {
    expect(readTlsEnabled(dir)).toBe(true)
  })

  it('round-trips off and on', () => {
    writeTlsEnabled(dir, false)
    expect(readTlsEnabled(dir)).toBe(false)
    writeTlsEnabled(dir, true)
    expect(readTlsEnabled(dir)).toBe(true)
  })

  it('only an explicit "false" turns it off — a garbled marker stays on', () => {
    fs.mkdirSync(path.join(dir, 'tls'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'tls', 'enabled'), 'banana\n')
    expect(readTlsEnabled(dir)).toBe(true)
  })
})
