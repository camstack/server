/**
 * An audio-only consumer never causes a video transcode.
 *
 * The live failure: on this fleet `low` is a broker-spawned
 * `derived:mid-to-low` transcode, `motionStreamProfile` is `low`, and audio had
 * no stream of its own — it rode `motionStreamId`. An audio subscription counts
 * as broker demand (`hasLiveIntent` reads `audioChunkPlane.subscriberCount`),
 * and a derived broker's ffmpeg feeder is spawned/torn down on that same demand
 * edge. So one listener that wanted only sound paid for a full video re-encode,
 * and the feeder could never be released while it listened.
 */
import type { CamProfile } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { selectAudioCamStream, toAudioStreamPick } from '../audio-stream-selection.js'

const DERIVED_LOW = 'derived:mid-to-low'
const NATIVE_MID = 'native:sub'
const NATIVE_HIGH = 'native:main'
const NATIVE_LOW = 'native:third'

function assigned(entries: readonly (readonly [CamProfile, string])[]): Map<CamProfile, string> {
  return new Map(entries)
}

describe('selectAudioCamStream', () => {
  it('moves audio off a derived low rung onto the native mid', () => {
    const selection = selectAudioCamStream({
      pick: 'auto',
      motionStreamId: DERIVED_LOW,
      assigned: assigned([
        ['low', DERIVED_LOW],
        ['mid', NATIVE_MID],
        ['high', NATIVE_HIGH],
      ]),
    })

    expect(selection).toEqual({
      kind: 'selected',
      camStreamId: NATIVE_MID,
      profile: 'mid',
      selectedBy: 'lowest-native-rung',
      derived: false,
    })
  })

  it('leaves a camera whose low rung is native exactly where it was', () => {
    const selection = selectAudioCamStream({
      pick: 'auto',
      motionStreamId: NATIVE_LOW,
      assigned: assigned([
        ['low', NATIVE_LOW],
        ['mid', NATIVE_MID],
      ]),
    })

    expect(selection).toMatchObject({ kind: 'selected', camStreamId: NATIVE_LOW, profile: 'low' })
  })

  it('falls all the way to high when low AND mid are transcodes', () => {
    const selection = selectAudioCamStream({
      pick: 'auto',
      motionStreamId: DERIVED_LOW,
      assigned: assigned([
        ['low', DERIVED_LOW],
        ['mid', 'derived:high-to-mid'],
        ['high', NATIVE_HIGH],
      ]),
    })

    expect(selection).toMatchObject({ kind: 'selected', camStreamId: NATIVE_HIGH, profile: 'high' })
  })

  it('REFUSES rather than spawning a transcode when every rung is derived', () => {
    const selection = selectAudioCamStream({
      pick: 'auto',
      motionStreamId: DERIVED_LOW,
      assigned: assigned([
        ['low', DERIVED_LOW],
        ['mid', 'derived:high-to-mid'],
      ]),
    })

    expect(selection).toEqual({
      kind: 'refused',
      reason: 'all-rungs-derived',
      pick: 'auto',
      rejectedCamStreamId: DERIVED_LOW,
    })
  })

  it('distinguishes "nothing assigned" from "everything derived"', () => {
    const selection = selectAudioCamStream({
      pick: 'auto',
      motionStreamId: DERIVED_LOW,
      assigned: assigned([]),
    })

    expect(selection).toEqual({
      kind: 'refused',
      reason: 'no-assigned-rung',
      pick: 'auto',
      rejectedCamStreamId: null,
    })
  })

  it('honours an explicit operator pick, derived included, and reports the cost', () => {
    const selection = selectAudioCamStream({
      pick: 'low',
      motionStreamId: NATIVE_MID,
      assigned: assigned([
        ['low', DERIVED_LOW],
        ['mid', NATIVE_MID],
      ]),
    })

    expect(selection).toEqual({
      kind: 'selected',
      camStreamId: DERIVED_LOW,
      profile: 'low',
      selectedBy: 'operator-pick',
      derived: true,
    })
  })

  it('REFUSES a pick naming a rung the camera no longer publishes — it never silently becomes auto', () => {
    const selection = selectAudioCamStream({
      pick: 'high',
      motionStreamId: DERIVED_LOW,
      assigned: assigned([
        ['low', DERIVED_LOW],
        ['mid', NATIVE_MID],
      ]),
    })

    expect(selection).toEqual({
      kind: 'refused',
      reason: 'pick-unassigned',
      pick: 'high',
      rejectedCamStreamId: null,
    })
  })

  it('REFUSES a pick it cannot resolve because the slot read failed', () => {
    const selection = selectAudioCamStream({
      pick: 'mid',
      motionStreamId: NATIVE_MID,
      assigned: null,
    })

    expect(selection).toMatchObject({ kind: 'refused', reason: 'pick-unresolvable', pick: 'mid' })
  })

  it('keeps a NATIVE motion stream when the slot read failed (a transient must not mute a camera)', () => {
    const selection = selectAudioCamStream({
      pick: 'auto',
      motionStreamId: NATIVE_MID,
      assigned: null,
    })

    expect(selection).toMatchObject({
      kind: 'selected',
      camStreamId: NATIVE_MID,
      selectedBy: 'motion-stream-fallback',
    })
  })

  it('refuses a DERIVED motion stream when the slot read failed — no table, no native rung to move to', () => {
    const selection = selectAudioCamStream({
      pick: 'auto',
      motionStreamId: DERIVED_LOW,
      assigned: null,
    })

    expect(selection).toEqual({
      kind: 'refused',
      reason: 'slots-unknown-and-fallback-derived',
      pick: 'auto',
      rejectedCamStreamId: DERIVED_LOW,
    })
  })

  it('an empty map is not a failed read', () => {
    expect(
      selectAudioCamStream({
        pick: 'auto',
        motionStreamId: DERIVED_LOW,
        assigned: assigned([]),
      }),
    ).toMatchObject({ reason: 'no-assigned-rung' })
    expect(
      selectAudioCamStream({
        pick: 'auto',
        motionStreamId: DERIVED_LOW,
        assigned: null,
      }),
    ).toMatchObject({ reason: 'slots-unknown-and-fallback-derived' })
  })
})

describe('toAudioStreamPick', () => {
  it('reads an absent stored value as auto — an existing camera behaves exactly as before', () => {
    expect(toAudioStreamPick(undefined)).toBe('auto')
    expect(toAudioStreamPick(null)).toBe('auto')
    expect(toAudioStreamPick('')).toBe('auto')
  })

  it('reads the three rungs and auto, and nothing else', () => {
    expect(toAudioStreamPick('auto')).toBe('auto')
    expect(toAudioStreamPick('high')).toBe('high')
    expect(toAudioStreamPick('mid')).toBe('mid')
    expect(toAudioStreamPick('low')).toBe('low')
    // A stored value from a future (or corrupted) schema is not a rung. It
    // reads as `auto` — the behaviour every camera already has — rather than
    // throwing detection settings for the whole camera.
    expect(toAudioStreamPick('ultra')).toBe('auto')
    expect(toAudioStreamPick(3)).toBe('auto')
  })
})
