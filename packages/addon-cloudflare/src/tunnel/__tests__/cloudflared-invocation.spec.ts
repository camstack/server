/**
 * The named-tunnel token is a bearer credential for the whole tunnel. On
 * argv it is visible to every process on the host (`ps`, /proc/<pid>/cmdline)
 * and the spawn log line used to carry `args.join(' ')`, which put the token
 * in /data/logs and Loki. It must not travel through the environment either
 * (operator rule: no secret in env, ever). cloudflared ≥ 2025.4.0 reads it
 * from `--token-file`, a 0600 file the addon writes right before the spawn
 * and deletes when the child exits.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildCloudflaredArgs,
  parseCloudflaredVersion,
  removeTokenFile,
  supportsTokenFile,
  writeTokenFile,
} from '../cloudflared-invocation.js'

const CANARY = 'eyJhIjoiQ0FOQVJZLVRVTk5FTC1UT0tFTi0wMDAwMDAwMDAwIn0='
const TOKEN_FILE = '/data/addons-data/cloudflare-tunnel/run/tunnel-token'

const base = {
  debugLogging: false,
  protocol: 'auto' as const,
  localHost: '127.0.0.1',
  localPort: 4443,
  noTLSVerify: true,
  originServerName: '',
}

describe('buildCloudflaredArgs', () => {
  it('points a named tunnel at the token file — the token itself is never on argv', () => {
    const args = buildCloudflaredArgs({ ...base, mode: 'custom' }, TOKEN_FILE)
    expect(args).toEqual(['tunnel', 'run', '--token-file', TOKEN_FILE])
    expect(args).not.toContain('--token')
  })

  it('keeps global flags before the sub-command and the protocol flag after it', () => {
    const args = buildCloudflaredArgs(
      { ...base, mode: 'custom', debugLogging: true, protocol: 'http2' },
      TOKEN_FILE,
    )
    expect(args).toEqual([
      '--loglevel',
      'debug',
      '--transport-loglevel',
      'debug',
      'tunnel',
      '--protocol',
      'http2',
      'run',
      '--token-file',
      TOKEN_FILE,
    ])
  })

  it('a quick tunnel carries no token file', () => {
    expect(buildCloudflaredArgs({ ...base, mode: 'quick' }, null)).toEqual([
      'tunnel',
      '--no-tls-verify',
      '--url',
      'https://127.0.0.1:4443',
    ])
  })

  it('refuses a named tunnel without a token file instead of falling back to argv', () => {
    expect(() => buildCloudflaredArgs({ ...base, mode: 'custom' }, null)).toThrow(/token file/)
  })
})

describe('token file', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-token-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is written owner-only (0600) in an owner-only dir, and removed afterwards', () => {
    const runDir = path.join(dir, 'run')
    const file = writeTokenFile(runDir, CANARY)
    expect(fs.readFileSync(file, 'utf8')).toBe(CANARY)
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(fs.statSync(runDir).mode & 0o777).toBe(0o700)
    }
    removeTokenFile(file)
    expect(fs.existsSync(file)).toBe(false)
    // idempotent: a second removal (exit after stop) is not an error
    expect(() => removeTokenFile(file)).not.toThrow()
  })

  it('tightens a pre-existing file left by a crash back to 0600', () => {
    const runDir = path.join(dir, 'run')
    fs.mkdirSync(runDir, { recursive: true })
    const stale = path.join(runDir, 'tunnel-token')
    fs.writeFileSync(stale, 'old', { mode: 0o644 })
    const file = writeTokenFile(runDir, CANARY)
    expect(file).toBe(stale)
    expect(fs.readFileSync(file, 'utf8')).toBe(CANARY)
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('cloudflared version gate', () => {
  it('parses `cloudflared --version` output', () => {
    expect(
      parseCloudflaredVersion('cloudflared version 2025.4.2 (built 2025-04-30-1234 UTC)'),
    ).toEqual([2025, 4, 2])
    expect(parseCloudflaredVersion('garbage')).toBeNull()
  })

  it('--token-file exists from 2025.4.0 on', () => {
    expect(supportsTokenFile([2025, 4, 0])).toBe(true)
    expect(supportsTokenFile([2025, 4, 2])).toBe(true)
    expect(supportsTokenFile([2026, 1, 0])).toBe(true)
    expect(supportsTokenFile([2025, 2, 1])).toBe(false)
    expect(supportsTokenFile([2024, 12, 9])).toBe(false)
    expect(supportsTokenFile(null)).toBe(false)
  })
})
