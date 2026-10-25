/**
 * `ParkedFrameClient` — the hub's side of a PARK (D422): send the order to the
 * node that owns the handle, remember where the parcel landed, and answer
 * every later consumer by `(deviceId, trackId, kind)` with no handle in play.
 *
 * Pinned:
 *  - the order goes to `handle.nodeId`, pinned, carrying only the wire fields;
 *  - two orders for one key while the first is in flight collapse to ONE
 *    RPC, and `awaitPark` resolves once it lands — a consumer that fires on
 *    the same frame as the decision reads the parcel, not a race;
 *  - a refusal is `false`, logged with `tags: { deviceId }`, the reason and
 *    the age the node measured — and nothing is retried;
 *  - retrieval is pinned to the node that ANSWERED the park (the mirror),
 *    never re-derived from a frame; a track never parked costs no RPC;
 *  - release drops the parcels on the node and the mirror here.
 */
import type { ParkTrackFrameResult } from '@camstack/types'
import { CAP_NODE_PIN_CONTEXT_KEY } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeLogRecorder } from '../../__tests__/test-helpers.js'
import { createParkedFrameClient } from '../parked-frame-client.js'
import {
  DEVICE_ID,
  HANDLE as handle,
  makeApi,
  NODE_ID,
  parkOrder,
} from './parked-frame-test-helpers.js'

const keyFrameOrder = parkOrder({ trackId: 't-1', kind: 'keyFrame' })
const thumbnailOrder = parkOrder({ trackId: 't-1', kind: 'thumbnail' })

const PARKED = {
  parked: true as const,
  nodeId: NODE_ID,
  width: 3840,
  height: 2160,
  bytes: 1_800_000,
  replaced: false,
}

describe('ParkedFrameClient', () => {
  it('sends the order to the handle’s node, pinned, with only the wire fields', async () => {
    const api = makeApi()
    const rec = makeLogRecorder()
    const client = createParkedFrameClient({ api, logger: rec.logger })
    expect(await client.park(keyFrameOrder)).toBe(true)
    expect(api.park).toHaveBeenCalledTimes(1)
    const [input, opts] = api.park.mock.calls[0] ?? []
    expect(input).toEqual({
      deviceId: DEVICE_ID,
      trackId: 't-1',
      kind: 'keyFrame',
      handle,
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      maxWidth: keyFrameOrder.maxWidth,
      timestamp: 5_000,
    })
    expect(opts).toEqual({ context: { [CAP_NODE_PIN_CONTEXT_KEY]: NODE_ID } })
    // The mirror knows where it landed and what the hub needs to read it.
    expect(client.info('t-1', 'keyFrame')).toMatchObject({
      nodeId: NODE_ID,
      deviceId: DEVICE_ID,
      kind: 'keyFrame',
      timestamp: 5_000,
      width: 3840,
      height: 2160,
      subject: keyFrameOrder.subject,
    })
  })

  it('collapses two orders for one key in flight to ONE RPC, and awaitPark waits for it', async () => {
    let resolvePark: ((r: ParkTrackFrameResult) => void) | undefined
    const api = makeApi({
      park: vi.fn(
        () =>
          new Promise<ParkTrackFrameResult>((resolve) => {
            resolvePark = resolve
          }),
      ),
    })
    const client = createParkedFrameClient({ api, logger: makeLogRecorder().logger })
    const first = client.park(thumbnailOrder)
    const second = client.park(thumbnailOrder)
    let awaited = false
    const waiting = client.awaitPark('t-1', 'thumbnail').then(() => {
      awaited = true
    })
    await new Promise<void>((r) => setImmediate(r))
    expect(api.park).toHaveBeenCalledTimes(1)
    expect(awaited).toBe(false)
    resolvePark?.(PARKED)
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    await waiting
    expect(awaited).toBe(true)
    // Nothing in flight → resolves at once.
    await client.awaitPark('t-1', 'thumbnail')
    await client.awaitPark('nobody', 'keyFrame')
  })

  it('a refusal is false, logged with deviceId + reason + the age the node measured, and never retried', async () => {
    const api = makeApi({
      park: vi.fn(async () => ({
        parked: false,
        nodeId: NODE_ID,
        reason: 'handle-gone',
        handleAgeMs: 4_310,
        detail: 'worker-lease-gone: frame 44 released and no retained tile for this frame',
      })),
    })
    const rec = makeLogRecorder()
    const client = createParkedFrameClient({ api, logger: rec.logger })
    expect(await client.park(keyFrameOrder)).toBe(false)
    expect(api.park).toHaveBeenCalledTimes(1)
    expect(client.info('t-1', 'keyFrame')).toBeUndefined()
    const warns = rec.entries.filter((e) => e.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.message).toMatch(/park refused/)
    expect(warns[0]?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: {
        trackId: 't-1',
        kind: 'keyFrame',
        nodeId: NODE_ID,
        reason: 'handle-gone',
        handleAgeMs: 4_310,
      },
    })
  })

  it('a routing failure (node offline, old runner) is false and a warn — never a throw', async () => {
    const api = makeApi({
      park: vi.fn(async () => {
        throw new Error('pipelineRunner.parkTrackFrame not routable to node agent-a: node-offline')
      }),
    })
    const rec = makeLogRecorder()
    const client = createParkedFrameClient({ api, logger: rec.logger })
    expect(await client.park(keyFrameOrder)).toBe(false)
    const warns = rec.entries.filter((e) => e.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { trackId: 't-1', kind: 'keyFrame', nodeId: NODE_ID },
    })
  })

  it('retrieves by (deviceId, trackId, kind), pinned to the node the PARK answered from', async () => {
    const api = makeApi()
    const client = createParkedFrameClient({ api, logger: makeLogRecorder().logger })
    await client.park(thumbnailOrder)
    const parcel = await client.fetch('t-1', 'thumbnail')
    expect(parcel?.jpeg.toString()).toBe('parcel')
    expect(parcel?.width).toBe(3840)
    expect(parcel?.timestamp).toBe(5_000)
    expect(parcel?.info.layout).toEqual(thumbnailOrder.layout)
    const [input, opts] = api.get.mock.calls[0] ?? []
    // `acceptJpegBytes` is part of the request, not an implementation detail:
    // it is what stops the runner base64-ing a 2.5 MB parcel (D462).
    expect(input).toEqual({
      deviceId: DEVICE_ID,
      trackId: 't-1',
      kind: 'thumbnail',
      acceptJpegBytes: true,
    })
    expect(opts).toEqual({ context: { [CAP_NODE_PIN_CONTEXT_KEY]: NODE_ID } })
  })

  it('a track never parked costs no RPC and answers null', async () => {
    const api = makeApi()
    const client = createParkedFrameClient({ api, logger: makeLogRecorder().logger })
    expect(await client.fetch('nobody', 'keyFrame')).toBeNull()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('a parcel the node no longer holds is a warn with the deviceId, and null', async () => {
    const api = makeApi({ get: vi.fn(async () => null) })
    const rec = makeLogRecorder()
    const client = createParkedFrameClient({ api, logger: rec.logger })
    await client.park(keyFrameOrder)
    expect(await client.fetch('t-1', 'keyFrame')).toBeNull()
    const warns = rec.entries.filter((e) => e.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { trackId: 't-1', kind: 'keyFrame', nodeId: NODE_ID },
    })
  })

  it('release drops the parcels on the node and the mirror here', async () => {
    const api = makeApi()
    const client = createParkedFrameClient({ api, logger: makeLogRecorder().logger })
    await client.park(keyFrameOrder)
    await client.park(thumbnailOrder)
    client.release('t-1')
    await new Promise<void>((r) => setImmediate(r))
    expect(api.rel).toHaveBeenCalledTimes(1)
    const [input, opts] = api.rel.mock.calls[0] ?? []
    expect(input).toEqual({ deviceId: DEVICE_ID, trackId: 't-1' })
    expect(opts).toEqual({ context: { [CAP_NODE_PIN_CONTEXT_KEY]: NODE_ID } })
    expect(client.info('t-1', 'keyFrame')).toBeUndefined()
    expect(await client.fetch('t-1', 'thumbnail')).toBeNull()
    expect(api.get).not.toHaveBeenCalled()
    // Releasing a track never parked is a no-op — no RPC.
    client.release('nobody')
    await new Promise<void>((r) => setImmediate(r))
    expect(api.rel).toHaveBeenCalledTimes(1)
  })

  it('dispatches NOTHING at a node the registry already called offline — not a park, not a retrieval', async () => {
    const api = makeApi()
    const rec = makeLogRecorder()
    let offline = false
    const client = createParkedFrameClient({
      api,
      logger: rec.logger,
      isNodeOffline: (nodeId) => offline && nodeId === NODE_ID,
    })
    await client.park(keyFrameOrder)
    offline = true
    expect(await client.park(thumbnailOrder)).toBe(false)
    expect(api.park).toHaveBeenCalledTimes(1)
    expect(await client.fetch('t-1', 'keyFrame')).toBeNull()
    expect(api.get).not.toHaveBeenCalled()
    const warns = rec.entries.filter((e) => e.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { trackId: 't-1', kind: 'keyFrame', nodeId: NODE_ID },
    })
  })

  it('a runner without the park methods (version skew) refuses locally, once per camera per window', async () => {
    const rec = makeLogRecorder()
    const client = createParkedFrameClient({ api: undefined, logger: rec.logger })
    expect(await client.park(keyFrameOrder)).toBe(false)
    expect(await client.park(thumbnailOrder)).toBe(false)
    expect(await client.fetch('t-1', 'keyFrame')).toBeNull()
    const warns = rec.entries.filter((e) => e.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.extras).toMatchObject({ tags: { deviceId: DEVICE_ID } })
  })
})
