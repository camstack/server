/**
 * A track records WHERE it was detected: the node, the inference device and
 * the root model of the frame that OPENED it (its birth) and of the last real
 * sighting that CLOSED it.
 *
 * A camera's detection session is elected per on-motion session and can hop
 * node or device between sessions (D916), so one track can be born on the hub's
 * NPU and last seen on an agent's Coral. Without the two placements on the row
 * "which node/device produced this suppression?" was answered by correlating
 * timestamps against `inference device selection` lines.
 *
 * Disarms (each alone, restored):
 *  - in `TrackStore.upsert`, stop updating `closedPlacement` on a matched
 *    sighting: "a hop keeps both" fails;
 *  - update it on a COASTED frame too: "a coasted frame is not a sighting" fails;
 *  - drop the two keys from `persistCompleted`: every persisted assertion fails;
 *  - drop them from `rowToTrack`: same;
 *  - make the merge rule take the survivor's `closedPlacement`: "a fused track"
 *    fails.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { fullRow } from '../../__tests__/track-store-test-helpers.js'
import { trackPlacementOf, type TrackPlacement } from '../../pipeline/track-placement.js'
import { TRACK_MERGE_RULES, mergeActiveTracks } from '../track-merge.js'
import { TrackStore } from '../track-store.js'

const DEVICE_ID = 101
const HUB_NPU: TrackPlacement = { nodeId: 'hub', deviceKey: 'openvino:npu', modelId: 'yolo26n' }
const AGENT_CORAL: TrackPlacement = {
  nodeId: 'agent-b',
  deviceKey: 'edgetpu:pci',
  modelId: 'yolov8n-tflite',
}

describe('TrackStore — execution placement (opened / closed)', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore({ enforceDeclaredColumns: true })
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  function upsert(
    trackId: string,
    timestamp: number,
    placement?: TrackPlacement,
    matched = true,
  ): void {
    trackStore.upsert({
      trackId,
      deviceId: DEVICE_ID,
      className: 'person',
      matched,
      timestamp,
      position: { x: 0.5, y: 0.5, timestamp, bbox: { x: 10, y: 10, w: 20, h: 40 } },
      zones: [],
      state: 'moving',
      ...(placement !== undefined ? { placement } : {}),
    })
  }

  it('persists the placement on close — opened and closed are the same when the track never moved node', async () => {
    upsert('t1', 1_000, HUB_NPU)
    upsert('t1', 1_100, HUB_NPU)
    await trackStore.expireStale(1_100 + 60_000)

    for (const projection of ['full', 'slim'] as const) {
      const rows = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.openedPlacement).toEqual(HUB_NPU)
      expect(rows[0]!.closedPlacement).toEqual(HUB_NPU)
    }
  })

  it('a hop keeps both: born on the hub NPU, closed on the agent Coral', async () => {
    upsert('t-hop', 1_000, HUB_NPU)
    upsert('t-hop', 1_100, AGENT_CORAL)
    // Read while still LIVE (the detail panel opens on live tracks too).
    const live = trackStore.getActiveByTrack('t-hop')
    expect(live?.openedPlacement).toEqual(HUB_NPU)
    expect(live?.closedPlacement).toEqual(AGENT_CORAL)

    await trackStore.expireStale(1_100 + 60_000)
    const row = await trackStore.getPersistedByTrackId('t-hop')
    expect(row?.openedPlacement).toEqual(HUB_NPU)
    expect(row?.closedPlacement).toEqual(AGENT_CORAL)
  })

  it('a coasted frame is not a sighting — it never becomes the closing placement', async () => {
    upsert('t-coast', 1_000, HUB_NPU)
    upsert('t-coast', 1_100, AGENT_CORAL, false)
    await trackStore.expireStale(1_100 + 60_000)
    const row = await trackStore.getPersistedByTrackId('t-coast')
    expect(row?.closedPlacement).toEqual(HUB_NPU)
  })

  it('a frame that names no placement leaves both absent — never an invented node', async () => {
    upsert('t-legacy', 1_000)
    await trackStore.expireStale(1_000 + 60_000)
    const row = await trackStore.getPersistedByTrackId('t-legacy')
    expect(row !== null && 'openedPlacement' in row).toBe(false)
    expect(row !== null && 'closedPlacement' in row).toBe(false)
  })
})

describe('a fused track (D683 L2) — the earliest piece opened it, the latest sighting closed it', () => {
  const ctx = { maxPositionHistory: 300 }

  it('opened = the piece born first, closed = the piece seen last', () => {
    const a = fullRow('A', {
      positionsAt: [1_000, 2_000],
      openedPlacement: HUB_NPU,
      closedPlacement: HUB_NPU,
    })
    const b = fullRow('B', {
      positionsAt: [5_000, 9_000],
      openedPlacement: AGENT_CORAL,
      closedPlacement: AGENT_CORAL,
    })
    const merged = mergeActiveTracks(a, b, ctx)
    expect(merged.openedPlacement).toEqual(HUB_NPU)
    expect(merged.closedPlacement).toEqual(AGENT_CORAL)
  })

  it('decides by the times, not by which piece survived', () => {
    // A survivor that was seen LAST (the absorbed piece overlapped and ended
    // earlier) keeps its own closing placement.
    const a = fullRow('A', {
      positionsAt: [1_000, 9_000],
      openedPlacement: HUB_NPU,
      closedPlacement: HUB_NPU,
    })
    const b = fullRow('B', {
      positionsAt: [2_000, 3_000],
      openedPlacement: AGENT_CORAL,
      closedPlacement: AGENT_CORAL,
    })
    expect(TRACK_MERGE_RULES.closedPlacement(a, b, ctx)).toEqual(HUB_NPU)
    expect(TRACK_MERGE_RULES.openedPlacement(a, b, ctx)).toEqual(HUB_NPU)
  })

  it('a piece with no placement never erases the other piece’s', () => {
    const a = fullRow('A', {
      positionsAt: [1_000],
      openedPlacement: HUB_NPU,
      closedPlacement: HUB_NPU,
    })
    const b = fullRow('B', { positionsAt: [5_000] })
    const { openedPlacement: _o, closedPlacement: _c, ...bare } = b
    const merged = mergeActiveTracks(a, bare, ctx)
    expect(merged.closedPlacement).toEqual(HUB_NPU)
  })
})

describe('trackPlacementOf — what a frame says about where it was inferred', () => {
  it('carries the runner node, the root device and the root model', () => {
    expect(
      trackPlacementOf({ rootModelId: 'yolo26n', rootDeviceKey: 'openvino:npu' }, 'hub'),
    ).toEqual(HUB_NPU)
  })

  it('omits what the frame does not stamp — absent, never an empty string', () => {
    const p = trackPlacementOf({}, 'agent-b')
    expect(p).toEqual({ nodeId: 'agent-b' })
    expect(p !== undefined && ('deviceKey' in p || 'modelId' in p)).toBe(false)
  })

  it('says nothing when the producing node is unknown', () => {
    expect(trackPlacementOf({ rootModelId: 'x', rootDeviceKey: 'cpu' }, '')).toBeUndefined()
  })
})
