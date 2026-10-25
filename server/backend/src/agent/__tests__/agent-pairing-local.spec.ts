/**
 * Where the PIN and the reset code are shown (D857): the console and 0600 files, nowhere the network
 * can read. A stale PIN file from a previous run is removed at boot (N4).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createLocalPairingAnnouncer,
  PAIRING_PIN_FILE,
  PAIRING_RESET_FILE,
} from '../agent-pairing-local.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pairing-local-'))
  dirs.push(d)
  return d
}

const secret = {
  pairingId: 'p1',
  pin: '12345678',
  code: '654321',
  hub: { nodeId: 'hub', url: 'https://hub.example.test', caFingerprint: 'ab'.repeat(32) },
  expiresAt: Date.now() + 60_000,
}

describe('local pairing announcer', () => {
  it('removes a stale PIN file at boot', () => {
    const dir = tmp()
    const file = path.join(dir, PAIRING_PIN_FILE)
    fs.writeFileSync(file, 'PIN: 99999999\n')
    createLocalPairingAnnouncer(dir, { warn: () => undefined })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('writes the PIN to a 0600 file and the console, and removes it when the pairing ends', () => {
    const dir = tmp()
    const lines: string[] = []
    const a = createLocalPairingAnnouncer(dir, { warn: (m) => lines.push(m) })
    a.onSecret(secret)
    const file = path.join(dir, PAIRING_PIN_FILE)
    expect(fs.readFileSync(file, 'utf8')).toContain('12345678')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(lines.join('\n')).toContain('12345678')
    a.onCleared('p1')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('writes the reset code to a 0600 file and the console', () => {
    const dir = tmp()
    const lines: string[] = []
    const a = createLocalPairingAnnouncer(dir, { warn: (m) => lines.push(m) })
    a.onResetCode('87654321')
    const file = path.join(dir, PAIRING_RESET_FILE)
    expect(fs.readFileSync(file, 'utf8').trim()).toBe('87654321')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(lines.join('\n')).toContain('87654321')
  })
})
