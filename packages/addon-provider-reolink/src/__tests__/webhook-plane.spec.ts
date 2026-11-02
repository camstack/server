import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mapBaichuanWebhookToSimpleEvents, type ReolinkSimpleEvent } from '@apocaliss92/nodelink-js'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWebhookHandler,
  WEBHOOK_MAX_BODY_BYTES,
  type WebhookCamera,
} from '../webhook-plane.js'

interface LogCall {
  readonly level: string
  readonly message: string
  readonly options: { readonly tags?: Record<string, unknown> } | undefined
}

function fakeLogger(calls: LogCall[]): IScopedLogger {
  const at =
    (level: string) =>
    (message: string, options?: { readonly tags?: Record<string, unknown> }): void => {
      calls.push({ level, message, options })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function fakeCamera(id: number, stableId: string, eligible = true) {
  const events: ReolinkSimpleEvent[] = []
  const camera: WebhookCamera = {
    id,
    stableId,
    isEmailPushEligible: eligible,
    emailPushChannel: 3,
    handleSimpleEvent: (e) => {
      events.push(e)
    },
  }
  return { camera, events }
}

let server: Server | undefined
afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
  server = undefined
})

async function plane(cameras: readonly WebhookCamera[]) {
  const logs: LogCall[] = []
  const handler = createWebhookHandler({ logger: fakeLogger(logs), listCameras: () => cameras })
  server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  const send = (path: string, init: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init)
  return { logs, send }
}

describe('webhook plane', () => {
  it('maps a wake/pir body to simple events on the camera, tagged webhook', async () => {
    const { camera, events } = fakeCamera(7, 'mac-aa')
    const { send } = await plane([camera])
    const res = await send('/mac-aa', {
      method: 'POST',
      body: JSON.stringify({ event: 'wake', reason: 'pir' }),
    })
    expect(res.status).toBe(200)
    const expected = mapBaichuanWebhookToSimpleEvents({ event: 'wake', reason: 'pir' })
    expect(expected.length).toBeGreaterThan(0)
    expect(events.map((e) => e.type)).toEqual(expected)
    expect(events.every((e) => e.source === 'baichuanWebhook' && e.channel === 3)).toBe(true)
  })

  it('accepts PUT and a percent-encoded stable id', async () => {
    const { camera, events } = fakeCamera(8, 'cam/x')
    const { send } = await plane([camera])
    const res = await send('/cam%2Fx', {
      method: 'PUT',
      body: JSON.stringify({ event: 'sleep' }),
    })
    expect(res.status).toBe(200)
    expect(events.length).toBeGreaterThan(0)
  })

  it('an unknown stable id is a 404, dispatches nothing and says so in the log', async () => {
    const { camera, events } = fakeCamera(7, 'mac-aa')
    const { send, logs } = await plane([camera])
    const res = await send('/nobody', { method: 'POST', body: '{"event":"wake"}' })
    expect(res.status).toBe(404)
    expect(events).toEqual([])
    const line = logs.find((l) => l.level === 'warn')
    expect(line?.message).toContain('unknown')
  })

  it('an ineligible camera is a 404 and the log line carries its deviceId', async () => {
    const { camera, events } = fakeCamera(9, 'hub-child', false)
    const { send, logs } = await plane([camera])
    const res = await send('/hub-child', { method: 'POST', body: '{"event":"wake"}' })
    expect(res.status).toBe(404)
    expect(events).toEqual([])
    expect(logs.find((l) => l.level === 'warn')?.options?.tags).toEqual({ deviceId: 9 })
  })

  it('refuses a method that is not POST/PUT, a body over 64 KiB and a body that is not a payload', async () => {
    const { camera, events } = fakeCamera(7, 'mac-aa')
    const { send } = await plane([camera])
    expect((await send('/mac-aa', { method: 'GET' })).status).toBe(405)
    const big = JSON.stringify({ event: 'wake', pad: 'x'.repeat(WEBHOOK_MAX_BODY_BYTES) })
    const bigRes = await send('/mac-aa', { method: 'POST', body: big }).catch(() => null)
    // the plane may cut the socket after the 413; either way nothing was dispatched
    if (bigRes !== null) expect(bigRes.status).toBe(413)
    expect((await send('/mac-aa', { method: 'POST', body: 'not json' })).status).toBe(400)
    expect(events).toEqual([])
  })

  it('a command-shaped body is acknowledged and ignored', async () => {
    const { camera, events } = fakeCamera(7, 'mac-aa')
    const { send } = await plane([camera])
    const res = await send('/mac-aa', {
      method: 'POST',
      body: JSON.stringify({ cmd: 33, xml: '<x/>' }),
    })
    expect(res.status).toBe(202)
    expect(events).toEqual([])
  })
})
