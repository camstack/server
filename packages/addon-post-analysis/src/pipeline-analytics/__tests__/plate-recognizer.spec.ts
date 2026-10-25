import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { TrackedDetectionOut } from '../pipeline/frame-processor.js'
import { createKeyFrameCrop } from '../pipeline/keyframe-crop.js'
import type { PlateGallerySample } from '../pipeline/plate-matcher.js'
import type { SubjectPathSample } from '../pipeline/subject-agreement.js'
import { PlateRecognizer, type PlateRecognizerDeps } from '../plate-recognizer.js'
import { makeSilentLogger } from './test-helpers.js'

interface CapturedInsert {
  id: string
  recognizedVehicleId?: string
  keyFrameMediaId?: number
  plateBbox?: { x: number; y: number; w: number; h: number }
  assigned: boolean
  text: string
}

interface CapturedEmit {
  deviceId: number
  plateId: string
  kind: string
}

function makeRecognizer(
  gallery: readonly PlateGallerySample[],
  names: readonly { id: string; name: string }[],
  extras: Partial<PlateRecognizerDeps> = {},
): {
  rec: PlateRecognizer
  inserts: CapturedInsert[]
  emits: CapturedEmit[]
} {
  const inserts: CapturedInsert[] = []
  const emits: CapturedEmit[] = []
  const deps: PlateRecognizerDeps = {
    plateStore: {
      insert: async (p) => {
        inserts.push({
          id: p.id,
          text: p.text,
          assigned: p.assigned,
          ...(p.recognizedVehicleId !== undefined
            ? { recognizedVehicleId: p.recognizedVehicleId }
            : {}),
          ...(p.keyFrameMediaId !== undefined ? { keyFrameMediaId: p.keyFrameMediaId } : {}),
          ...(p.plateBbox !== undefined ? { plateBbox: p.plateBbox } : {}),
        })
      },
    },
    vehicleStore: {
      loadGallery: async () => gallery,
      listVehicles: async () => names,
    },
    mediaStore: { put: async () => 1 },
    captureCrop: async () => Buffer.from([1]),
    getKeyFrameMediaId: () => 101,
    emitPlateGalleryChanged: (p) =>
      emits.push({ deviceId: p.deviceId, plateId: p.plateId, kind: p.kind }),
    logger: makeSilentLogger(),
    ...extras,
  }
  return { rec: new PlateRecognizer(deps), inserts, emits }
}

function trackedPlate(trackId: string, text: string, score: number): TrackedDetectionOut {
  return {
    trackId,
    className: 'car',
    confidence: 0.9,
    bbox: { x: 0, y: 0, w: 100, h: 100 },
    zones: [],
    state: 'moving',
    matchedThisFrame: true,
    settling: false,
    confirmed: true,
    plateText: text,
    plateScore: score,
    plateBbox: { x: 1, y: 2, w: 3, h: 4 },
  }
}

describe('PlateRecognizer — recognition feedback', () => {
  it('onTrackEnd stamps recognizedVehicleId + plateBbox + keyFrame and emits buffered when text matches', async () => {
    const { rec, inserts, emits } = makeRecognizer(
      [{ vehicleId: 'van', text: 'AB123CD' }],
      [{ id: 'van', name: 'Van' }],
    )
    await rec.refreshGallery()
    await rec.processFrame({
      deviceId: 9,
      timestamp: 5,
      frameWidth: 640,
      frameHeight: 360,
      cropPadding: 0,
      tracked: [trackedPlate('t1', 'AB123CD', 0.9)],
    })
    await rec.onTrackEnd(9, 't1')

    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      recognizedVehicleId: 'van',
      keyFrameMediaId: 101,
      plateBbox: { x: 1, y: 2, w: 3, h: 4 },
      assigned: false,
    })
    expect(emits[0]).toMatchObject({
      deviceId: 9,
      plateId: 'plate-t1',
      kind: 'buffered',
    })
  })

  it('asks for the vehicle crop + full frame from the same handle that produced the plate', async () => {
    const onLiveHierarchy = vi.fn()
    const { rec } = makeRecognizer([], [], { onLiveHierarchy })
    await rec.refreshGallery()
    await rec.processFrame({
      deviceId: 9,
      timestamp: 5,
      frameWidth: 640,
      frameHeight: 360,
      cropPadding: 0.05,
      frameHandle: { shmId: 2, nodeId: 'n' } as never,
      tracked: [trackedPlate('t1', 'AB123CD', 0.9)],
    })
    expect(onLiveHierarchy).toHaveBeenCalledWith({
      deviceId: 9,
      trackId: 't1',
      timestamp: 5,
      bodyBbox: { x: 0, y: 0, w: 100, h: 100 },
      frameWidth: 640,
      frameHeight: 360,
      cropPadding: 0.05,
      frameHandle: { shmId: 2, nodeId: 'n' },
    })
  })

  it('exposes the best OCR read score for the NC label-confidence seam; drops it on end', async () => {
    const { rec } = makeRecognizer([], [])
    await rec.refreshGallery()
    await rec.processFrame({
      deviceId: 9,
      timestamp: 5,
      frameWidth: 640,
      frameHeight: 360,
      cropPadding: 0,
      tracked: [trackedPlate('t1', 'AB123CD', 0.55), trackedPlate('t1', 'AB123CD', 0.91)],
    })
    expect(rec.bestLabelMatchConfidence('t1')).toBeCloseTo(0.91)
    await rec.onTrackEnd(9, 't1')
    expect(rec.bestLabelMatchConfidence('t1')).toBeUndefined()
  })

  it('onTrackEnd leaves recognizedVehicleId unset when nothing matches', async () => {
    const { rec, inserts } = makeRecognizer(
      [{ vehicleId: 'van', text: 'AB123CD' }],
      [{ id: 'van', name: 'Van' }],
    )
    await rec.refreshGallery()
    await rec.processFrame({
      deviceId: 9,
      timestamp: 5,
      frameWidth: 640,
      frameHeight: 360,
      cropPadding: 0,
      tracked: [trackedPlate('t9', 'QQ000QQ', 0.9)],
    })
    await rec.onTrackEnd(9, 't9')
    expect(inserts[0]!.recognizedVehicleId).toBeUndefined()
    expect(inserts[0]!.assigned).toBe(false)
  })

  it('observePlateRead (detail plane) collects the best read → onTrackEnd persists it', async () => {
    // Two-plane design: plate-ocr runs on the detail plane, so the read arrives
    // via observePlateRead, NOT processFrame. The gallery must still populate.
    const { rec, inserts, emits } = makeRecognizer([], [])
    await rec.refreshGallery()
    await rec.observePlateRead({
      deviceId: 9,
      trackId: 'tp',
      text: 'DW RO 309',
      score: 0.83,
      bbox: { x: 5, y: 6, w: 7, h: 8 },
      timestamp: 11,
      frameWidth: 640,
      frameHeight: 360,
      cropPadding: 0,
    })
    // A lower-scoring later read must NOT displace the held best.
    await rec.observePlateRead({
      deviceId: 9,
      trackId: 'tp',
      text: 'XXXXX',
      score: 0.2,
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      timestamp: 12,
      frameWidth: 640,
      frameHeight: 360,
      cropPadding: 0,
    })
    await rec.onTrackEnd(9, 'tp')

    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      id: 'plate-tp',
      text: 'DWRO309',
      plateBbox: { x: 5 },
    })
    expect(emits[0]).toMatchObject({ plateId: 'plate-tp', kind: 'buffered' })
  })

  it('resolveLabel returns the vehicle name on match, NORMALIZED text otherwise', async () => {
    const { rec } = makeRecognizer(
      [{ vehicleId: 'van', text: 'AB123CD' }],
      [{ id: 'van', name: 'Van' }],
    )
    await rec.refreshGallery()
    expect(rec.resolveLabel('AB123CD', 0.9)).toBe('Van')
    expect(rec.resolveLabel('ZZ999ZZ', 0.9)).toBe('ZZ999ZZ')
    // Unmatched reads stamp the normalized uppercase alnum form — lowercase /
    // separator residue never reaches track labels.
    expect(rec.resolveLabel('zz 999-zz', 0.9)).toBe('ZZ999ZZ')
    expect(rec.resolveLabel('b2ogghr', 0.9)).toBe('B2OGGHR')
  })

  it('resolveLabel rejects symbol-carrying junk reads (no label stamped)', async () => {
    const { rec } = makeRecognizer([], [])
    await rec.refreshGallery()
    // Live-observed junk labels 2026-07-22 — must never become labels.
    expect(rec.resolveLabel('[miv4o)', 0.9)).toBeNull()
    expect(rec.resolveLabel('6ou.2', 0.9)).toBeNull()
  })
})

describe('PlateRecognizer — durable keyFrame-derived crop fallback (live capture miss)', () => {
  interface Put {
    kind: string
    data: Buffer
  }
  function makeRec(opts: {
    liveCrop: Buffer | null
    derive?: PlateRecognizerDeps['deriveCropFromKeyFrame']
    keyFrameMediaId?: number | undefined
    /** Collect the recognizer's own info lines (the reported-hole assertion). */
    onInfo?: (message: string) => void
  }): {
    rec: PlateRecognizer
    puts: Put[]
    inserts: { mediaId?: number }[]
    deriveArgs: unknown[]
  } {
    const puts: Put[] = []
    const inserts: { mediaId?: number }[] = []
    const deriveArgs: unknown[] = []
    let nextMediaId = 0
    const deps: PlateRecognizerDeps = {
      plateStore: {
        insert: async (p) => {
          inserts.push({
            ...(p.mediaId !== undefined ? { mediaId: p.mediaId } : {}),
          })
        },
      },
      vehicleStore: {
        loadGallery: async () => [],
        listVehicles: async () => [],
      },
      mediaStore: {
        put: async (p) => {
          puts.push({ kind: p.kind, data: p.data })
          nextMediaId += 1
          return nextMediaId
        },
      },
      captureCrop: async () => opts.liveCrop,
      getKeyFrameMediaId: () => ('keyFrameMediaId' in opts ? opts.keyFrameMediaId : 101),
      ...(opts.derive
        ? {
            deriveCropFromKeyFrame: async (input) => {
              deriveArgs.push(input)
              return opts.derive!(input)
            },
          }
        : {}),
      logger: opts.onInfo
        ? { ...makeSilentLogger(), info: (message: string) => opts.onInfo!(message) }
        : makeSilentLogger(),
    }
    return { rec: new PlateRecognizer(deps), puts, inserts, deriveArgs }
  }

  const observe = (rec: PlateRecognizer) =>
    rec.observePlateRead({
      deviceId: 9,
      trackId: 't1',
      text: 'AB123CD',
      score: 0.7,
      bbox: { x: 100, y: 50, w: 40, h: 16 },
      timestamp: 5000,
      frameWidth: 640,
      frameHeight: 360,
      cropPadding: 0.1,
      // A live handle so observeRead invokes captureCrop (the live-tier attempt).
      frameHandle: {
        shmId: 's',
        nodeId: 'n',
      } as unknown as import('@camstack/types').FrameHandle,
    })

  it('recovers the crop from the keyFrame when the live capture missed', async () => {
    const derived = Buffer.from('KEYFRAME-CROP')
    const { rec, puts, inserts, deriveArgs } = makeRec({
      liveCrop: null,
      derive: async () => ({ jpeg: derived, skewMs: 232, motion: 'unknown' }),
    })
    await observe(rec)
    await rec.onTrackEnd(9, 't1')

    // The derived keyFrame crop was persisted as the plate crop.
    expect(puts).toHaveLength(1)
    expect(puts[0]!.kind).toBe('crop')
    expect(puts[0]!.data).toBe(derived)
    expect(inserts[0]!.mediaId).toBe(1)
    // It was fed the retained detail-frame dims + read timestamp for the guard.
    expect(deriveArgs[0]).toMatchObject({
      mediaId: 101,
      frameWidth: 640,
      frameHeight: 360,
      padding: 0.1,
      timestamp: 5000,
    })
  })

  it('persists NO crop when the keyFrame fallback also misses (skew/absent) — row still inserted', async () => {
    const { rec, puts, inserts } = makeRec({
      liveCrop: null,
      derive: async () => null, // guard rejected / no keyframe
    })
    await observe(rec)
    await rec.onTrackEnd(9, 't1')

    expect(puts).toHaveLength(0)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.mediaId).toBeUndefined()
  })

  it('does NOT invoke the keyFrame fallback when the live crop is present', async () => {
    const live = Buffer.from('LIVE')
    const { rec, puts, deriveArgs } = makeRec({
      liveCrop: live,
      derive: async () => ({ jpeg: Buffer.from('KF'), skewMs: 0, motion: 'unknown' }),
    })
    await observe(rec)
    await rec.onTrackEnd(9, 't1')

    expect(deriveArgs).toHaveLength(0)
    expect(puts[0]!.data).toBe(live)
  })

  it('does NOT invoke the keyFrame fallback when no keyFrame key exists', async () => {
    const { rec, puts, deriveArgs } = makeRec({
      liveCrop: null,
      derive: async () => ({ jpeg: Buffer.from('KF'), skewMs: 0, motion: 'unknown' }),
      keyFrameMediaId: undefined,
    })
    await observe(rec)
    await rec.onTrackEnd(9, 't1')

    expect(deriveArgs).toHaveLength(0)
    expect(puts).toHaveLength(0)
  })

  /**
   * The same fallback over the REAL `createKeyFrameCrop`, on the two vehicles
   * the operator marked: a crossing car whose stored crop was gravel
   * (`4126f977`, skew 531 ms) and a parked one whose crop was perfect
   * (`7613c0fa`, skew 2579 ms). The plate read is at 5000 ms in both; only the
   * trail differs, so no outcome here can be attributed to the time bound.
   */
  describe('with the real crop guard wired', () => {
    const KEY_FRAME_AT = 4_400 // 600 ms before the read — well inside 1500 ms

    function trail(pxPerSecond: number): SubjectPathSample[] {
      const path: SubjectPathSample[] = []
      for (let ms = 4_000; ms <= 6_000; ms += 100) {
        const x = ((ms - 4_000) / 1000) * pxPerSecond
        path.push({ timestamp: ms, bbox: { x, y: 40, w: 120, h: 90 } })
      }
      return path
    }

    function realDerive(): PlateRecognizerDeps['deriveCropFromKeyFrame'] {
      return createKeyFrameCrop({
        getMedia: async () => ({ bytes: Buffer.from('kf'), timestamp: KEY_FRAME_AT }),
        decodeJpegToRgb: async () => ({
          bytes: Buffer.from([1, 2, 3]),
          width: 1920,
          height: 1080,
        }),
        cropRegionToJpeg: async () => Buffer.from('KEYFRAME-CROP'),
        maxSkewMs: 1500,
        minSubjectIou: 0.5,
        maxSubjectSampleGapMs: 1000,
        logger: makeSilentLogger(),
      })
    }

    it('a CROSSING vehicle: no crop is stored, and the hole is reported', async () => {
      const infos: string[] = []
      const { rec, puts, inserts } = makeRec({
        liveCrop: null,
        derive: realDerive(),
        onInfo: (message) => infos.push(message),
      })
      await observe(rec)
      await rec.onTrackEnd(9, 't1', trail(300))

      expect(puts).toHaveLength(0)
      // The plate row still lands — the TEXT was read off the right frame.
      expect(inserts).toHaveLength(1)
      expect(inserts[0]!.mediaId).toBeUndefined()
      expect(infos).toContain('plate crop not recovered — keyFrame derive refused or missed')
    })

    it('a PARKED vehicle at the identical skew: the crop is stored', async () => {
      const { rec, puts, inserts } = makeRec({ liveCrop: null, derive: realDerive() })
      await observe(rec)
      await rec.onTrackEnd(9, 't1', trail(0))

      expect(puts).toHaveLength(1)
      expect(puts[0]!.data.toString()).toBe('KEYFRAME-CROP')
      expect(inserts[0]!.mediaId).toBe(1)
    })

    it('a PARKED vehicle BEYOND the time bound is still stored (the 7613c0fa rescue)', async () => {
      const { rec, puts } = makeRec({
        liveCrop: null,
        derive: createKeyFrameCrop({
          // 2579 ms before the read — the real `7613c0fa` skew, past 1500 ms.
          getMedia: async () => ({ bytes: Buffer.from('kf'), timestamp: 5_000 - 2_579 }),
          decodeJpegToRgb: async () => ({
            bytes: Buffer.from([1, 2, 3]),
            width: 1920,
            height: 1080,
          }),
          cropRegionToJpeg: async () => Buffer.from('KEYFRAME-CROP'),
          maxSkewMs: 1500,
          minSubjectIou: 0.5,
          maxSubjectSampleGapMs: 3000,
          logger: makeSilentLogger(),
        }),
      })
      await observe(rec)
      await rec.onTrackEnd(9, 't1', trail(0))

      expect(puts).toHaveLength(1)
      expect(puts[0]!.data.toString()).toBe('KEYFRAME-CROP')
    })

    it('NO trail: the time bound alone decides, exactly as before the guard', async () => {
      const within = makeRec({ liveCrop: null, derive: realDerive() })
      await observe(within.rec)
      await within.rec.onTrackEnd(9, 't1')
      expect(within.puts).toHaveLength(1)
    })
  })
})

describe('PlateRecognizer — the track VOTES, it does not argmax', () => {
  /**
   * The live failure: `holdBest` stored the single read with the top OCR score,
   * and score does not correlate with correctness. Here the best-scoring read
   * ("DNRO3O9", 0.9) is wrong in one glyph and the two lower-scoring reads
   * agree on the right one.
   */
  it('persists the per-character winner, not the highest-scoring read', async () => {
    const { rec, inserts } = makeRecognizer([], [])
    await rec.refreshGallery()
    for (const [text, score] of [
      ['DNRO3O9', 0.9],
      ['DNRO309', 0.6],
      ['DNR0309', 0.55],
    ] as const) {
      await rec.observePlateRead({
        deviceId: 9,
        trackId: 'tv',
        text,
        score,
        bbox: { x: 1, y: 2, w: 3, h: 4 },
        timestamp: 5,
        frameWidth: 640,
        frameHeight: 360,
        cropPadding: 0,
      })
    }
    await rec.onTrackEnd(9, 'tv')

    expect(inserts).toHaveLength(1)
    expect(inserts[0]?.text).toBe('DNRO309')
  })

  it('still reports the BEST read score to the NC label-confidence seam', async () => {
    const { rec } = makeRecognizer([], [])
    await rec.refreshGallery()
    for (const [text, score] of [
      ['DNRO3O9', 0.9],
      ['DNRO309', 0.6],
    ] as const) {
      await rec.observePlateRead({
        deviceId: 9,
        trackId: 'tv',
        text,
        score,
        bbox: { x: 1, y: 2, w: 3, h: 4 },
        timestamp: 5,
        frameWidth: 640,
        frameHeight: 360,
        cropPadding: 0,
      })
    }
    expect(rec.bestLabelMatchConfidence('tv')).toBeCloseTo(0.9)
  })

  it('keeps the crop + bbox of the MAX-SCORE read for the gallery tile', async () => {
    // The vote decides the TEXT; the picture the operator reviews stays the
    // sharpest frame the track produced.
    const { rec, inserts } = makeRecognizer([], [])
    await rec.refreshGallery()
    for (const [text, score, x] of [
      ['DNRO309', 0.6, 11],
      ['DNRO3O9', 0.9, 22],
      ['DNR0309', 0.55, 33],
    ] as const) {
      await rec.observePlateRead({
        deviceId: 9,
        trackId: 'tv',
        text,
        score,
        bbox: { x, y: 2, w: 3, h: 4 },
        timestamp: 5,
        frameWidth: 640,
        frameHeight: 360,
        cropPadding: 0,
      })
    }
    await rec.onTrackEnd(9, 'tv')
    expect(inserts[0]?.plateBbox).toMatchObject({ x: 22 })
  })
})

describe('PlateRecognizer — a dropped read says so', () => {
  interface LogLine {
    readonly message: string
    readonly meta: Record<string, unknown> | undefined
    readonly trackId: unknown
  }

  function makeRecordingRecognizer(): {
    rec: PlateRecognizer
    lines: LogLine[]
  } {
    const lines: LogLine[] = []
    const capture = (
      message: string,
      extras?: {
        meta?: Record<string, unknown>
        tags?: Record<string, unknown>
      },
    ): void => {
      lines.push({
        message,
        meta: extras?.meta,
        trackId: extras?.tags?.['trackId'],
      })
    }
    const logger: IScopedLogger = {
      debug: capture,
      info: capture,
      warn: capture,
      error: capture,
      child: () => logger,
      withTags: () => logger,
    }
    const deps: PlateRecognizerDeps = {
      plateStore: { insert: async () => {} },
      vehicleStore: {
        loadGallery: async () => [],
        listVehicles: async () => [],
      },
      mediaStore: { put: async () => 1 },
      captureCrop: async () => Buffer.from([1]),
      logger,
    }
    return { rec: new PlateRecognizer(deps), lines }
  }

  it('logs the read it discards, with the camera and the track', async () => {
    // "6O" is implausible (too short, no digit/letter mix). Discarding it
    // silently is how a camera looks like it never saw a plate at all.
    const { rec, lines } = makeRecordingRecognizer()
    await rec.observePlateRead({
      deviceId: 102,
      trackId: 'tdrop',
      text: '6O',
      score: 0.8,
      bbox: { x: 1, y: 2, w: 3, h: 4 },
      timestamp: 5,
      frameWidth: 640,
      frameHeight: 360,
      cropPadding: 0,
    })
    const drops = lines.filter((l) => l.message === 'plate: read discarded')
    expect(drops).toHaveLength(1)
    expect(drops[0]?.trackId).toBe('tdrop')
    expect(drops[0]?.meta).toMatchObject({ text: '6O', reason: 'implausible' })
  })

  it('logs a read dropped by the confidence floor separately', async () => {
    const { rec, lines } = makeRecordingRecognizer()
    await rec.observePlateRead({
      deviceId: 102,
      trackId: 'tdrop',
      text: 'DNRO309',
      score: 0.5,
      minConfidence: 0.8,
      bbox: { x: 1, y: 2, w: 3, h: 4 },
      timestamp: 5,
      frameWidth: 640,
      frameHeight: 360,
      cropPadding: 0,
    })
    const drops = lines.filter((l) => l.message === 'plate: read discarded')
    expect(drops).toHaveLength(1)
    expect(drops[0]?.meta).toMatchObject({ reason: 'below-min-confidence' })
  })
})
