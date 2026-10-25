/**
 * Copy-vs-encode for an egress transcode — the satisfaction matrix.
 *
 * The operator asked for the decision to be automatic: "request h264 on an h265
 * source ⇒ transcode; request h264 on an h264 source with nothing else to
 * satisfy ⇒ hand the bytes over". Before this, `startChild` passed
 * `forceReencode: true` unconditionally and the primitive re-encoded a stream
 * that already satisfied the request.
 *
 * The rule is CONSERVATIVE BY CONSTRUCTION: copy only when EVERY requested
 * constraint is provably satisfied by a KNOWN source fact. An unknown fact is
 * never assumed to be satisfied — `CameraStream` carries no bitrate, no profile
 * and no level, so any request naming one of those encodes, forever, and that
 * is the correct answer rather than a gamble on a stream nobody measured.
 */
import { describe, expect, it } from 'vitest'

import { decideEgressCopy, type EgressSourceFacts } from '../egress-copy-decision.js'

const H264_4K: EgressSourceFacts = {
  codec: 'h264',
  width: 3840,
  height: 2160,
  fps: 20,
}

interface Row {
  readonly name: string
  readonly video: Parameters<typeof decideEgressCopy>[0]
  readonly source: EgressSourceFacts
  readonly copy: boolean
  /** A constraint name expected in `failed` when the answer is "encode". */
  readonly blames?: string
}

const ROWS: readonly Row[] = [
  {
    name: 'codec matches and nothing else is asked ⇒ COPY',
    video: { codec: 'h264' },
    source: { codec: 'h264' },
    copy: true,
  },
  {
    name: 'h264 requested on an h265 source ⇒ encode',
    video: { codec: 'h264' },
    source: { codec: 'h265' },
    copy: false,
    blames: 'codec',
  },
  {
    name: 'an UNKNOWN source codec is never assumed to match ⇒ encode',
    video: { codec: 'h264' },
    source: {},
    copy: false,
    blames: 'codec',
  },
  {
    name: 'source already fits the requested box ⇒ copy',
    video: { codec: 'h264', width: 1920, height: 1080 },
    source: { codec: 'h264', width: 1280, height: 720 },
    copy: true,
  },
  {
    name: 'source is LARGER than the requested box ⇒ encode',
    video: { codec: 'h264', width: 1280, height: 720 },
    source: H264_4K,
    copy: false,
    blames: 'height',
  },
  {
    name: 'geometry requested against an unknown source geometry ⇒ encode',
    video: { codec: 'h264', width: 1280, height: 720 },
    source: { codec: 'h264' },
    copy: false,
    blames: 'width',
  },
  {
    name: 'source fps is under the requested ceiling ⇒ copy',
    video: { codec: 'h264', fps: 25 },
    source: { codec: 'h264', fps: 20 },
    copy: true,
  },
  {
    name: 'source fps exceeds the requested ceiling ⇒ encode',
    video: { codec: 'h264', fps: 15 },
    source: { codec: 'h264', fps: 20 },
    copy: false,
    blames: 'fps',
  },
  {
    name: 'a requested bitrate is NEVER satisfiable — no source carries one ⇒ encode',
    video: { codec: 'h264', bitrateKbps: 2500 },
    source: { codec: 'h264' },
    copy: false,
    blames: 'bitrateKbps',
  },
  {
    name: 'a requested profile is never known at the source ⇒ encode',
    video: { codec: 'h264', profile: 'baseline' },
    source: { codec: 'h264' },
    copy: false,
    blames: 'profile',
  },
  {
    name: 'a requested level is never known at the source ⇒ encode',
    video: { codec: 'h264', level: '3.1' },
    source: { codec: 'h264' },
    copy: false,
    blames: 'level',
  },
  {
    name: 'gopFrames is an ENCODER instruction — a copy cannot honour it ⇒ encode',
    video: { codec: 'h264', gopFrames: 25 },
    source: { codec: 'h264' },
    copy: false,
    blames: 'gopFrames',
  },
  {
    name: "Alexa's full request on a 4K main source ⇒ encode",
    video: {
      codec: 'h264',
      profile: 'baseline',
      level: '3.1',
      width: 1280,
      height: 720,
      fps: 25,
      bitrateKbps: 2500,
      gopFrames: 25,
      bf: 0,
      preset: 'veryfast',
      tune: 'zerolatency',
    },
    source: H264_4K,
    copy: false,
  },
]

describe('decideEgressCopy', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const decision = decideEgressCopy(row.video, row.source)
      expect(decision.copy).toBe(row.copy)
      if (row.copy) {
        expect(decision.unsatisfied).toEqual([])
      } else {
        expect(decision.unsatisfied.length).toBeGreaterThan(0)
        if (row.blames !== undefined) {
          expect(decision.unsatisfied.map((u) => u.constraint)).toContain(row.blames)
        }
      }
    })
  }

  it('names WHY each constraint failed, not just that it did', () => {
    // The decision is the whole point of masking the complexity; a log line
    // that says "encode" without the failing constraint moves the debugging
    // cost onto whoever reads it next.
    const decision = decideEgressCopy({ codec: 'h264', width: 1280, height: 720 }, H264_4K)
    const width = decision.unsatisfied.find((u) => u.constraint === 'width')
    expect(width?.reason).toMatch(/3840/)
  })
})
