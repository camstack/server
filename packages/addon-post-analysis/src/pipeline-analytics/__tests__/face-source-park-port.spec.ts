/**
 * The face source park (D644): the NEWEST best face's frame is the one the
 * node keeps, even when the held face improves while a park is in flight —
 * the parcel client joins a second order for a busy key, which would leave
 * the older frame parked. And a parcel whose park lands after the track
 * closed is released anyway.
 */
import type { FrameHandle, ParkedFrameKind } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { FaceSourceParkOrder } from '../face-source-frame.js'
import type { ParkOrder } from '../pipeline/track-park.js'
import type {
  ParkedFrameClient,
  ParkedParcel,
  ParkedParcelInfo,
} from '../runtime/parked-frame-client.js'
import {
  createFaceSourceParkPort,
  FACE_SOURCE_PARK_PREFIX,
  toParkOrder,
} from '../runtime/face-source-park-port.js'

function handle(seq: number): FrameHandle {
  return {
    shmId: 's',
    slot: 0,
    seq,
    width: 640,
    height: 360,
    format: 'rgb',
    pts: seq,
    byteLength: 1,
    nodeId: 'hub',
    slotCount: 4,
  }
}

function order(timestamp: number): FaceSourceParkOrder {
  return {
    deviceId: 101,
    trackId: 't1',
    frameHandle: handle(timestamp),
    geometry: { timestamp, bbox: { x: 1, y: 2, w: 3, h: 4 }, frameWidth: 640, frameHeight: 360 },
  }
}

interface ClientFake {
  readonly client: ParkedFrameClient
  readonly sent: ParkOrder[]
  readonly released: string[]
  /** Resolve the oldest park still in flight. */
  land(): void
}

function clientFake(): ClientFake {
  const pending: Array<() => void> = []
  const parked = new Map<string, ParkOrder>()
  const f: ClientFake = {
    sent: [],
    released: [],
    land: () => pending.shift()?.(),
    client: {
      park: (o) => {
        f.sent.push(o)
        return new Promise<boolean>((resolve) => {
          pending.push(() => {
            parked.set(o.trackId, o)
            resolve(true)
          })
        })
      },
      awaitPark: async () => undefined,
      info: (trackId: string, kind: ParkedFrameKind): ParkedParcelInfo | undefined => {
        const o = parked.get(trackId)
        return o === undefined
          ? undefined
          : {
              nodeId: 'hub',
              deviceId: o.deviceId,
              kind,
              timestamp: o.timestamp,
              width: 3840,
              height: 2160,
              subject: o.subject,
            }
      },
      fetch: async (trackId: string, kind: ParkedFrameKind): Promise<ParkedParcel | null> => {
        const info = f.client.info(trackId, kind)
        return info === undefined
          ? null
          : { jpeg: Buffer.from('x'), width: 3840, height: 2160, timestamp: info.timestamp, info }
      },
      release: (trackId) => {
        f.released.push(trackId)
      },
      adopt: () => undefined,
      dispose: () => undefined,
    },
  }
  return f
}

const logger = { debug: () => undefined }

describe('the face source park port', () => {
  it('parks a whole frame at the native cap under its own key', () => {
    const o = toParkOrder(order(100))
    expect(o.trackId).toBe(`${FACE_SOURCE_PARK_PREFIX}t1`)
    expect(o.kind).toBe('keyFrame')
    expect(o.bbox).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('a newer best parked while one is in flight is sent AFTER it — the node ends on the newest', async () => {
    const f = clientFake()
    const port = createFaceSourceParkPort({
      client: () => f.client,
      isNodeOffline: () => false,
      logger,
    })
    port.park(order(100))
    port.park(order(200))
    port.park(order(300))
    expect(f.sent.map((o) => o.timestamp)).toEqual([100])
    f.land()
    await new Promise((r) => setTimeout(r, 0))
    expect(f.sent.map((o) => o.timestamp)).toEqual([100, 300])
    f.land()
    const parcel = await port.take(101, 't1')
    expect(parcel?.timestamp).toBe(300)
  })

  it('a park that lands after the track closed is released again', async () => {
    const f = clientFake()
    const port = createFaceSourceParkPort({
      client: () => f.client,
      isNodeOffline: () => false,
      logger,
    })
    port.park(order(100))
    port.release('t1')
    f.land()
    await new Promise((r) => setTimeout(r, 0))
    expect(f.released).toEqual([`${FACE_SOURCE_PARK_PREFIX}t1`, `${FACE_SOURCE_PARK_PREFIX}t1`])
  })

  it('never orders a park at a node the registry calls offline', () => {
    const f = clientFake()
    const port = createFaceSourceParkPort({
      client: () => f.client,
      isNodeOffline: () => true,
      logger,
    })
    port.park(order(100))
    expect(f.sent).toEqual([])
  })
})
