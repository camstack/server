import type {
  LogExtras,
  PipelineAnalyticsTrackLifecyclePayload,
  Track,
  TrackEnvelope,
} from '@camstack/types'
import { completeLoggerStub } from '../../../notification-center/__tests__/support/nc-test-deps.js'
import { NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { evaluateRule, subjectFromTrack } from '../../../notification-center/rule-engine.js'
import { createKeyFrameCrop } from '../keyframe-crop.js'
import type { PendingPreviewUpgrade } from '../preview-upgrade.js'
import {
  composePreviewMissReason,
  type TrackCloseCaptureLog,
  type TrackCloseEventStore,
  type TrackCloseKeyFrameThumbnailInput,
  type TrackCloseMediaRow,
  type TrackCloseMediaStore,
  type TrackClosePeakSummary,
  type TrackClosePreviewCaptureMiss,
  type TrackClosePromotionInput,
  type TrackCloseRasterPut,
  TrackCloser,
  type TrackCloserDeps,
  type ParkedProbeTrack,
  type TrackCloseTrackStore,
  type TrackEndedAliasData,
  type TrackEndObserver,
  type TrackEndRecognizer,
  type TrackCloseFrameSwapInput,
} from '../track-close.js'
import { TrackResidentState } from '../track-resident-state.js'

const DEVICE_ID = 7
const TRACK_ID = 't-1'
const NOW_MS = 99_999

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    trackId: TRACK_ID,
    deviceId: DEVICE_ID,
    className: 'person',
    firstSeen: 10_000,
    lastSeen: 20_000,
    positions: [
      { x: 10, y: 10, timestamp: 10_000, bbox: { x: 0, y: 0, w: 20, h: 40 } },
      {
        x: 200,
        y: 150,
        timestamp: 20_000,
        bbox: { x: 180, y: 120, w: 20, h: 40 },
      },
    ],
    snapshots: [],
    zonesVisited: ['garden'],
    totalDistance: 0.4,
    state: 'moving',
    active: false,
    ...overrides,
  }
}

function makeMedia(
  overrides: Partial<TrackCloseMediaRow> & Pick<TrackCloseMediaRow, 'mediaId' | 'kind'>,
): TrackCloseMediaRow {
  return {
    base64: Buffer.from('img').toString('base64'),
    sizeBytes: 3,
    timestamp: 15_000,
    ...overrides,
  }
}

/** Deterministic media ROW id (D482) for a fixture LABEL — not a real
 *  rowid, just a stable, non-zero number a test can assert back against for
 *  the same label. */
function mediaIdFor(label: string): number {
  let hash = 0
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000
  return hash + 1000
}

interface RecordedFaceEnd {
  readonly deviceId: number
  readonly trackId: string
  /** The keyFrame media id (D482) VISIBLE to the recognizer at onTrackEnd call time. */
  readonly keyAtCall: number | undefined
  /** The position trail handed over — the plate's durable keyFrame crop cannot
   *  tell a parked car from a crossing one without it, and this is the last
   *  moment it exists (`expireStale` has already dropped the live row). */
  readonly subjectPath?: readonly { timestamp: number }[]
}

interface RecordedImportance {
  readonly trackId: string
  readonly importance: number
  readonly reason: string
  readonly bestEventId: string | undefined
}

interface HarnessCalls {
  expireStale: number
  peakForTrack: number
  setImportance: RecordedImportance[]
  setImportanceForTrack: Array<{ trackId: string; importance: number }>
  rasterPuts: TrackCloseRasterPut[]
  promotions: TrackClosePromotionInput[]
  frameSwaps: TrackCloseFrameSwapInput[]
  deleteByTrack: string[]
  deleteForEvents: string[][]
  deleteForTracks: string[][]
  deletePersisted: string[]
  faceEnds: RecordedFaceEnd[]
  plateEnds: RecordedFaceEnd[]
  dispatcherEnded: Array<{ deviceId: number; trackId: string }>
  overlayEnded: Array<{ deviceId: number; trackId: string }>
  captureFlushes: number[]
  aliasEmits: Array<{ data: TrackEndedAliasData; timestampMs: number }>
  lifecycleEmits: Array<{
    payload: PipelineAnalyticsTrackLifecyclePayload
    timestampMs: number
  }>
  infoLogs: string[]
  infoLogExtras: Array<{ message: string; extras?: LogExtras }>
  debugLogs: string[]
  warnLogs: string[]
  previewMissSets: Array<{ deviceId: number; trackId: string; reason: string | null }>
  pendingUpgrades: PendingPreviewUpgrade[]
  deriveInputs: TrackCloseKeyFrameThumbnailInput[]
  expireStaleParkedProbe: ((track: Track) => boolean) | undefined
  trackClosedInfos: Array<{
    trackId: string
    info: {
      readonly bestConfidence?: number
      readonly importance?: number
      readonly labelConfidence?: number
      readonly envelope?: TrackEnvelope
    }
  }>
}

interface HarnessOptions {
  /** Tracks returned by every `expireStale` (behind the shared gate). */
  readonly expired?: readonly Track[]
  /** Media already owned by the track (`listByOwner`). */
  readonly ownedMedia?: readonly TrackCloseMediaRow[]
  /** Importance peak; `noEventStore` makes the getter return null instead. */
  readonly peak?: TrackClosePeakSummary
  readonly noEventStore?: boolean
  /** Remaining active tracks on the device after the close. */
  readonly activeAfterClose?: readonly Track[]
  /** Wire a face recognizer whose `onTrackEnd` resolves on this deferred. */
  readonly faceGate?: Deferred<void>
  /** Face recognizer's `bestLabelMatchConfidence` return (NC label-confidence). */
  readonly faceMatchConfidence?: number
  /** Wire a plate recognizer (records the key it observes). */
  readonly withPlate?: boolean
  /** Plate recognizer's `bestLabelMatchConfidence` return (NC label-confidence). */
  readonly plateMatchConfidence?: number
  /** `mediaCaptureLog.flush` returns null (nothing aggregated). */
  readonly emptyCaptureWindow?: boolean
  /** Wire the close-time keyFrame→thumbnail derive: 'ok' returns two derived
   *  buffers, 'null' misses (skew/decode), 'throw' rejects, 'real' composes the
   *  ACTUAL `createKeyFrameCrop` (guards and all) over the owned keyFrame row —
   *  the only setting under which reverting a guard line changes an outcome
   *  here. Absent = not wired (version-skew callers). */
  readonly deriveThumbnail?: 'ok' | 'null' | 'throw' | 'real'
  /** Media rows owned by the track (`listByOwner`) — provenance-bearing. */
  readonly ownedRows?: readonly TrackCloseMediaRow[]
  /** The residents' accumulated capture-miss note (D276/B2). */
  readonly captureMiss?: TrackClosePreviewCaptureMiss
  /** Close-time parked-box probe forwarded into `expireStale`. */
  readonly isKnownParked?: (track: ParkedProbeTrack) => boolean
}

interface Harness {
  readonly closer: TrackCloser
  readonly residents: TrackResidentState
  readonly calls: HarnessCalls
  readonly expireGate: Deferred<readonly Track[]>
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const residents = new TrackResidentState()
  const expireGate = deferred<readonly Track[]>()
  const calls: HarnessCalls = {
    expireStale: 0,
    peakForTrack: 0,
    setImportance: [],
    setImportanceForTrack: [],
    infoLogExtras: [],
    rasterPuts: [],
    promotions: [],
    frameSwaps: [],
    deleteByTrack: [],
    deleteForEvents: [],
    deleteForTracks: [],
    deletePersisted: [],
    faceEnds: [],
    plateEnds: [],
    dispatcherEnded: [],
    overlayEnded: [],
    captureFlushes: [],
    aliasEmits: [],
    lifecycleEmits: [],
    infoLogs: [],
    debugLogs: [],
    warnLogs: [],
    previewMissSets: [],
    pendingUpgrades: [],
    deriveInputs: [],
    expireStaleParkedProbe: undefined,
    trackClosedInfos: [],
  }
  const trackStore: TrackCloseTrackStore = {
    expireStale: async (_now, opts) => {
      calls.expireStale += 1
      calls.expireStaleParkedProbe = opts?.isKnownParked
      return expireGate.promise
    },
    getActive: () => options.activeAfterClose ?? [],
    setImportance: async (trackId, importance, reason, bestEventId) => {
      calls.setImportance.push({ trackId, importance, reason, bestEventId })
    },
    deletePersisted: async (trackId) => {
      calls.deletePersisted.push(trackId)
    },
  }
  const mediaStore: TrackCloseMediaStore = {
    listByOwner: async () => options.ownedRows ?? options.ownedMedia ?? [],
    put: async (params) => {
      calls.rasterPuts.push(params)
      return mediaIdFor('raster-put')
    },
    promoteToLastFrame: async (input) => {
      calls.promotions.push(input)
      return mediaIdFor('promoted')
    },
    swapFirstAndLastFrame: async (input) => {
      calls.frameSwaps.push(input)
    },
    deleteForEvents: async (ids) => {
      const objectIds = ids.object ?? []
      calls.deleteForEvents.push([...objectIds])
      return objectIds.length
    },
    deleteForTracks: async (ids) => {
      calls.deleteForTracks.push([...ids])
      return ids.length
    },
  }
  const eventStore: TrackCloseEventStore = {
    peakForTrack: async () => {
      calls.peakForTrack += 1
      return (
        options.peak ?? {
          peakConfidence: 0.5,
          peakBboxAreaFrac: 0.1,
          bestEventId: undefined,
        }
      )
    },
    setImportanceForTrack: async (trackId, importance) => {
      calls.setImportanceForTrack.push({ trackId, importance })
      return 1
    },
    deleteByTrack: async (trackId) => {
      calls.deleteByTrack.push(trackId)
      return []
    },
  }
  const faceRecognizer: TrackEndRecognizer | null =
    options.faceGate || options.faceMatchConfidence !== undefined
      ? {
          onTrackEnd: (deviceId, trackId) => {
            calls.faceEnds.push({
              deviceId,
              trackId,
              keyAtCall: residents.keyFrameMediaId(trackId),
            })
            const gate = options.faceGate
            return gate ? gate.promise : Promise.resolve()
          },
          bestLabelMatchConfidence: () => options.faceMatchConfidence,
        }
      : null
  const plateRecognizer: TrackEndRecognizer | null =
    options.withPlate || options.plateMatchConfidence !== undefined
      ? {
          onTrackEnd: async (deviceId, trackId, subjectPath) => {
            calls.plateEnds.push({
              deviceId,
              trackId,
              keyAtCall: residents.keyFrameMediaId(trackId),
              ...(subjectPath !== undefined ? { subjectPath } : {}),
            })
          },
          bestLabelMatchConfidence: () => options.plateMatchConfidence,
        }
      : null
  const detailDispatcher: TrackEndObserver = {
    onTrackEnded: (deviceId, trackId) => {
      calls.dispatcherEnded.push({ deviceId, trackId })
    },
  }
  const overlayState: TrackEndObserver = {
    onTrackEnded: (deviceId, trackId) => {
      calls.overlayEnded.push({ deviceId, trackId })
    },
  }
  const mediaCaptureLog: TrackCloseCaptureLog = {
    flush: (deviceId) => {
      calls.captureFlushes.push(deviceId)
      if (options.emptyCaptureWindow) return null
      return {
        frames: 3,
        windowMs: 60_000,
        sums: {
          events: 1,
          trackFrames: 2,
          snapshots: 0,
          faceCrops: 0,
          plateCrops: 0,
        },
      }
    },
  }
  const deps: TrackCloserDeps = {
    logger: completeLoggerStub({
      info: (message, extras) => {
        calls.infoLogs.push(message)
        calls.infoLogExtras.push({ message, extras })
      },
      debug: (message) => {
        calls.debugLogs.push(message)
      },
      warn: (message) => {
        calls.warnLogs.push(message)
      },
    }),
    residents,
    trackStore: () => trackStore,
    mediaStore: () => mediaStore,
    eventStore: () => (options.noEventStore ? null : eventStore),
    faceRecognizer: () => faceRecognizer,
    plateRecognizer: () => plateRecognizer,
    detailDispatcher: () => detailDispatcher,
    overlayState,
    mediaCaptureLog,
    frameDims: () => ({ w: 1920, h: 1080 }),
    isShuttingDown: () => false,
    emitTrackEnded: (data, timestampMs) => {
      calls.aliasEmits.push({ data, timestampMs })
    },
    emitTrackLifecycle: (payload, timestampMs) => {
      calls.lifecycleEmits.push({ payload, timestampMs })
    },
    onTrackClosed: (track, _ownedMedia, info) => {
      calls.trackClosedInfos.push({ trackId: track.trackId, info })
    },
    previewCaptureMiss: () => options.captureMiss,
    recordPendingPreviewUpgrade: (entry) => {
      calls.pendingUpgrades.push(entry)
    },
    setPreviewMiss: async (deviceId, trackId, reason) => {
      calls.previewMissSets.push({ deviceId, trackId, reason })
    },
    ...(options.isKnownParked !== undefined ? { isKnownParked: options.isKnownParked } : {}),
    ...(options.deriveThumbnail !== undefined
      ? {
          deriveThumbnailFromKeyFrame: async (input: TrackCloseKeyFrameThumbnailInput) => {
            calls.deriveInputs.push(input)
            if (options.deriveThumbnail === 'throw') throw new Error('derive boom')
            if (options.deriveThumbnail === 'null') return null
            if (options.deriveThumbnail === 'real') {
              const rows = options.ownedRows ?? options.ownedMedia ?? []
              const realDerive = createKeyFrameCrop({
                getMedia: async (mediaId) => {
                  const row = rows.find((m) => m.mediaId === mediaId)
                  return row ? { bytes: Buffer.from('kf-bytes'), timestamp: row.timestamp } : null
                },
                decodeJpegToRgb: async () => ({
                  bytes: Buffer.from([1, 2, 3]),
                  width: 1920,
                  height: 1080,
                }),
                cropRegionToJpeg: async () => Buffer.from('derived-thumbnail'),
                maxSkewMs: 1500,
                minSubjectIou: 0.5,
                maxSubjectSampleGapMs: 1000,
                logger: {
                  info: (message) => {
                    calls.infoLogs.push(message)
                  },
                  debug: (message) => {
                    calls.debugLogs.push(message)
                  },
                  warn: (message) => {
                    calls.warnLogs.push(message)
                  },
                  error: () => {},
                  child: () => {
                    throw new Error('unused')
                  },
                  withTags: () => {
                    throw new Error('unused')
                  },
                },
              })
              const derived = await realDerive({ ...input, padding: 0 })
              if (derived === null) return null
              return {
                thumbnail: derived.jpeg,
                thumbnailSmall: Buffer.from('derived-thumbnail-small'),
                skewMs: derived.skewMs,
                motion: derived.motion,
                ...(derived.subjectIou !== undefined ? { subjectIou: derived.subjectIou } : {}),
              }
            }
            return {
              thumbnail: Buffer.from('derived-thumbnail'),
              thumbnailSmall: Buffer.from('derived-thumbnail-small'),
              skewMs: 12,
            }
          },
        }
      : {}),
    now: () => NOW_MS,
  }
  return { closer: new TrackCloser(deps), residents, calls, expireGate }
}

/** Let queued microtasks (promise `.finally` chains) run. */
async function settleMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('TrackCloser.sweep — parked-box stamp at TTL', () => {
  it('forwards isKnownParked into expireStale', async () => {
    const probe = () => true
    const h = makeHarness({ isKnownParked: probe })
    const sweep = h.closer.sweep()
    h.expireGate.resolve([])
    await sweep
    expect(h.calls.expireStaleParkedProbe).toBe(probe)
  })
})

describe('TrackCloser.sweep — single-flight latch', () => {
  it('a second concurrent sweep returns immediately; the latch releases after the first completes', async () => {
    const h = makeHarness()

    const first = h.closer.sweep()
    const second = h.closer.sweep()
    // The second call must resolve WITHOUT starting another expireStale —
    // this is the "sweep ×20 concurrent" regression guard.
    await second
    expect(h.calls.expireStale).toBe(1)

    h.expireGate.resolve([])
    await first
    expect(h.calls.expireStale).toBe(1)

    // Latch released: a later tick sweeps again.
    await h.closer.sweep()
    expect(h.calls.expireStale).toBe(2)
  })
})

describe('TrackCloser — zero-media suppress branch', () => {
  it('cascade-deletes the track, closes residents via suppress, and emits NO end events / importance', async () => {
    const h = makeHarness()
    // Ultra-short, never confirmed, no media, no raster → 'suppress'.
    const track = makeTrack({ firstSeen: 10_000, lastSeen: 10_400 })
    h.residents.open(DEVICE_ID, TRACK_ID)

    await h.closer.closeExpired(track)

    // Cascade delete ran: events leg, track-media leg, then the root row LAST.
    expect(h.calls.deleteByTrack).toEqual([TRACK_ID])
    expect(h.calls.deleteForTracks).toEqual([[TRACK_ID]])
    expect(h.calls.deleteForEvents).toEqual([]) // no event ids → media leg skipped
    expect(h.calls.deletePersisted).toEqual([TRACK_ID])
    // Residents closed (suppress litany ran).
    expect(h.residents.size()).toBe(0)
    // Detail dispatcher + overlay teardown still fire.
    expect(h.calls.dispatcherEnded).toEqual([{ deviceId: DEVICE_ID, trackId: TRACK_ID }])
    expect(h.calls.overlayEnded).toEqual([{ deviceId: DEVICE_ID, trackId: TRACK_ID }])
    // NO importance scoring, NO 'end' lifecycle, NO deprecated alias.
    expect(h.calls.peakForTrack).toBe(0)
    expect(h.calls.setImportance).toEqual([])
    expect(h.calls.lifecycleEmits).toEqual([])
    expect(h.calls.aliasEmits).toEqual([])
    expect(h.calls.infoLogs).toContain('track suppressed (zero-media false birth)')
    expect(h.calls.infoLogs).not.toContain('track ended')
  })
})

describe('TrackCloser — zero-media raster-fallback branch', () => {
  it('commits the retained raster crop as thumbnail, then runs the normal end flow', async () => {
    const h = makeHarness({ activeAfterClose: [] })
    const jpeg = Buffer.from('raster-bytes')
    const track = makeTrack({ firstSeen: 10_000, lastSeen: 15_000 })
    h.residents.retainRasterFallback(DEVICE_ID, TRACK_ID, {
      jpeg,
      timestamp: 12_345,
    })

    await h.closer.closeExpired(track)

    expect(h.calls.rasterPuts).toHaveLength(1)
    const put = h.calls.rasterPuts[0]
    expect(put?.deviceId).toBe(DEVICE_ID)
    expect(put?.ownerKind).toBe('track')
    expect(put?.ownerId).toBe(TRACK_ID)
    expect(put?.kind).toBe('thumbnail')
    expect(put?.timestamp).toBe(12_345)
    expect(put?.data.equals(jpeg)).toBe(true)
    // Normal end flow follows: log, alias + lifecycle 'end' at t.lastSeen.
    expect(h.calls.infoLogs).toContain('track ended')
    expect(h.calls.aliasEmits).toHaveLength(1)
    expect(h.calls.lifecycleEmits).toHaveLength(1)
    expect(h.calls.lifecycleEmits[0]?.payload.phase).toBe('end')
    expect(h.calls.lifecycleEmits[0]?.timestampMs).toBe(track.lastSeen)
    expect(h.residents.size()).toBe(0)
  })
})

describe('TrackCloser — lastFrame promotion branch', () => {
  it('promotes the newest snapshot when it is newer than the held lastFrame', async () => {
    const lastFrame = makeMedia({
      mediaId: mediaIdFor('lf-1'),
      kind: 'lastFrame',
      timestamp: 15_000,
    })
    const snapshot = makeMedia({
      mediaId: mediaIdFor('snap-1'),
      kind: 'snapshot',
      timestamp: 19_000,
    })
    const h = makeHarness({ ownedMedia: [lastFrame, snapshot] })
    const track = makeTrack()

    await h.closer.closeExpired(track)

    expect(h.calls.promotions).toHaveLength(1)
    expect(h.calls.promotions[0]?.deviceId).toBe(DEVICE_ID)
    expect(h.calls.promotions[0]?.trackId).toBe(TRACK_ID)
    expect(h.calls.promotions[0]?.snapshot.mediaId).toBe(mediaIdFor('snap-1'))
    // No suppress / raster fallback on a media-bearing track.
    expect(h.calls.rasterPuts).toEqual([])
    expect(h.calls.deletePersisted).toEqual([])
  })

  it('stays QUIET when a lastFrame is held and there is nothing newer to promote', async () => {
    // `no-source` means: no snapshot, no keyFrameSmall — and a lastFrame is
    // ALREADY HELD. `last-frame-promotion.ts` documents it as "nothing needs
    // promoting and nothing is missing", yet the close warned "no lastFrame at
    // close" for it. On the live hub, 2026-09-08, that line was the loudest
    // thing in the log on three cameras — every one of them holding a
    // lastFrame. A warning that says the opposite of the truth trains the
    // operator to skip the ones that mean something.
    const lastFrame = makeMedia({
      mediaId: mediaIdFor('lf-1'),
      kind: 'lastFrame',
      timestamp: 19_500,
    })
    const h = makeHarness({ ownedMedia: [lastFrame] })

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.promotions).toEqual([])
    expect(h.calls.warnLogs).not.toContain('no lastFrame at close')
  })

  it('still warns when the track really closes with no last view', async () => {
    // `no-key-frame`: no snapshot, no keyFrameSmall AND no lastFrame. Nothing
    // to show for the end of the track, and the cause is upstream — this one
    // must keep saying so.
    const h = makeHarness({
      ownedMedia: [
        makeMedia({ mediaId: mediaIdFor('th-1'), kind: 'thumbnail', timestamp: 19_000 }),
      ],
    })

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.warnLogs).toContain('no lastFrame at close')
  })

  /**
   * "Ultimo frame prima del primo" — device 3829, 2026-09-08, filed by hand on
   * `d035f251`, `448678bb` and `7628b19d`. The `firstFrame` is captured at the
   * CONFIRMED birth, which the confirmation gate may defer by up to 2 s, while
   * the close-time `lastFrame` copy is stamped at the keyFrame it was copied
   * from — so the "primo" tile ends up newer than the "ultimo" one.
   */
  describe('first/last ordering repair', () => {
    it('swaps the slots when the firstFrame post-dates the lastFrame', async () => {
      const lastFrame = makeMedia({
        mediaId: mediaIdFor('lf-1'),
        kind: 'lastFrame',
        timestamp: 15_000,
      })
      const firstFrame = makeMedia({
        mediaId: mediaIdFor('ff-1'),
        kind: 'firstFrame',
        timestamp: 17_163,
      })
      const h = makeHarness({ ownedMedia: [lastFrame, firstFrame] })

      await h.closer.closeExpired(makeTrack())

      expect(h.calls.frameSwaps).toHaveLength(1)
      expect(h.calls.frameSwaps[0]?.deviceId).toBe(DEVICE_ID)
      expect(h.calls.frameSwaps[0]?.trackId).toBe(TRACK_ID)
      // The NEWER row goes into the lastFrame slot, the OLDER into firstFrame.
      expect(h.calls.frameSwaps[0]?.firstFrame.mediaId).toBe(mediaIdFor('ff-1'))
      expect(h.calls.frameSwaps[0]?.lastFrame.mediaId).toBe(mediaIdFor('lf-1'))
      // A silent correction would hide the rate at which captures arrive out of
      // order, so the repair is loud.
      expect(h.calls.warnLogs).toContain('firstFrame/lastFrame were out of order — slots swapped')
    })

    it('leaves an ORDERED pair alone', async () => {
      const firstFrame = makeMedia({
        mediaId: mediaIdFor('ff-1'),
        kind: 'firstFrame',
        timestamp: 10_000,
      })
      const lastFrame = makeMedia({
        mediaId: mediaIdFor('lf-1'),
        kind: 'lastFrame',
        timestamp: 19_500,
      })
      const h = makeHarness({ ownedMedia: [firstFrame, lastFrame] })

      await h.closer.closeExpired(makeTrack())

      expect(h.calls.frameSwaps).toEqual([])
    })

    it('leaves a COLLAPSED pair alone — a sub-interval track has one honest frame', async () => {
      const firstFrame = makeMedia({
        mediaId: mediaIdFor('ff-1'),
        kind: 'firstFrame',
        timestamp: 15_000,
      })
      const lastFrame = makeMedia({
        mediaId: mediaIdFor('lf-1'),
        kind: 'lastFrame',
        timestamp: 15_000,
      })
      const h = makeHarness({ ownedMedia: [firstFrame, lastFrame] })

      await h.closer.closeExpired(makeTrack())

      expect(h.calls.frameSwaps).toEqual([])
    })
  })

  it('does not promote when the lastFrame is already the newest view', async () => {
    const lastFrame = makeMedia({
      mediaId: mediaIdFor('lf-1'),
      kind: 'lastFrame',
      timestamp: 19_500,
    })
    const snapshot = makeMedia({
      mediaId: mediaIdFor('snap-1'),
      kind: 'snapshot',
      timestamp: 19_000,
    })
    const h = makeHarness({ ownedMedia: [lastFrame, snapshot] })

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.promotions).toEqual([])
  })
})

describe('TrackCloser — importance flow', () => {
  it('scores and persists importance on BOTH stores and carries it into the end payload', async () => {
    const media = makeMedia({
      mediaId: mediaIdFor('th-1'),
      kind: 'thumbnail',
      timestamp: 15_000,
    })
    const h = makeHarness({
      ownedMedia: [media],
      peak: { peakConfidence: 0.5, peakBboxAreaFrac: 0.2, bestEventId: 'ev-9' },
      activeAfterClose: [],
    })
    // The shared best-detection tracker peak wins over the event-store peak.
    h.residents.observeBestFrame(DEVICE_ID, TRACK_ID, 0.9, 12_000, true, 0.5, 1, 0.5, 0, false, 0)

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.peakForTrack).toBe(1)
    expect(h.calls.setImportance).toHaveLength(1)
    const persisted = h.calls.setImportance[0]
    expect(persisted?.trackId).toBe(TRACK_ID)
    expect(persisted?.bestEventId).toBe('ev-9')
    expect(persisted?.importance).toBeGreaterThan(0)
    // Event rows stamped with the SAME score (bestEventId present).
    expect(h.calls.setImportanceForTrack).toEqual([
      { trackId: TRACK_ID, importance: persisted?.importance },
    ])
    // End payload carries the final summary.
    const payload = h.calls.lifecycleEmits[0]?.payload
    expect(payload?.importance).toBe(persisted?.importance)
    expect(payload?.bestConfidence).toBe(0.9)
    expect(payload?.media?.bestEventId).toBe('ev-9')
    // Device idle after the close → the capture window flushed + logged.
    expect(h.calls.captureFlushes).toEqual([DEVICE_ID])
    expect(h.calls.infoLogs).toContain('media capture (window)')
  })

  /**
   * The call-site half of the 2026-08-20 static-gate fix. The scorer now asks
   * for the two tiers SEPARATELY; the closer used to hand it `displayLabel(t)`
   * for both, so a parked car labelled "Car" by the vehicle classifier read as
   * identified and escaped the demotion.
   */
  it('a motionless track carrying only a tier-1 sub-class is demoted (static gate)', async () => {
    const media = makeMedia({
      mediaId: mediaIdFor('th-1'),
      kind: 'thumbnail',
      timestamp: 15_000,
    })
    const h = makeHarness({
      ownedMedia: [media],
      peak: { peakConfidence: 0.5, peakBboxAreaFrac: 0.2, bestEventId: 'ev-9' },
      activeAfterClose: [],
    })
    // Parked: both positions on the same pixel → zero displacement, zero span.
    const parked = makeTrack({
      className: 'vehicle',
      label: 'Car',
      totalDistance: 0,
      positions: [
        {
          x: 500,
          y: 500,
          timestamp: 10_000,
          bbox: { x: 480, y: 480, w: 40, h: 40 },
        },
        {
          x: 500,
          y: 500,
          timestamp: 20_000,
          bbox: { x: 480, y: 480, w: 40, h: 40 },
        },
      ],
    })

    await h.closer.closeExpired(parked)

    const scored = h.calls.setImportance[0]?.importance
    expect(scored).toBeDefined()
    // Same track, same geometry, but a real tier-2 identity: NOT demoted.
    const h2 = makeHarness({
      ownedMedia: [media],
      peak: { peakConfidence: 0.5, peakBboxAreaFrac: 0.2, bestEventId: 'ev-9' },
      activeAfterClose: [],
    })
    await h2.closer.closeExpired(makeTrack({ ...parked, subLabel: 'AB123CD' }))
    const identified = h2.calls.setImportance[0]?.importance
    expect(identified).toBeDefined()
    expect(scored!).toBeLessThan(identified! * 0.5)
  })

  it('threads the freshly-scored importance into the onTrackClosed hook info (NC subject fix)', async () => {
    // Regression guard: the Track clone handed to the hook was captured by
    // expireStale BEFORE setImportance wrote the row, so its `importance` is
    // stale/undefined. The closer must pass the value scored THIS close via
    // the close-time info so track-end rules (`minImportance`) see the real
    // number — the exact gap the injected-subject unit tests missed.
    const media = makeMedia({
      mediaId: mediaIdFor('th-1'),
      kind: 'thumbnail',
      timestamp: 15_000,
    })
    const h = makeHarness({
      ownedMedia: [media],
      peak: { peakConfidence: 0.5, peakBboxAreaFrac: 0.2, bestEventId: 'ev-9' },
      activeAfterClose: [],
    })
    h.residents.observeBestFrame(DEVICE_ID, TRACK_ID, 0.9, 12_000, true, 0.5, 1, 0.5, 0, false, 0)

    // The persisted Track clone carries NO importance (row not yet written).
    await h.closer.closeExpired(makeTrack({ importance: undefined }))

    const scored = h.calls.setImportance[0]?.importance
    expect(scored).toBeGreaterThan(0)
    expect(h.calls.trackClosedInfos).toHaveLength(1)
    const info = h.calls.trackClosedInfos[0]?.info
    // The hook received the computed importance, not the stale row value.
    expect(info?.importance).toBe(scored)
    expect(info?.bestConfidence).toBe(0.9)
    // And the NC subject built from that info reads the real number.
    expect(subjectFromTrack(makeTrack({ importance: undefined }), info).importance).toBe(scored)
  })

  it('threads the best face/plate match confidence into the hook info (NC label-confidence seam)', async () => {
    const media = makeMedia({
      mediaId: mediaIdFor('th-1'),
      kind: 'thumbnail',
      timestamp: 15_000,
    })
    // Face 0.6, plate 0.82 → the higher wins.
    const h = makeHarness({
      ownedMedia: [media],
      faceMatchConfidence: 0.6,
      plateMatchConfidence: 0.82,
      activeAfterClose: [],
    })

    await h.closer.closeExpired(makeTrack())

    const info = h.calls.trackClosedInfos[0]?.info
    expect(info?.labelConfidence).toBeCloseTo(0.82)
    // The NC subject built from that info reads it (drives minLabelConfidence).
    expect(subjectFromTrack(makeTrack(), info).labelConfidence).toBeCloseTo(0.82)
  })

  it('omits label confidence when neither recognizer matched a label', async () => {
    const media = makeMedia({
      mediaId: mediaIdFor('th-1'),
      kind: 'thumbnail',
      timestamp: 15_000,
    })
    const h = makeHarness({
      ownedMedia: [media],
      withPlate: true,
      activeAfterClose: [],
    })

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.trackClosedInfos[0]?.info.labelConfidence).toBeUndefined()
  })

  it('hands the plate recognizer the closing track POSITION TRAIL', async () => {
    // `expireStale` has already removed the track from the live map by the time
    // this fires, so the trail cannot be looked up later — if the closer does
    // not pass it here, the plate's durable keyFrame crop is bounded on time
    // alone forever, which is the 2026-07-22 defect.
    const media = makeMedia({ mediaId: mediaIdFor('th-1'), kind: 'thumbnail', timestamp: 15_000 })
    const h = makeHarness({ ownedMedia: [media], withPlate: true })
    const track = makeTrack()

    await h.closer.closeExpired(track)

    expect(h.calls.plateEnds[0]?.subjectPath).toEqual(track.positions)
  })

  it('skips importance persistence entirely when no event store is available', async () => {
    const media = makeMedia({
      mediaId: mediaIdFor('th-1'),
      kind: 'thumbnail',
      timestamp: 15_000,
    })
    const h = makeHarness({ ownedMedia: [media], noEventStore: true })

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.setImportance).toEqual([])
    expect(h.calls.setImportanceForTrack).toEqual([])
    expect(h.calls.lifecycleEmits[0]?.payload.importance).toBeUndefined()
  })
})

describe('TrackCloser — track-end customZones envelope (live producer path)', () => {
  // HONEST end-to-end for the A4 live-envelope fix: close a track through the
  // REAL close hook (NOT a hand-built `envelope`) and assert a `customZones`
  // `track-end` rule can match. The rule-engine-zones spec's e2e builds the
  // envelope by hand on the clone — which never happens live — giving false
  // confidence; this exercises the producer that actually threads it.
  const topLeftZone = {
    kind: 'polygon' as const,
    points: [
      { x: 0, y: 0 },
      { x: 0.3, y: 0 },
      { x: 0.3, y: 0.3 },
      { x: 0, y: 0.3 },
    ],
  }

  function customZonesTrackEndRule() {
    return NcRuleSchema.parse({
      ...NcRuleInputSchema.parse({
        name: 'live trk zone',
        delivery: 'track-end',
        targets: [{ targetId: 't1' }],
        conditions: { customZones: [topLeftZone] },
      }),
      id: 'rule-live',
      createdBy: 'admin-user',
      createdAt: 1_000,
      updatedAt: 1_000,
    })
  }

  it('threads the close-time computed envelope so a live customZones rule matches', async () => {
    const media = makeMedia({
      mediaId: mediaIdFor('th-1'),
      kind: 'thumbnail',
      timestamp: 15_000,
    })
    const h = makeHarness({ ownedMedia: [media], activeAfterClose: [] })

    // The Track clone handed to the close hook carries NO envelope — it lands
    // only on persisted-row projections, never on the live close clone.
    const clone = makeTrack()
    expect(clone.envelope).toBeUndefined()

    await h.closer.closeExpired(clone)

    // The closer computed + threaded the normalized envelope from `positions`
    // + frame dims (1920×1080) — the SAME `computeTrackEnvelope` the store
    // persists — so the hook `info` carries the box the clone lacks.
    expect(h.calls.trackClosedInfos).toHaveLength(1)
    const info = h.calls.trackClosedInfos[0]?.info
    expect(info?.envelope).toEqual({
      minX: 0,
      minY: 0,
      maxX: 200 / 1920,
      maxY: 160 / 1080,
    })

    // Build the REAL track-end subject from the (env-less) clone + threaded
    // info: it now carries the normalized bbox and the customZones rule fires.
    const subject = subjectFromTrack(clone, info)
    expect(subject.bbox).toBeDefined()
    expect(evaluateRule(customZonesTrackEndRule(), subject).matched).toBe(true)
  })

  it('fail-closed control: the SAME clone WITHOUT the threaded info has no bbox → customZones fails', () => {
    // Proves the match above came from the producer-threaded envelope, not the
    // clone — the exact live/dry-run divergence the fix closes.
    const failClosed = evaluateRule(customZonesTrackEndRule(), subjectFromTrack(makeTrack()))
    expect(failClosed.matched).toBe(false)
    expect(failClosed.failedCondition).toBe('customZones')
  })
})

describe('TrackCloser — teardown ordering (deferred keyFrame media id drop)', () => {
  it('recognizer onTrackEnd observes the keyFrame media id; it drops only after the face end settles; residents end empty', async () => {
    const faceGate = deferred<void>()
    const media = makeMedia({
      mediaId: mediaIdFor('th-1'),
      kind: 'thumbnail',
      timestamp: 15_000,
    })
    const h = makeHarness({ ownedMedia: [media], faceGate, withPlate: true })
    h.residents.setKeyFrameMediaId(DEVICE_ID, TRACK_ID, mediaIdFor('kf-1'))

    await h.closer.closeExpired(makeTrack())

    // Both recognizers were ended and SAW the key at call time (design B).
    expect(h.calls.faceEnds).toEqual([
      { deviceId: DEVICE_ID, trackId: TRACK_ID, keyAtCall: mediaIdFor('kf-1') },
    ])
    expect(h.calls.plateEnds).toEqual([
      {
        deviceId: DEVICE_ID,
        trackId: TRACK_ID,
        keyAtCall: mediaIdFor('kf-1'),
        // The plate end also gets the trail (see the dedicated test above) —
        // the face end does not, because face pixels never ride this path.
        subjectPath: makeTrack().positions,
      },
    ])
    // The resident record is gone (close('end') ran) but the key is PARKED,
    // still readable while the face end is in flight.
    expect(h.residents.size()).toBe(0)
    expect(h.residents.keyFrameMediaId(TRACK_ID)).toBe(mediaIdFor('kf-1'))
    // The end payload still carries the track's best image.
    expect(h.calls.lifecycleEmits[0]?.payload.media?.keyFrameMediaId).toBe(mediaIdFor('kf-1'))

    // Face end settles → the deferred drop runs; nothing is left behind.
    faceGate.resolve()
    await settleMicrotasks()
    expect(h.residents.keyFrameMediaId(TRACK_ID)).toBeUndefined()
    expect(h.residents.size()).toBe(0)
  })

  it('drops the keyFrame media id immediately when no face recognizer is active', async () => {
    const media = makeMedia({
      mediaId: mediaIdFor('th-1'),
      kind: 'thumbnail',
      timestamp: 15_000,
    })
    const h = makeHarness({ ownedMedia: [media] })
    h.residents.setKeyFrameMediaId(DEVICE_ID, TRACK_ID, mediaIdFor('kf-1'))

    await h.closer.closeExpired(makeTrack())

    expect(h.residents.keyFrameMediaId(TRACK_ID)).toBeUndefined()
    expect(h.residents.size()).toBe(0)
  })
})

describe('TrackCloser — close-time keyFrame-derived thumbnail (#27-A part 3)', () => {
  const BEST_SEEN = {
    x: 100,
    y: 50,
    w: 78,
    h: 60,
    frameWidth: 640,
    frameHeight: 360,
    timestamp: 14_500,
  }

  function seedBestSeen(h: Harness): void {
    h.residents.recordBestSeenBbox(DEVICE_ID, TRACK_ID, BEST_SEEN)
  }

  it('no thumbnail + native keyFrame → derives and writes thumbnail + thumbnailSmall', async () => {
    const keyFrame = makeMedia({
      mediaId: mediaIdFor('kf-media-1'),
      kind: 'keyFrame',
      timestamp: 14_500,
    })
    const h = makeHarness({ ownedMedia: [keyFrame], deriveThumbnail: 'ok' })
    seedBestSeen(h)

    await h.closer.closeExpired(makeTrack())

    // The derive was asked for exactly the best-seen region of the keyFrame,
    // stamped with the instant the REGION was measured (not the keyFrame's),
    // and handed the trail it needs to check that instant against this one.
    expect(h.calls.deriveInputs).toEqual([
      {
        deviceId: DEVICE_ID,
        mediaId: mediaIdFor('kf-media-1'),
        bbox: { x: 100, y: 50, w: 78, h: 60 },
        frameWidth: 640,
        frameHeight: 360,
        timestamp: 14_500,
        subjectPath: makeTrack().positions,
      },
    ])
    // Both variants written, stamped with the best-seen instant.
    expect(h.calls.rasterPuts).toHaveLength(2)
    const [thumb, small] = h.calls.rasterPuts
    expect(thumb?.kind).toBe('thumbnail')
    expect(thumb?.ownerKind).toBe('track')
    expect(thumb?.ownerId).toBe(TRACK_ID)
    expect(thumb?.timestamp).toBe(14_500)
    expect(thumb?.data.toString()).toBe('derived-thumbnail')
    expect(small?.kind).toBe('thumbnailSmall')
    expect(small?.timestamp).toBe(14_500)
    expect(small?.data.toString()).toBe('derived-thumbnail-small')
    expect(h.calls.infoLogs).toContain(
      'thumbnail derived from keyFrame at close (no live best-shot landed)',
    )
    // The normal end flow still completed.
    expect(h.calls.lifecycleEmits[0]?.payload.phase).toBe('end')
  })

  it('a track WITH a thumbnail is untouched (no derive, no extra puts)', async () => {
    const keyFrame = makeMedia({
      mediaId: mediaIdFor('kf-media-1'),
      kind: 'keyFrame',
      timestamp: 14_500,
    })
    const thumbnail = makeMedia({
      mediaId: mediaIdFor('th-1'),
      kind: 'thumbnail',
      timestamp: 14_400,
    })
    const h = makeHarness({
      ownedMedia: [keyFrame, thumbnail],
      deriveThumbnail: 'ok',
    })
    seedBestSeen(h)

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.deriveInputs).toEqual([])
    expect(h.calls.rasterPuts).toEqual([])
  })

  it('no keyFrame owned → nothing to derive from', async () => {
    const snapshot = makeMedia({
      mediaId: mediaIdFor('snap-1'),
      kind: 'snapshot',
      timestamp: 14_000,
    })
    const h = makeHarness({ ownedMedia: [snapshot], deriveThumbnail: 'ok' })
    seedBestSeen(h)

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.deriveInputs).toEqual([])
    expect(h.calls.rasterPuts).toEqual([])
  })

  it('no best-seen bbox recorded → skipped (nothing honest to crop)', async () => {
    const keyFrame = makeMedia({
      mediaId: mediaIdFor('kf-media-1'),
      kind: 'keyFrame',
      timestamp: 14_500,
    })
    const h = makeHarness({ ownedMedia: [keyFrame], deriveThumbnail: 'ok' })

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.deriveInputs).toEqual([])
    expect(h.calls.rasterPuts).toEqual([])
  })

  it('a derive miss (null — skew/decode) writes nothing and the close continues', async () => {
    const keyFrame = makeMedia({
      mediaId: mediaIdFor('kf-media-1'),
      kind: 'keyFrame',
      timestamp: 14_500,
    })
    const h = makeHarness({ ownedMedia: [keyFrame], deriveThumbnail: 'null' })
    seedBestSeen(h)

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.deriveInputs).toHaveLength(1)
    expect(h.calls.rasterPuts).toEqual([])
    expect(h.calls.lifecycleEmits[0]?.payload.phase).toBe('end')
  })

  it('passes the BEST-SEEN instant, not the keyFrame instant (the d73ddabc2 regression)', async () => {
    // 2026-08-24 passed `keyFrame.timestamp` here to stop 20da3195
    // closing with no tile. That made the guard compare the keyFrame with
    // itself — skewMs 0, forever — and `ba12ed7b` stored a thumbnail of
    // pavement cut from a frame 5.8 s before its subject's best-seen box.
    // The bbox's own instant is what the guard must be handed; 20da3195 is
    // answered by the motion arm, exercised end-to-end below.
    const keyFrame = makeMedia({
      mediaId: mediaIdFor('kf-media-1'),
      kind: 'keyFrame',
      timestamp: 14_500,
    })
    const h = makeHarness({ ownedMedia: [keyFrame], deriveThumbnail: 'ok' })
    h.residents.recordBestSeenBbox(DEVICE_ID, TRACK_ID, {
      ...BEST_SEEN,
      timestamp: 20_000,
    })

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.deriveInputs[0]?.timestamp).toBe(20_000)
  })

  /**
   * End-to-end over the REAL `createKeyFrameCrop`: two tracks with the SAME
   * 5.5 s gap between the keyFrame and the best-seen box, differing only in
   * whether the subject moved. `ba12ed7b` is the first; the second is the
   * 20da3195 shape the 08-24 commit was trying to protect.
   */
  describe('with the real crop guard wired', () => {
    const KEY_FRAME_AT = 10_000
    const BEST_SEEN_AT = 15_500

    function keyFrameRow(): TrackCloseMediaRow {
      return makeMedia({
        mediaId: mediaIdFor('kf-media-1'),
        kind: 'keyFrame',
        timestamp: KEY_FRAME_AT,
      })
    }

    /** A trail from birth to close, `pxPerSecond` of horizontal travel. */
    function trailTrack(pxPerSecond: number): Track {
      const positions = []
      for (let ms = KEY_FRAME_AT; ms <= 20_000; ms += 250) {
        const x = ((ms - KEY_FRAME_AT) / 1000) * pxPerSecond
        positions.push({ x, y: 50, timestamp: ms, bbox: { x, y: 50, w: 78, h: 60 } })
      }
      return makeTrack({ firstSeen: KEY_FRAME_AT, positions })
    }

    it('a WALKING subject: the derive is refused and the raster (right-moment) tile is spent', async () => {
      const h = makeHarness({
        ownedRows: [keyFrameRow()],
        deriveThumbnail: 'real',
      })
      h.residents.recordBestSeenBbox(DEVICE_ID, TRACK_ID, { ...BEST_SEEN, timestamp: BEST_SEEN_AT })
      h.residents.retainRasterFallback(DEVICE_ID, TRACK_ID, {
        jpeg: Buffer.from('raster-tile'),
        timestamp: BEST_SEEN_AT,
      })

      await h.closer.closeExpired(trailTrack(200))

      const thumb = h.calls.rasterPuts.find((p) => p.kind === 'thumbnail')
      expect(thumb?.data.toString()).toBe('raster-tile')
      expect(thumb?.provenance).toBe('raster')
      expect(h.calls.infoLogs).toContain(
        'keyframe crop refused — subject moved between the two instants',
      )
      expect(h.calls.infoLogs).not.toContain(
        'thumbnail derived from keyFrame at close (no live best-shot landed)',
      )
    })

    it('a STANDING subject at the identical gap: the native derive lands (20da3195 answered)', async () => {
      const h = makeHarness({
        ownedRows: [keyFrameRow()],
        deriveThumbnail: 'real',
      })
      h.residents.recordBestSeenBbox(DEVICE_ID, TRACK_ID, { ...BEST_SEEN, timestamp: BEST_SEEN_AT })
      h.residents.retainRasterFallback(DEVICE_ID, TRACK_ID, {
        jpeg: Buffer.from('raster-tile'),
        timestamp: BEST_SEEN_AT,
      })

      // 5500 ms of skew — far past the 1500 ms temporal bound. Only the motion
      // arm can let this through, and it must.
      await h.closer.closeExpired(trailTrack(0))

      const thumb = h.calls.rasterPuts.find((p) => p.kind === 'thumbnail')
      expect(thumb?.data.toString()).toBe('derived-thumbnail')
      expect(thumb?.provenance).toBe('native')
      const derived = h.calls.infoLogExtras.find(
        (l) => l.message === 'thumbnail derived from keyFrame at close (no live best-shot landed)',
      )
      expect(derived?.extras?.meta).toMatchObject({ motion: 'agrees', skewMs: 5500 })
    })
  })

  it('keyFrame + failed derive still spends the retained raster (gallery must not get a full frame)', async () => {
    const keyFrame = makeMedia({
      mediaId: mediaIdFor('kf-media-1'),
      kind: 'keyFrame',
      timestamp: 14_500,
    })
    const h = makeHarness({ ownedMedia: [keyFrame], deriveThumbnail: 'null' })
    seedBestSeen(h)
    const jpeg = Buffer.from('raster-crop')
    h.residents.retainRasterFallback(DEVICE_ID, TRACK_ID, { jpeg, timestamp: 12_000 })

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.rasterPuts).toEqual([
      expect.objectContaining({
        kind: 'thumbnail',
        ownerKind: 'track',
        ownerId: TRACK_ID,
        data: jpeg,
      }),
    ])
  })

  it('a derive failure is best-effort: debug-logged, close litany completes', async () => {
    const keyFrame = makeMedia({
      mediaId: mediaIdFor('kf-media-1'),
      kind: 'keyFrame',
      timestamp: 14_500,
    })
    const h = makeHarness({ ownedMedia: [keyFrame], deriveThumbnail: 'throw' })
    seedBestSeen(h)

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.rasterPuts).toEqual([])
    expect(h.calls.debugLogs).toContain('close-time keyFrame thumbnail derive failed')
    expect(h.calls.infoLogs).toContain('track ended')
    expect(h.calls.lifecycleEmits[0]?.payload.phase).toBe('end')
    expect(h.residents.size()).toBe(0)
  })

  /**
   * The 13.5% of tracks that end with no thumbnail produced NOT ONE LINE. Every
   * branch here drops the track's only remaining chance at a preview, and a
   * branch that drops work silently reads as "never happened" — which is how a
   * miss rate this large stayed a guess. Each one now names itself at `info`,
   * per camera, with the reason.
   */
  describe('a missed close-time derive is loud', () => {
    function missLine(h: Harness): { message: string; extras?: LogExtras } | undefined {
      return h.calls.infoLogExtras.find((e) => e.message.includes('track closed with no thumbnail'))
    }

    it('no best-seen bbox → info, per camera, with the reason', async () => {
      const keyFrame = makeMedia({
        mediaId: mediaIdFor('kf-media-1'),
        kind: 'keyFrame',
        timestamp: 14_500,
      })
      const h = makeHarness({ ownedMedia: [keyFrame], deriveThumbnail: 'ok' })

      await h.closer.closeExpired(makeTrack())

      const line = missLine(h)
      expect(line).toBeDefined()
      expect(line?.extras).toMatchObject({
        tags: { deviceId: DEVICE_ID },
        meta: { reason: 'no-best-seen-bbox' },
      })
    })

    it('no keyFrame to derive from → info with the reason', async () => {
      const snapshot = makeMedia({
        mediaId: mediaIdFor('snap-1'),
        kind: 'snapshot',
        timestamp: 14_000,
      })
      const h = makeHarness({ ownedMedia: [snapshot], deriveThumbnail: 'ok' })
      seedBestSeen(h)

      await h.closer.closeExpired(makeTrack())

      expect(missLine(h)?.extras).toMatchObject({
        tags: { deviceId: DEVICE_ID },
        meta: { reason: 'no-key-frame' },
      })
    })

    it('the derive itself missed (skew/decode) → info with the reason', async () => {
      const keyFrame = makeMedia({
        mediaId: mediaIdFor('kf-media-1'),
        kind: 'keyFrame',
        timestamp: 14_500,
      })
      const h = makeHarness({
        ownedMedia: [keyFrame],
        deriveThumbnail: 'null',
      })
      seedBestSeen(h)

      await h.closer.closeExpired(makeTrack())

      expect(missLine(h)?.extras).toMatchObject({
        tags: { deviceId: DEVICE_ID },
        meta: { reason: 'derive-returned-null' },
      })
    })

    it('the derive threw → info with the reason (was debug, so it never reached Loki)', async () => {
      const keyFrame = makeMedia({
        mediaId: mediaIdFor('kf-media-1'),
        kind: 'keyFrame',
        timestamp: 14_500,
      })
      const h = makeHarness({
        ownedMedia: [keyFrame],
        deriveThumbnail: 'throw',
      })
      seedBestSeen(h)

      await h.closer.closeExpired(makeTrack())

      expect(missLine(h)?.extras).toMatchObject({
        tags: { deviceId: DEVICE_ID },
        meta: { reason: 'derive-threw' },
      })
    })

    it('the derive is not wired at all → info with the reason', async () => {
      const keyFrame = makeMedia({
        mediaId: mediaIdFor('kf-media-1'),
        kind: 'keyFrame',
        timestamp: 14_500,
      })
      const h = makeHarness({ ownedMedia: [keyFrame] })
      seedBestSeen(h)

      await h.closer.closeExpired(makeTrack())

      expect(missLine(h)?.extras).toMatchObject({
        tags: { deviceId: DEVICE_ID },
        meta: { reason: 'derive-not-wired' },
      })
    })

    it('a track that HAS a thumbnail says nothing — silence means healthy', async () => {
      const keyFrame = makeMedia({
        mediaId: mediaIdFor('kf-media-1'),
        kind: 'keyFrame',
        timestamp: 14_500,
      })
      const thumbnail = makeMedia({
        mediaId: mediaIdFor('th-1'),
        kind: 'thumbnail',
        timestamp: 14_400,
      })
      const h = makeHarness({
        ownedMedia: [keyFrame, thumbnail],
        deriveThumbnail: 'ok',
      })
      seedBestSeen(h)

      await h.closer.closeExpired(makeTrack())

      expect(missLine(h)).toBeUndefined()
    })

    it('a SUCCESSFUL derive says nothing — the success line already exists', async () => {
      const keyFrame = makeMedia({
        mediaId: mediaIdFor('kf-media-1'),
        kind: 'keyFrame',
        timestamp: 14_500,
      })
      const h = makeHarness({ ownedMedia: [keyFrame], deriveThumbnail: 'ok' })
      seedBestSeen(h)

      await h.closer.closeExpired(makeTrack())

      expect(missLine(h)).toBeUndefined()
      expect(h.calls.infoLogs).toContain(
        'thumbnail derived from keyFrame at close (no live best-shot landed)',
      )
    })
  })

  it('not wired (version skew) → close runs exactly as before', async () => {
    const keyFrame = makeMedia({
      mediaId: mediaIdFor('kf-media-1'),
      kind: 'keyFrame',
      timestamp: 14_500,
    })
    const h = makeHarness({ ownedMedia: [keyFrame] })
    seedBestSeen(h)

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.deriveInputs).toEqual([])
    expect(h.calls.rasterPuts).toEqual([])
    expect(h.calls.lifecycleEmits[0]?.payload.phase).toBe('end')
  })
})

describe('TrackCloser — provisional stand-ins and the preview-miss record (D276)', () => {
  const BEST_SEEN = {
    x: 100,
    y: 50,
    w: 78,
    h: 60,
    frameWidth: 640,
    frameHeight: 360,
    timestamp: 14_500,
  }

  it('a face-crop STAND-IN thumbnail is replaced by the keyFrame derive at close', async () => {
    // 413c69ff shape: the face copy landed mid-life (provenance standin), the
    // keyFrame exists — before D276 the close skipped the derive ("already has
    // a thumbnail") and the person track kept the 5 KB face forever.
    const standin = makeMedia({
      mediaId: mediaIdFor('standin-1'),
      kind: 'thumbnail',
      provenance: 'standin',
    })
    const keyFrame = makeMedia({ mediaId: mediaIdFor('kf-1'), kind: 'keyFrame', timestamp: 14_500 })
    const h = makeHarness({ ownedRows: [standin, keyFrame], deriveThumbnail: 'ok' })
    h.residents.recordBestSeenBbox(DEVICE_ID, TRACK_ID, BEST_SEEN)

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.deriveInputs).toHaveLength(1)
    expect(h.calls.rasterPuts).toHaveLength(2)
    expect(h.calls.rasterPuts[0]?.kind).toBe('thumbnail')
    expect(h.calls.rasterPuts[0]?.provenance).toBe('native')
    expect(h.calls.rasterPuts[1]?.provenance).toBe('native')
    // The replacement is REPORTED, naming what it replaced.
    const derived = h.calls.infoLogExtras.find(
      (e) => e.message === 'thumbnail derived from keyFrame at close (no live best-shot landed)',
    )
    if (derived === undefined) throw new Error('derive log line missing')
    const meta = (derived.extras as { meta?: { replaced?: unknown } }).meta
    expect(meta?.replaced).toBe('standin')
    // A native tile landed → NO miss reason, NO pending upgrade.
    expect(h.calls.previewMissSets).toEqual([])
    expect(h.calls.pendingUpgrades).toEqual([])
  })

  it('a NATIVE thumbnail is never re-derived (explicit provenance)', async () => {
    const native = makeMedia({
      mediaId: mediaIdFor('native-1'),
      kind: 'thumbnail',
      provenance: 'native',
    })
    const keyFrame = makeMedia({ mediaId: mediaIdFor('kf-2'), kind: 'keyFrame' })
    const h = makeHarness({ ownedRows: [native, keyFrame], deriveThumbnail: 'ok' })
    h.residents.recordBestSeenBbox(DEVICE_ID, TRACK_ID, BEST_SEEN)

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.deriveInputs).toEqual([])
    expect(h.calls.rasterPuts).toEqual([])
    expect(h.calls.previewMissSets).toEqual([])
  })

  it('a legacy thumbnail with NO provenance ranks native — never overwritten', async () => {
    // Forward-only repair (D276): a pre-column row cannot be classified, so it
    // is treated as native and left alone.
    const legacy = makeMedia({ mediaId: mediaIdFor('legacy-1'), kind: 'thumbnail' })
    const keyFrame = makeMedia({ mediaId: mediaIdFor('kf-3'), kind: 'keyFrame' })
    const h = makeHarness({ ownedRows: [legacy, keyFrame], deriveThumbnail: 'ok' })
    h.residents.recordBestSeenBbox(DEVICE_ID, TRACK_ID, BEST_SEEN)

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.deriveInputs).toEqual([])
    expect(h.calls.rasterPuts).toEqual([])
  })

  it('closing with NO tile records the miss reason (with capture detail) and a pending upgrade', async () => {
    // The 7dba7c0a shape: nothing native ever landed. The close must say WHY
    // on the row — `no-key-frame` plus the residents\' capture-miss note — and
    // register the track so a late keyFrame can still redeem it.
    const h = makeHarness({
      ownedMedia: [makeMedia({ mediaId: mediaIdFor('ff-1'), kind: 'firstFrame' })],
      deriveThumbnail: 'ok',
      captureMiss: { reason: 'keyframe:native-miss', count: 4 },
    })
    h.residents.recordBestSeenBbox(DEVICE_ID, TRACK_ID, BEST_SEEN)

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.previewMissSets).toEqual([
      {
        deviceId: DEVICE_ID,
        trackId: TRACK_ID,
        reason: 'no-key-frame capture=keyframe:native-missx4',
      },
    ])
    expect(h.calls.pendingUpgrades).toHaveLength(1)
    expect(h.calls.pendingUpgrades[0]).toMatchObject({
      deviceId: DEVICE_ID,
      trackId: TRACK_ID,
      bestSeen: {
        x: 100,
        y: 50,
        w: 78,
        h: 60,
        frameWidth: 640,
        frameHeight: 360,
        // The box's OWN instant rides along. Without it the late redeem has no
        // second instant to bound its cross-time cut against, and it refuses —
        // so dropping this silently disables the whole upgrade path.
        timestamp: BEST_SEEN.timestamp,
      },
      recordedAtMs: NOW_MS,
    })
  })

  it('a raster tile spent at close records tile=raster and stays redeemable', async () => {
    const h = makeHarness({ deriveThumbnail: 'ok' })
    h.residents.retainRasterFallback(DEVICE_ID, TRACK_ID, {
      jpeg: Buffer.from('raster-bytes'),
      timestamp: 12_345,
    })

    await h.closer.closeExpired(makeTrack())

    // The raster commit itself states its provenance.
    const rasterPut = h.calls.rasterPuts.find((putCall) => putCall.kind === 'thumbnail')
    expect(rasterPut?.provenance).toBe('raster')
    expect(h.calls.previewMissSets).toHaveLength(1)
    expect(h.calls.previewMissSets[0]?.reason).toContain('tile=raster')
    expect(h.calls.pendingUpgrades).toHaveLength(1)
  })

  it('a native close leaves NO miss record and NO pending upgrade', async () => {
    const keyFrame = makeMedia({ mediaId: mediaIdFor('kf-4'), kind: 'keyFrame', timestamp: 14_500 })
    const h = makeHarness({ ownedMedia: [keyFrame], deriveThumbnail: 'ok' })
    h.residents.recordBestSeenBbox(DEVICE_ID, TRACK_ID, BEST_SEEN)

    await h.closer.closeExpired(makeTrack())

    expect(h.calls.previewMissSets).toEqual([])
    expect(h.calls.pendingUpgrades).toEqual([])
  })
})

describe('composePreviewMissReason', () => {
  it('composes the derive branch, the tile marker and the capture note', () => {
    expect(composePreviewMissReason('none', 'no-key-frame', undefined)).toBe('no-key-frame')
    expect(
      composePreviewMissReason('none', 'no-key-frame', { reason: 'thumbnail:overflow', count: 12 }),
    ).toBe('no-key-frame capture=thumbnail:overflowx12')
    expect(composePreviewMissReason('raster', 'no-key-frame', undefined)).toBe(
      'no-key-frame tile=raster',
    )
    expect(composePreviewMissReason('standin', 'derive-returned-null', undefined)).toBe(
      'derive-returned-null tile=standin',
    )
    expect(composePreviewMissReason('standin', undefined, undefined)).toBe(
      'standin-tile tile=standin',
    )
  })
})
