/**
 * Which picture the summary boxes, and where the box comes from (D510).
 *
 * The rule under test is the ORDER: a media row that carries its own box wins
 * over the snapshot pairing, because its rectangle was recorded on that exact
 * frame and the pairing's was not. Everything else here exists to pin the
 * boundaries of that claim — a tie between two encodes of one surface, a row
 * that carries nothing, and the fallback that must survive untouched for every
 * row written before the column existed.
 */
import { describe, expect, it } from 'vitest'
import type { MediaSubjectBoxRow } from '../media-store.js'
import {
  pickSubjectShotRow,
  resolveSubjectShot,
  type SubjectShotPorts,
  type SubjectShotSnapshot,
} from '../media-subject-shot.js'

const FRAME = { frameWidth: 640, frameHeight: 360 } as const

function boxedRow(
  mediaId: number,
  kind: MediaSubjectBoxRow['kind'],
  timestamp: number,
  x: number,
): MediaSubjectBoxRow {
  return { mediaId, kind, timestamp, subjectBox: { x, y: 10, w: 40, h: 80, ...FRAME } }
}

function snapshot(mediaId: number, timestamp: number, x: number): SubjectShotSnapshot {
  return { mediaId, timestamp, bbox: { x, y: 1, w: 2, h: 3 } }
}

function ports(over: Partial<SubjectShotPorts>): SubjectShotPorts {
  return {
    boxedMedia: async () => [],
    trackSnapshots: async () => [],
    frameDims: () => ({ w: 640, h: 360 }),
    ...over,
  }
}

describe('pickSubjectShotRow', () => {
  it('takes the row nearest the instant asked for', () => {
    const rows = [
      boxedRow(1, 'keyFrame', 1_000, 10),
      boxedRow(2, 'keyFrame', 5_000, 20),
      boxedRow(3, 'keyFrame', 9_000, 30),
    ]
    expect(pickSubjectShotRow(rows, 5_400)?.mediaId).toBe(2)
  })

  it('breaks a tie on pixels — keyFrame over its small companion', () => {
    // The two are one surface encoded twice and share a timestamp EXACTLY, so
    // this tie is the common case, not a corner. Asserted in both input orders
    // because "whichever came first" is not a rule.
    const big = boxedRow(1, 'keyFrame', 5_000, 10)
    const small = boxedRow(2, 'keyFrameSmall', 5_000, 10)
    expect(pickSubjectShotRow([big, small], 5_000)?.mediaId).toBe(1)
    expect(pickSubjectShotRow([small, big], 5_000)?.mediaId).toBe(1)
  })

  it('is null on no rows — nothing here can say where the subject was', () => {
    expect(pickSubjectShotRow([], 5_000)).toBeNull()
  })
})

describe('resolveSubjectShot', () => {
  it('prefers the media row that carries its OWN box over any snapshot', async () => {
    // The point of D510, reduced: the snapshot is NEARER in time and still
    // loses, because the boxed row needs no pairing at all — its rectangle was
    // measured on the very frame its blob holds.
    const shot = await resolveSubjectShot(
      ports({
        boxedMedia: async () => [boxedRow(77, 'keyFrame', 4_000, 123)],
        trackSnapshots: async () => [snapshot(99, 5_000, 7)],
      }),
      'track-1',
      101,
      5_000,
    )
    expect(shot).toEqual({
      mediaId: 77,
      source: 'media-box',
      bbox: { x: 123, y: 10, w: 40, h: 80 },
      frameWidth: 640,
      frameHeight: 360,
    })
  })

  it('states the frame the BOX was measured on, not the device’s current one', async () => {
    // A boxed row is self-describing: it must not be scaled by whatever the
    // camera happens to be streaming now. A device that changed resolution
    // mid-day would otherwise move every old box sideways.
    const shot = await resolveSubjectShot(
      ports({
        boxedMedia: async () => [
          {
            mediaId: 5,
            kind: 'keyFrame',
            timestamp: 1,
            subjectBox: { x: 1, y: 2, w: 3, h: 4, frameWidth: 1920, frameHeight: 1080 },
          },
        ],
        frameDims: () => ({ w: 640, h: 360 }),
      }),
      'track-1',
      101,
      1,
    )
    expect(shot?.frameWidth).toBe(1920)
    expect(shot?.frameHeight).toBe(1080)
  })

  it('falls back to the nearest snapshot when no row carries a box — the pre-D510 rows, forever', async () => {
    const shot = await resolveSubjectShot(
      ports({
        boxedMedia: async () => [],
        trackSnapshots: async () => [snapshot(1, 1_000, 5), snapshot(2, 6_000, 6)],
      }),
      'track-1',
      101,
      5_500,
    )
    expect(shot?.mediaId).toBe(2)
    expect(shot?.frameWidth).toBe(640)
  })

  it('is null when neither source can answer — a missing box, never an invented one', async () => {
    expect(await resolveSubjectShot(ports({}), 'track-1', 101, 5_000)).toBeNull()
  })

  it('is null when the fallback has snapshots but no frame size to scale them by', async () => {
    const shot = await resolveSubjectShot(
      ports({ trackSnapshots: async () => [snapshot(1, 1_000, 5)], frameDims: () => undefined }),
      'track-1',
      101,
      1_000,
    )
    expect(shot).toBeNull()
  })

  it('does NOT need a frame size when the row carries its own box', async () => {
    // The old path could only answer for a device this process had seen a
    // frame from. A boxed row lifts that condition entirely — which is most of
    // why a digest rendered after a restart can still be boxed.
    const shot = await resolveSubjectShot(
      ports({
        boxedMedia: async () => [boxedRow(42, 'keyFrame', 1_000, 8)],
        frameDims: () => undefined,
      }),
      'track-1',
      101,
      1_000,
    )
    expect(shot?.mediaId).toBe(42)
  })
})

describe('the shot says WHERE its rectangle came from', () => {
  // Without this the two paths are indistinguishable from outside: a digest
  // boxed by a media row and one boxed by the old snapshot pairing produce the
  // identical `boxed=1`. So the day the capture-time box stops being written,
  // the log keeps saying the same thing it said when it worked.
  it('is media-box when the row carried its own rectangle', async () => {
    const shot = await resolveSubjectShot(
      ports({ boxedMedia: async () => [boxedRow(42, 'keyFrame', 1_000, 8)] }),
      'track-1',
      101,
      1_000,
    )
    expect(shot?.source).toBe('media-box')
  })

  it('is snapshot when it fell back to the pairing', async () => {
    const shot = await resolveSubjectShot(
      ports({ trackSnapshots: async () => [snapshot(7, 1_000, 5)] }),
      'track-1',
      101,
      1_000,
    )
    expect(shot?.source).toBe('snapshot')
  })
})
