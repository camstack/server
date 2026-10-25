/**
 * The DETAIL crop-source ladder: `frameHandle` → `frameJpeg` → `cropJpeg`.
 *
 * Until 2026-08-07 the middle rung was DEAD CODE. `resolveCrop` had a
 * `frameJpeg` branch and the only live caller — the detail dispatcher — never
 * sent the field, so an enrichment dispatch whose native lease had already
 * expired had exactly one fallback (`cropJpeg`), itself cut by the SAME
 * native-strict capture that had just missed. Both halves failed together, three
 * times in a row, and the step was abandoned for the track forever.
 *
 * These cases pin the ladder itself — which rung wins, what each one produces,
 * and that a miss on the first rung is REPORTED with the runner's own
 * classification rather than collapsing to a bare `null` the caller cannot read.
 */
import { describe, it, expect, vi } from 'vitest'
import type {
  DetailCropConvention,
  DetailParent,
  FrameHandle,
  FrameResult,
  ObjectDetection,
  PipelineStepInputOutput,
} from '@camstack/types'
import { DEFAULT_DETAIL_CROP_CONVENTION, deriveDetailCropRect } from '@camstack/types'
import { type DetailSubtreeDeps, runDetailSubtree } from '../detail-subtree.js'

const DEVICE_ID = 42

interface CapturedWarn {
  readonly message: string
  readonly meta: Record<string, unknown>
}

function recordingLogger(sink: CapturedWarn[]): DetailSubtreeDeps['logger'] {
  return {
    warn: (message: string, fields?: { meta?: Record<string, unknown> }) => {
      sink.push({ message, meta: fields?.meta ?? {} })
    },
  }
}

function makeFrameHandle(overrides: Partial<FrameHandle> = {}): FrameHandle {
  return {
    shmId: 'seg-1',
    slot: 0,
    seq: 1,
    width: 640,
    height: 360,
    format: 'rgb',
    pts: 0,
    byteLength: 640 * 360 * 3,
    nodeId: 'hub',
    slotCount: 4,
    ...overrides,
  }
}

function makeParent(overrides: Partial<DetailParent> = {}): DetailParent {
  return {
    bbox: { x: 100, y: 100, w: 50, h: 80 },
    className: 'dog',
    ...overrides,
  }
}

function makeStep(addonId: string): PipelineStepInputOutput {
  return { addonId, modelId: 'm', enabled: true }
}

function makeFrameResult(detections: readonly ObjectDetection[]): FrameResult {
  return {
    kind: 'frame',
    frameId: 'f1',
    deviceId: DEVICE_ID,
    timestamp: 0,
    width: 10,
    height: 10,
    detections,
  }
}

async function solidJpeg(width: number, height: number): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  return sharp(Buffer.alloc(width * height * 3, 90), {
    raw: { width, height, channels: 3 },
  })
    .jpeg()
    .toBuffer()
}

describe('detail crop-source ladder', () => {
  it('(1) a native HIT wins over a supplied frameJpeg — and only the native rung yields a nativeCropRef', async () => {
    const frameHandle = makeFrameHandle()
    const nativeJpeg = await solidJpeg(65, 104)
    const fullFrame = await solidJpeg(640, 360)
    const runPipeline = vi.fn().mockResolvedValue(makeFrameResult([]))

    const deps: DetailSubtreeDeps = {
      resolveCropConvention: () => DEFAULT_DETAIL_CROP_CONVENTION,
      logger: recordingLogger([]),
      resolveChildSteps: vi.fn().mockReturnValue([makeStep('clip-embedding')]),
      getNativeCrop: vi.fn().mockResolvedValue({
        jpeg: nativeJpeg,
        width: 65,
        height: 104,
        frameSpace: { x: 92.5, y: 88, w: 65, h: 104 },
      }),
      runPipeline,
    }

    await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle,
      frameJpeg: fullFrame.toString('base64'),
      parent: makeParent(),
      steps: ['clip-embedding'],
    })

    expect(runPipeline).toHaveBeenCalledTimes(1)
    const [, image, , , nativeCropRef] = runPipeline.mock.calls[0] as [
      unknown,
      Buffer,
      number,
      unknown,
      unknown,
    ]
    expect(image.equals(nativeJpeg)).toBe(true)
    expect(nativeCropRef).toEqual({
      handle: frameHandle,
      cropFrameSpace: { x: 92.5, y: 88, w: 65, h: 104 },
    })
  })

  it('(2) native MISS + frameJpeg — the RUNNER cuts the detail rect out of the full frame, with no nativeCropRef', async () => {
    const convention: DetailCropConvention = {
      paddingRatio: 0.15,
      square: false,
    }
    const parent = makeParent()
    const fullFrame = await solidJpeg(640, 360)
    const runPipeline = vi.fn().mockResolvedValue(makeFrameResult([]))

    const deps: DetailSubtreeDeps = {
      resolveCropConvention: () => convention,
      logger: recordingLogger([]),
      resolveChildSteps: vi.fn().mockReturnValue([makeStep('clip-embedding')]),
      // The lease is gone — exactly the production shape this rung exists for.
      getNativeCrop: vi.fn().mockResolvedValue({ miss: 'worker-lease-gone', handleAgeMs: 1830 }),
      runPipeline,
    }

    await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle: makeFrameHandle(),
      frameJpeg: fullFrame.toString('base64'),
      parent,
      steps: ['clip-embedding'],
    })

    expect(runPipeline).toHaveBeenCalledTimes(1)
    const [, image, , , nativeCropRef] = runPipeline.mock.calls[0] as [
      unknown,
      Buffer,
      number,
      unknown,
      unknown,
    ]
    // The image handed to the executor is the CUT, not the full frame — and its
    // rectangle comes from the one shared derivation, not a local arithmetic.
    const expected = deriveDetailCropRect(parent.bbox, 640, 360, convention)
    const sharp = (await import('sharp')).default
    const meta = await sharp(image).metadata()
    expect(meta.width).toBe(Math.round(expected.w))
    expect(meta.height).toBe(Math.round(expected.h))
    expect(meta.width).not.toBe(640)
    // No live native surface behind a derived tile: children must stay on it.
    expect(nativeCropRef).toBeUndefined()
  })

  it('(3) frameJpeg outranks cropJpeg — the pre-cut tile is only reached when no full frame arrived', async () => {
    const fullFrame = await solidJpeg(640, 360)
    const tile = await solidJpeg(20, 30)
    const runPipeline = vi.fn().mockResolvedValue(makeFrameResult([]))
    const deps: DetailSubtreeDeps = {
      resolveCropConvention: () => DEFAULT_DETAIL_CROP_CONVENTION,
      logger: recordingLogger([]),
      resolveChildSteps: vi.fn().mockReturnValue([makeStep('clip-embedding')]),
      getNativeCrop: vi.fn().mockResolvedValue(null),
      runPipeline,
    }

    await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle: makeFrameHandle(),
      frameJpeg: fullFrame.toString('base64'),
      cropJpeg: tile.toString('base64'),
      parent: makeParent(),
      steps: ['clip-embedding'],
    })

    const sharp = (await import('sharp')).default
    const meta = await sharp(runPipeline.mock.calls[0]![1] as Buffer).metadata()
    // 20x30 would mean the verbatim tile won; the derived rect is 65x104.
    expect(meta.width).toBe(65)
  })

  it('(4) no source resolves — the drop line carries the runner-side miss reason and the handle age', async () => {
    const warns: CapturedWarn[] = []
    const deps: DetailSubtreeDeps = {
      resolveCropConvention: () => DEFAULT_DETAIL_CROP_CONVENTION,
      logger: recordingLogger(warns),
      resolveChildSteps: vi.fn().mockReturnValue([makeStep('clip-embedding')]),
      getNativeCrop: vi.fn().mockResolvedValue({ miss: 'no-registry-entry', handleAgeMs: null }),
      runPipeline: vi.fn(),
    }

    const result = await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle: makeFrameHandle(),
      parent: makeParent(),
      steps: ['clip-embedding'],
    })

    expect(result).toBeNull()
    const drop = warns.find((w) => w.message.includes('no crop source resolved'))
    expect(drop).toBeDefined()
    // The half of the diagnostic pair the CALLER cannot know. Without it the
    // line says only "nothing resolved", which is the state we already had.
    expect(drop!.meta['nativeMissReason']).toBe('no-registry-entry')
    expect(drop!.meta['hadFrameJpeg']).toBe(false)
  })

  // 2026-09-30, the live fleet: `native crop refused … handle-expired` ~7 times
  // per handle, ~480 an hour, every one of them the dispatcher re-asking for a
  // handle the registry had already refused. A `null` could not tell it that
  // THIS handle is finished — only that this dispatch found nothing.
  it('(5) a handle refused as EXPIRED is a TYPED refusal, not a bare null — the caller must retire the handle', async () => {
    const deps: DetailSubtreeDeps = {
      resolveCropConvention: () => DEFAULT_DETAIL_CROP_CONVENTION,
      logger: recordingLogger([]),
      resolveChildSteps: vi.fn().mockReturnValue([makeStep('clip-embedding')]),
      getNativeCrop: vi.fn().mockResolvedValue({ miss: 'handle-expired', handleAgeMs: 30934 }),
      runPipeline: vi.fn(),
    }

    const result = await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle: makeFrameHandle(),
      parent: makeParent(),
      steps: ['clip-embedding'],
    })

    expect(result).toEqual({ refusal: 'handle-expired', handleAgeMs: 30934 })
    expect(deps.runPipeline).not.toHaveBeenCalled()
  })

  it('(6) every OTHER native miss stays a null — only the registry refusal is final for the handle', async () => {
    const deps: DetailSubtreeDeps = {
      resolveCropConvention: () => DEFAULT_DETAIL_CROP_CONVENTION,
      logger: recordingLogger([]),
      resolveChildSteps: vi.fn().mockReturnValue([makeStep('clip-embedding')]),
      getNativeCrop: vi.fn().mockResolvedValue({ miss: 'worker-lease-gone', handleAgeMs: 1830 }),
      runPipeline: vi.fn(),
    }

    const result = await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle: makeFrameHandle(),
      parent: makeParent(),
      steps: ['clip-embedding'],
    })

    expect(result).toBeNull()
  })
})
