/**
 * The parked frame's subject box reaches the MEDIA ROW (D510).
 *
 * This is the one write site where the box is free: the park already kept it
 * beside the parcel (D422), measured on the very frame the parcel holds. If it
 * is dropped here the summary is back to pairing a keyFrame with the nearest
 * stored position — which is the defect D510 exists to end — and nothing else
 * in the system would say so, because a frame without a box looks exactly like
 * a frame with the wrong one from the outside.
 *
 * The companion `keyFrameSmall` is asserted too: it is derived from these very
 * bytes, so a box that rode on one and not the other would make the answer
 * depend on which row a reader happened to pick.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { MediaSubjectBox } from '../../store/media-store.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import {
  persistTrackKeyFrame,
  type KeyFrameMediaWriter,
  type ParkedKeyFrame,
} from '../key-frame-persist.js'

const SUBJECT: MediaSubjectBox = { x: 100, y: 50, w: 80, h: 120, frameWidth: 640, frameHeight: 360 }

function silentLogger(): IScopedLogger {
  return makeSilentLogger()
}

interface Written {
  readonly kind: string
  readonly subjectBox?: MediaSubjectBox
}

async function run(parcel: ParkedKeyFrame | null): Promise<readonly Written[]> {
  const written: Written[] = []
  const media: KeyFrameMediaWriter = {
    putReplacing: async (input) => {
      written.push({
        kind: input.kind,
        ...(input.subjectBox !== undefined ? { subjectBox: input.subjectBox } : {}),
      })
      return 1
    },
  }
  await persistTrackKeyFrame(
    {
      fetchParkedKeyFrame: async () => parcel,
      deriveSmall: async (jpeg) => jpeg,
      media,
      logger: silentLogger(),
    },
    { deviceId: 102, trackId: 'track-1', retry: false },
  )
  return written
}

function parcelWith(subject: MediaSubjectBox | undefined): ParkedKeyFrame {
  return {
    jpeg: Buffer.from('native-jpeg-from-the-node'),
    width: 3840,
    height: 2160,
    timestamp: 1_700_000_000_000,
    nodeId: 'unraid',
    ...(subject !== undefined ? { subject } : {}),
  }
}

describe('the parked key frame writes its subject box onto the media row', () => {
  it('stamps BOTH the keyFrame and its small companion with the parked box', async () => {
    const written = await run(parcelWith(SUBJECT))
    expect(written.map((w) => w.kind)).toEqual(['keyFrame', 'keyFrameSmall'])
    expect(written[0]?.subjectBox).toEqual(SUBJECT)
    expect(written[1]?.subjectBox).toEqual(SUBJECT)
  })

  it('writes NO box when the park kept none — the pre-D510 row, unchanged', async () => {
    const written = await run(parcelWith(undefined))
    expect(written).toHaveLength(2)
    expect(written[0]?.subjectBox).toBeUndefined()
    expect(written[1]?.subjectBox).toBeUndefined()
  })

  it('refuses a degenerate box rather than storing one that says nothing', async () => {
    // A zero-area rectangle, or one measured on a zero-sized frame, cannot be
    // drawn anywhere honest. Absent is the answer; the reader then pairs a
    // snapshot exactly as it did before.
    for (const bad of [
      { ...SUBJECT, w: 0 },
      { ...SUBJECT, h: 0 },
      { ...SUBJECT, frameWidth: 0 },
      { ...SUBJECT, frameHeight: 0 },
    ]) {
      const written = await run(parcelWith(bad))
      expect(written[0]?.subjectBox, JSON.stringify(bad)).toBeUndefined()
    }
  })
})
