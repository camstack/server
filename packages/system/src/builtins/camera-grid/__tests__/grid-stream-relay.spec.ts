/**
 * The relay, over a REAL loopback socket.
 *
 * The lifecycle claim this addon makes — "the connection opening IS the first
 * consumer, and closing it IS the last one leaving" — is only true if the HTTP
 * layer really wires it that way. A fake server would assert the wiring I
 * wrote, not the wiring node gives me.
 */
import { get, type IncomingMessage } from 'node:http'
import { PassThrough } from 'node:stream'
import { FLV_OPENING } from './flv-fixture.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GridStreamRelay, parseGridStreamPath } from '../grid-stream-relay.js'
import { GridStreamSession } from '../grid-stream-session.js'
import type { GridStreamChild, GridStreamLogger } from '../grid-stream-session.js'

describe('parseGridStreamPath', () => {
  it('reads the instance id AND the profile out of the one path shape it serves', () => {
    expect(parseGridStreamPath('/grid/abc/high.flv')).toEqual({
      profile: 'high',
      instanceId: 'abc',
    })
    expect(parseGridStreamPath('/grid/a%20b/low.flv?x=1')).toEqual({
      profile: 'low',
      instanceId: 'a b',
    })
  })

  it('refuses a dial that names NO profile — there is no default composition', () => {
    // A grid publishes one stream per profile, and "whichever" is how a `low`
    // slot ends up holding a `high` composition.
    expect(parseGridStreamPath('/grid/abc.flv')).toBeNull()
  })

  it('refuses anything else rather than guessing', () => {
    expect(parseGridStreamPath(undefined)).toBeNull()
    expect(parseGridStreamPath('/grid//high.flv')).toBeNull()
    expect(parseGridStreamPath('/grid/abc/ultra.flv')).toBeNull()
    expect(parseGridStreamPath('/grid/abc/high.mjpeg')).toBeNull()
    expect(parseGridStreamPath('/abc/high.flv')).toBeNull()
    expect(parseGridStreamPath('/grid/%E0%A4%A/high.flv')).toBeNull()
  })
})

const silentLogger: GridStreamLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

function fetchStream(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = get(url, resolve)
    req.on('error', reject)
  })
}

describe('GridStreamRelay', () => {
  let relay: GridStreamRelay | null = null

  afterEach(async () => {
    await relay?.dispose()
    relay = null
  })

  it('starts the composition on the first GET and stops it when the socket closes', async () => {
    const stdout = new PassThrough()
    const child: GridStreamChild = { stdout, stop: vi.fn(async () => undefined) }
    const released: string[] = []
    const session = new GridStreamSession({
      deviceId: 900,
      deps: {
        logger: silentLogger,
        acquireSource: async (deviceId) => ({
          url: 'rtsp://x',
          pipelineKey: `pk-${String(deviceId)}`,
        }),
        releaseSource: async (pipelineKey) => {
          released.push(pipelineKey)
        },
        startChild: async () => child,
        lingerMs: 0,
      },
      resolvePlan: () => ({
        layout: {
          width: 640,
          height: 360,
          cells: [
            {
              inputIndex: 0,
              source: { x: 0, y: 0, width: 1, height: 1 },
              cell: { x: 0, y: 0, width: 1, height: 1 },
            },
          ],
        },
        sourceDeviceIds: [611],
        encoder: 'libx264',
        decodeHwAccel: null,
        fps: 10,
        bitrateKbps: 2000,
      }),
    })

    relay = new GridStreamRelay({ logger: silentLogger, sessionFor: () => session })
    await relay.start()
    expect(session.isRunning()).toBe(false)

    const res = await fetchStream(relay.streamUrl({ instanceId: 'inst-1', profile: 'high' }))
    // A real FLV opening, because the session now hands a reader the header,
    // the sequence header and a key frame — never raw bytes off the child.
    stdout.write(FLV_OPENING)
    const first: Buffer = await new Promise((resolve) => res.once('data', resolve))
    expect(first.subarray(0, 3).toString()).toBe('FLV')
    expect(res.headers['content-type']).toBe('video/x-flv')
    expect(session.isRunning()).toBe(true)
    expect(session.consumerCount()).toBe(1)

    res.destroy()
    await vi.waitFor(() => {
      expect(session.consumerCount()).toBe(0)
    })
    await session.settled()
    expect(session.isRunning()).toBe(false)
    expect(released).toEqual(['pk-611'])
  })

  it('answers 404 for a grid it does not know, and says so', async () => {
    const warn = vi.fn()
    relay = new GridStreamRelay({
      logger: { ...silentLogger, warn },
      sessionFor: () => null,
    })
    await relay.start()
    const res = await fetchStream(relay.streamUrl({ instanceId: 'missing', profile: 'high' }))
    expect(res.statusCode).toBe(404)
    // A dial for a withdrawn grid would otherwise retry forever, invisibly.
    expect(warn).toHaveBeenCalled()
  })
})
