/**
 * D860 — the tunnel says whether its address survives a restart. A Quick
 * tunnel's random `*.trycloudflare.com` does not, so every address it announces
 * (the endpoint and the `network.tunnel.started` event `local-network` tails)
 * is `stable: false`; a named tunnel is `stable: true`.
 */
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let lastChild: (EventEmitter & { stdout: PassThrough; stderr: PassThrough }) | null = null

vi.mock('node:child_process', () => ({
  spawn: () => {
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

interface Emitted {
  readonly category: string
  readonly data: { readonly url: string; readonly stable?: boolean }
}

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => logger,
}

function build(mode: 'quick' | 'custom', dir: string, events: Emitted[]) {
  return new CloudflareTunnelService(
    {
      mode,
      localPort: 4443,
      localHost: '127.0.0.1',
      noTLSVerify: true,
      originServerName: '',
      customTunnelToken: 'token',
      customHostname: 'cam.example.com',
      debugLogging: false,
      protocol: 'auto',
    } as never,
    logger as never,
    { emit: (event: Emitted) => events.push(event) } as never,
    async () => 'cloudflared',
    path.join(dir, 'run'),
  )
}

describe('CloudflareTunnelService — address stability', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-stable-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a Quick tunnel announces its random URL as unstable, placeholder and real', async () => {
    const events: Emitted[] = []
    const service = build('quick', dir, events)
    const endpoint = await service.start()
    expect(endpoint.stable).toBe(false)

    lastChild!.stdout.write('INF |  https://random-words-here.trycloudflare.com  |\n')
    await new Promise((resolve) => setImmediate(resolve))

    const started = events.filter((e) => e.category === 'network.tunnel.started')
    expect(started.length).toBeGreaterThanOrEqual(2)
    expect(started.every((e) => e.data.stable === false)).toBe(true)
    expect(started.at(-1)?.data.url).toBe('https://random-words-here.trycloudflare.com')
  })

  it('a named tunnel announces its hostname as stable', async () => {
    const events: Emitted[] = []
    const endpoint = await build('custom', dir, events).start()
    expect(endpoint.stable).toBe(true)
    expect(events.find((e) => e.category === 'network.tunnel.started')?.data).toEqual({
      url: 'https://cam.example.com',
      stable: true,
    })
  })
})
