/**
 * D692 §3.5 and C10 — the notified and judged track sets: TTL, the judged bound, and a
 * track close ending a judgement (a closing survivor takes its absorbed ids with it).
 */

import { describe, expect, it } from 'vitest'
import type { NcRuleSubject } from '../../rule-engine.js'
import {
  NC_JUDGED_TRACK_MAX,
  NC_JUDGED_TRACK_TTL_MS,
  NC_NOTIFIED_TRACK_TTL_MS,
  NcJudgedTracks,
  NcNotifiedTracks,
} from '../notified-tracks.js'

const DEVICE = 104

function subject(trackId: string): NcRuleSubject {
  return {
    kind: 'object-event',
    deviceId: DEVICE,
    recordId: '1',
    timestamp: 0,
    trackId,
    classNames: ['person'],
    zones: [],
  }
}

describe('NcNotifiedTracks (D692 §3.5)', () => {
  it('holds a track per rule for 30 minutes, and names every rule that notified it', () => {
    let now = 1_000
    const set = new NcNotifiedTracks(() => now)
    set.add('r1', ['trk-1', 'trk-9'], now)
    set.add('r2', ['trk-1'], now)

    expect(set.has('r1', 'trk-9')).toBe(true)
    expect(set.has('r2', 'trk-9')).toBe(false)
    expect(set.rulesFor('trk-1')).toEqual(['r1', 'r2'])

    now += NC_NOTIFIED_TRACK_TTL_MS
    expect(set.has('r1', 'trk-1')).toBe(false)
    expect(set.rulesFor('trk-1')).toEqual([])
    set.add('r3', ['trk-2'], now)
    expect(set.size).toBe(1)
  })
})

describe('NcNotifiedTracks — track close and sliding TTL (review T9a M-1)', () => {
  it('a track close ends the entry, and a closing SURVIVOR takes its absorbed ids', () => {
    const set = new NcNotifiedTracks(() => 0)
    set.add('r1', ['trk-1', 'trk-9'], 0, 'trk-1')
    set.add('r2', ['trk-1'], 0, 'trk-1')
    set.add('r1', ['trk-3'], 0, 'trk-3')
    set.trackClosed('trk-1')
    expect(set.has('r1', 'trk-1')).toBe(false)
    expect(set.has('r2', 'trk-1')).toBe(false)
    expect(set.has('r1', 'trk-9')).toBe(false)
    expect(set.has('r1', 'trk-3')).toBe(true)
  })

  it('a closing ABSORBED id takes only itself', () => {
    const set = new NcNotifiedTracks(() => 0)
    set.add('r1', ['trk-1', 'trk-9'], 0, 'trk-1')
    set.trackClosed('trk-9')
    expect(set.has('r1', 'trk-9')).toBe(false)
    expect(set.has('r1', 'trk-1')).toBe(true)
  })

  it('touch slides the TTL: a refused track outlives 30 minutes of silence from the CLOSE', () => {
    let now = 0
    const set = new NcNotifiedTracks(() => now)
    set.add('r1', ['trk-1'], 0, 'trk-1')
    now = NC_NOTIFIED_TRACK_TTL_MS - 1_000
    set.touch('r1', 'trk-1')
    now = NC_NOTIFIED_TRACK_TTL_MS + 60_000
    expect(set.has('r1', 'trk-1')).toBe(true)
    now += NC_NOTIFIED_TRACK_TTL_MS
    expect(set.has('r1', 'trk-1')).toBe(false)
  })

  it('touch on an unknown or expired entry does nothing', () => {
    let now = 0
    const set = new NcNotifiedTracks(() => now)
    set.touch('r1', 'trk-1')
    expect(set.size).toBe(0)
    set.add('r1', ['trk-1'], 0, 'trk-1')
    now = NC_NOTIFIED_TRACK_TTL_MS
    set.touch('r1', 'trk-1')
    expect(set.has('r1', 'trk-1')).toBe(false)
  })
})

describe('NcJudgedTracks — sliding TTL (review T9a M-1)', () => {
  it('touch slides a judged track past 30 minutes', () => {
    let now = 0
    const set = new NcJudgedTracks(() => now)
    set.add({
      ruleId: 'r1',
      deviceId: DEVICE,
      survivorId: 'trk-2',
      trackIds: ['trk-2'],
      subject: subject('trk-2'),
      at: 0,
    })
    now = NC_JUDGED_TRACK_TTL_MS - 1_000
    set.touch('r1', 'trk-2')
    now = NC_JUDGED_TRACK_TTL_MS + 60_000
    expect(set.has('r1', 'trk-2')).toBe(true)
  })
})

describe('NcJudgedTracks (D692 C10)', () => {
  it('returns the subject the track was judged on, per rule, on its camera only', () => {
    const set = new NcJudgedTracks(() => 0)
    set.add({
      ruleId: 'r1',
      deviceId: DEVICE,
      survivorId: 'trk-1',
      trackIds: ['trk-1'],
      subject: subject('trk-1'),
      at: 0,
    })
    expect(set.forTrack(DEVICE, 'trk-1').map((e) => [e.ruleId, e.subject.trackId])).toEqual([
      ['r1', 'trk-1'],
    ])
    expect(set.forTrack(DEVICE + 1, 'trk-1')).toEqual([])
    set.remove('r1', 'trk-1')
    expect(set.has('r1', 'trk-1')).toBe(false)
  })

  it('a closing SURVIVOR ends its absorbed ids too; a closing absorbed id only itself', () => {
    const set = new NcJudgedTracks(() => 0)
    const add = (ruleId: string): void =>
      set.add({
        ruleId,
        deviceId: DEVICE,
        survivorId: 'trk-1',
        trackIds: ['trk-1', 'trk-2'],
        subject: subject('trk-1'),
        at: 0,
      })
    add('r1')
    add('r2')

    expect(set.trackClosed(DEVICE, 'trk-2')).toBe(2)
    expect(set.has('r1', 'trk-1')).toBe(true)
    expect(set.trackClosed(DEVICE, 'trk-1')).toBe(2)
    expect(set.size).toBe(0)
  })

  it('is bounded: a TTL for a close that never arrives, and 4 096 entries oldest first', () => {
    let now = 0
    const set = new NcJudgedTracks(() => now)
    for (let i = 0; i <= NC_JUDGED_TRACK_MAX; i += 1) {
      set.add({
        ruleId: 'r1',
        deviceId: DEVICE,
        survivorId: `t${i}`,
        trackIds: [`t${i}`],
        subject: subject(`t${i}`),
        at: now,
      })
    }
    expect(set.size).toBe(NC_JUDGED_TRACK_MAX)
    expect(set.has('r1', 't0')).toBe(false)
    expect(set.has('r1', 't1')).toBe(true)

    now += NC_JUDGED_TRACK_TTL_MS
    expect(set.has('r1', 't1')).toBe(false)
  })
})
