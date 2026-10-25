/**
 * StreamBrokerManager.getLiveViewerCounts — the roll-up the cap method returns.
 *
 * The planes are covered on their own (`live-viewer-count-rtsp.spec.ts`,
 * `live-viewer-count-webrtc.spec.ts`); this proves the SUM: a camera's WebRTC
 * viewers and its RTSP viewers add up across all of its profile brokers, a
 * camera nobody watches is absent, and the answer is ordered.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

interface Seams {
  brokers: Map<string, { countExternalRestreamViewers: () => number }>
  webrtcServer: { countLiveViewers: () => ReadonlyMap<number, number> } | null
}

function makeManager(
  rtspByBroker: Readonly<Record<string, number>>,
  webrtc: ReadonlyMap<number, number> | null,
): StreamBrokerManager {
  const manager = new StreamBrokerManager(makeLogger())
  const seams = manager as unknown as Seams
  for (const [brokerId, n] of Object.entries(rtspByBroker)) {
    seams.brokers.set(brokerId, { countExternalRestreamViewers: () => n })
  }
  seams.webrtcServer = webrtc === null ? null : { countLiveViewers: () => webrtc }
  return manager
}

describe('StreamBrokerManager.getLiveViewerCounts', () => {
  it('sums WebRTC and RTSP viewers per camera across its profile brokers, ordered by id', async () => {
    const manager = makeManager(
      { '9/high': 1, '9/low': 2, '4/high': 0, '12/mid': 1 },
      new Map([
        [9, 3],
        [4, 1],
      ]),
    )
    expect(await manager.getLiveViewerCounts()).toEqual([
      { deviceId: 4, viewers: 1 },
      { deviceId: 9, viewers: 6 },
      { deviceId: 12, viewers: 1 },
    ])
  })

  it('omits a camera nobody watches', async () => {
    const manager = makeManager({ '4/high': 0, '5/high': 0 }, new Map())
    expect(await manager.getLiveViewerCounts()).toEqual([])
  })

  it('answers from RTSP alone when the WebRTC server is not up', async () => {
    const manager = makeManager({ '4/high': 2 }, null)
    expect(await manager.getLiveViewerCounts()).toEqual([{ deviceId: 4, viewers: 2 }])
  })
})
