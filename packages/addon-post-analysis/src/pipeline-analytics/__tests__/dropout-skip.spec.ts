import { describe, it, expect } from 'vitest'
import { dropoutEvidenceCount, shouldSkipDropoutFrame } from '../pipeline/dropout-skip.js'

const cfg = { enabled: true, maxSkipFrames: 5 }

describe('shouldSkipDropoutFrame', () => {
  it('skips a zero-detection frame while tracks are active and budget remains', () => {
    expect(shouldSkipDropoutFrame(2, 0, 0, cfg)).toBe(true)
    expect(shouldSkipDropoutFrame(2, 0, 4, cfg)).toBe(true)
  })

  it('does not skip once the consecutive-skip budget is exhausted', () => {
    expect(shouldSkipDropoutFrame(2, 0, 5, cfg)).toBe(false)
  })

  it('does not skip when the frame has detections', () => {
    expect(shouldSkipDropoutFrame(2, 1, 0, cfg)).toBe(false)
  })

  it('does not skip when there are no active tracks to protect', () => {
    expect(shouldSkipDropoutFrame(0, 0, 0, cfg)).toBe(false)
  })

  it('does not skip when disabled', () => {
    expect(shouldSkipDropoutFrame(2, 0, 0, { enabled: false, maxSkipFrames: 5 })).toBe(false)
  })
})

describe('dropoutEvidenceCount (D665)', () => {
  const base = {
    kind: 'frame' as const,
    frameId: 'f',
    deviceId: 104,
    timestamp: 1,
    width: 1280,
    height: 720,
    detections: [],
  }

  it('a frame carrying only a sub-floor person is NOT empty — the tracker must see it', () => {
    const frame = {
      ...base,
      discarded: [
        {
          bbox: [0, 0, 60, 150] as const,
          macroClass: 'person',
          score: 0.5,
          reason: 'below-threshold' as const,
        },
      ],
    }
    expect(dropoutEvidenceCount(frame, 0.35)).toBe(1)
    expect(
      shouldSkipDropoutFrame(2, dropoutEvidenceCount(frame, 0.35), 0, {
        enabled: true,
        maxSkipFrames: 5,
      }),
    ).toBe(false)
  })

  it('with the tier off, or nothing continuable, the frame is empty as before', () => {
    const frame = {
      ...base,
      discarded: [
        {
          bbox: [0, 0, 60, 150] as const,
          macroClass: 'person',
          score: 0.2,
          reason: 'below-threshold' as const,
        },
      ],
    }
    expect(dropoutEvidenceCount(frame, 0.35)).toBe(0)
    expect(
      dropoutEvidenceCount(
        { ...base, discarded: frame.discarded.map((d) => ({ ...d, score: 0.5 })) },
        null,
      ),
    ).toBe(0)
  })
})
