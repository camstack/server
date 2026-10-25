/**
 * Canary: drive a named-tunnel start → exit through CloudflareTunnelService
 * with a recognisable token, and prove the token reaches neither argv, nor
 * the child's environment, nor any log line — only a 0600 file that is gone
 * once the child has exited (D783).
 */
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnCalls: Array<{ cmd: string; args: readonly string[]; opts: unknown }> = []
let lastChild: (EventEmitter & { pid: number; kill: () => boolean; killed: boolean }) | null = null

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: readonly string[], opts: unknown) => {
    spawnCalls.push({ cmd, args, opts })
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      killed: false,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    })
    lastChild = child
    return child
  },
}))

const { CloudflareTunnelService } = await import('../cloudflare-tunnel.js')

const CANARY = 'CANARY-TUNNEL-TOKEN-7f3e9a1c55d0'

function recordingLogger() {
  const lines: string[] = []
  const rec =
    (level: string) =>
    (msg: string, extra?: unknown): void => {
      lines.push(`${level} ${msg} ${JSON.stringify(extra ?? {})}`)
    }
  const logger = {
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    debug: rec('debug'),
    child: () => logger,
  }
  return { logger, lines }
}

describe('CloudflareTunnelService — tunnel token canary', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-canary-'))
    spawnCalls.length = 0
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the token out of argv, env and logs; the token file dies with the child', async () => {
    const { logger, lines } = recordingLogger()
    const runDir = path.join(dir, 'run')
    const service = new CloudflareTunnelService(
      {
        mode: 'custom',
        localPort: 4443,
        localPortMode: 'default',
        localHost: '127.0.0.1',
        noTLSVerify: true,
        originServerName: '',
        httpHostHeader: '',
        customAccountId: 'acc',
        customTunnelId: 'tid',
        customTunnelToken: CANARY,
        customZoneId: 'z',
        customZoneName: 'example.com',
        customDnsRecordId: 'r',
        customHostname: 'cam.example.com',
        customApiToken: '',
        debugLogging: false,
        protocol: 'auto',
      } as never,
      logger as never,
      { emit: () => undefined } as never,
      async () => 'cloudflared',
      runDir,
    )

    await service.start()
    expect(spawnCalls).toHaveLength(1)
    const call = spawnCalls[0]!
    expect(call.args.join(' ')).not.toContain(CANARY)
    expect(JSON.stringify(call.opts)).not.toContain(CANARY)
    const tokenFile = call.args[call.args.indexOf('--token-file') + 1]!
    expect(fs.readFileSync(tokenFile, 'utf8')).toBe(CANARY)

    // stop() → the (fake) child exits → the token file is removed.
    const stopped = service.stop()
    lastChild!.emit('exit', 0, 'SIGTERM')
    await stopped
    expect(fs.existsSync(tokenFile)).toBe(false)

    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toContain(CANARY)
  })

  it('a crash removes the token file before the backoff respawn rewrites it', async () => {
    vi.useFakeTimers()
    try {
      const { logger, lines } = recordingLogger()
      const runDir = path.join(dir, 'run')
      const service = new CloudflareTunnelService(
        {
          mode: 'custom',
          localPort: 4443,
          localHost: '127.0.0.1',
          noTLSVerify: true,
          originServerName: '',
          customTunnelToken: CANARY,
          customHostname: 'cam.example.com',
          debugLogging: false,
          protocol: 'auto',
        } as never,
        logger as never,
        { emit: () => undefined } as never,
        async () => 'cloudflared',
        runDir,
      )
      await service.start()
      const tokenFile = spawnCalls[0]!.args.at(-1)!
      lastChild!.emit('exit', 1, null)
      expect(fs.existsSync(tokenFile)).toBe(false)
      await vi.advanceTimersByTimeAsync(2_500)
      expect(spawnCalls).toHaveLength(2)
      expect(fs.readFileSync(tokenFile, 'utf8')).toBe(CANARY)
      for (const line of lines) expect(line).not.toContain(CANARY)
    } finally {
      vi.useRealTimers()
    }
  })
})
