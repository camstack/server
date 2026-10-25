/**
 * `attachAppearanceDescriptors` (D683 §8.1): every first-level box gets a
 * descriptor from its own crop; detail boxes never do; a box whose crop
 * cannot be read keeps no descriptor and is COUNTED, never silently skipped.
 *
 * Disarms (each alone, restored):
 *  - drop the `kind === 'first-level'` filter: "describes first-level boxes only" fails;
 *  - ignore `scope`: "in 'candidates' scope, describes only the candidate boxes" fails.
 *
 * `attachAppearanceIfEnabled` (fix round 1, coordinator ruling 2026-09-30 on
 * the Task 10 cost-bench STOP): appearance is off by default until Task 23
 * calibrates it, so a disabled camera must cost NOTHING extra per frame — no
 * crop, no resample, no descriptor.
 *
 * Disarm (fix round 1):
 *  - always compute (drop the `enabled` check): the disabled test fails,
 *    because `computeAppearanceDescriptor` IS called.
 */
import type { FrameResult, ObjectDetection } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { attachAppearanceDescriptors, attachAppearanceIfEnabled } from '../appearance-attach.js'
import type { RgbView } from '../appearance-descriptor.js'
import * as appearanceDescriptorModule from '../appearance-descriptor.js'

vi.mock('../appearance-descriptor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../appearance-descriptor.js')>()
  return { ...actual, computeAppearanceDescriptor: vi.fn(actual.computeAppearanceDescriptor) }
})

function det(id: string, kind: ObjectDetection['kind'], x: number): ObjectDetection {
  return {
    id,
    kind,
    macroClass: kind === 'detail' ? 'face' : 'person',
    score: 0.9,
    labels: [],
    bbox: { x, y: 10, width: 100, height: 200 },
  }
}

const frame: FrameResult = {
  kind: 'frame',
  frameId: 'f',
  deviceId: 1,
  timestamp: 0,
  width: 640,
  height: 360,
  detections: [
    det('p1', 'first-level', 10),
    det('f1', 'detail', 20),
    det('p2', 'first-level', 300),
  ],
}

const red: RgbView = {
  data: new Uint8Array(16 * 32 * 3).fill(0).map((_, i) => (i % 3 === 0 ? 220 : 10)),
  width: 16,
  height: 32,
}

describe('attachAppearanceDescriptors', () => {
  it('describes first-level boxes only and counts what it did', async () => {
    const out = await attachAppearanceDescriptors(frame, async () => red)
    expect(out.result.detections.map((d) => d.appearance !== undefined)).toEqual([
      true,
      false,
      true,
    ])
    expect(out.cost).toMatchObject({ attached: 2, failed: 0, tooSmall: 0 })
  })

  it('a crop that cannot be read is counted and left undescribed', async () => {
    const out = await attachAppearanceDescriptors(frame, async () => null)
    expect(out.result.detections.every((d) => d.appearance === undefined)).toBe(true)
    expect(out.cost.failed).toBe(2)
  })

  it("in 'candidates' scope, describes only the candidate boxes", async () => {
    const out = await attachAppearanceDescriptors(frame, async () => red, {
      scope: 'candidates',
      isCandidate: (i) => i === 2,
    })
    expect(out.result.detections.map((d) => d.appearance !== undefined)).toEqual([
      false,
      false,
      true,
    ])
    expect(out.cost.skippedScope).toBe(1)
  })

  it('returns the same result object when there is nothing to describe', async () => {
    const empty: FrameResult = { ...frame, detections: [] }
    expect((await attachAppearanceDescriptors(empty, async () => red)).result).toBe(empty)
  })
})

describe('attachAppearanceIfEnabled', () => {
  it('disabled: computeAppearanceDescriptor is never called, and no crop is even requested', async () => {
    const spy = vi.mocked(appearanceDescriptorModule.computeAppearanceDescriptor)
    spy.mockClear()
    const readView = vi.fn(async () => red)
    const out = await attachAppearanceIfEnabled(false, frame, readView, {
      scope: 'candidates',
      isCandidate: () => true,
    })
    expect(spy).not.toHaveBeenCalled()
    expect(readView).not.toHaveBeenCalled()
    expect(out.result).toBe(frame)
    expect(out.cost).toEqual({ attached: 0, tooSmall: 0, failed: 0, skippedScope: 0, ms: 0 })
  })

  it('enabled: computeAppearanceDescriptor IS called, honouring scope candidates', async () => {
    const spy = vi.mocked(appearanceDescriptorModule.computeAppearanceDescriptor)
    spy.mockClear()
    const out = await attachAppearanceIfEnabled(true, frame, async () => red, {
      scope: 'candidates',
      isCandidate: (i) => i === 2,
    })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(out.result.detections.map((d) => d.appearance !== undefined)).toEqual([
      false,
      false,
      true,
    ])
  })
})
