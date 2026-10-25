/**
 * Unit tests for the client-side `camstack-control` wire codec (R9).
 *
 * The shapes mirror the broker's `control-protocol.ts`
 * (packages/addon-pipeline/src/stream-broker/recorded/control-protocol.ts) —
 * client→server commands are serialized with the `t` discriminator the server
 * Zod schema expects; server→client `state`/`position` messages are parsed
 * defensively so a malformed frame never throws on the datachannel path.
 */
import { describe, it, expect } from 'vitest'
import {
  serializeRecordedCommand,
  parseRecordedServerMessage,
  RECORDED_PLAYBACK_MODES,
} from '../recorded-control-protocol'

describe('serializeRecordedCommand', () => {
  it('serializes playRecorded with deviceId + epoch + profile', () => {
    expect(
      JSON.parse(
        serializeRecordedCommand({
          t: 'playRecorded',
          deviceId: 42,
          epoch: 1_700_000_000_000,
          profile: 'mid',
        }),
      ),
    ).toEqual({ t: 'playRecorded', deviceId: 42, epoch: 1_700_000_000_000, profile: 'mid' })
  })
  it('serializes seek / scrubCommit with the epoch', () => {
    expect(JSON.parse(serializeRecordedCommand({ t: 'seek', epoch: 123 }))).toEqual({
      t: 'seek',
      epoch: 123,
    })
    expect(JSON.parse(serializeRecordedCommand({ t: 'scrubCommit', epoch: 456 }))).toEqual({
      t: 'scrubCommit',
      epoch: 456,
    })
  })
  it('serializes setRate / goLive / setProfile', () => {
    expect(JSON.parse(serializeRecordedCommand({ t: 'setRate', rate: 0 }))).toEqual({
      t: 'setRate',
      rate: 0,
    })
    expect(JSON.parse(serializeRecordedCommand({ t: 'goLive' }))).toEqual({ t: 'goLive' })
    expect(JSON.parse(serializeRecordedCommand({ t: 'setProfile', profile: 'low' }))).toEqual({
      t: 'setProfile',
      profile: 'low',
    })
  })
})

describe('parseRecordedServerMessage', () => {
  it('parses every known state', () => {
    for (const state of RECORDED_PLAYBACK_MODES) {
      expect(parseRecordedServerMessage(JSON.stringify({ t: 'state', state }))).toEqual({
        kind: 'state',
        state,
      })
    }
  })
  it('parses a position report', () => {
    expect(
      parseRecordedServerMessage(JSON.stringify({ t: 'position', epochMs: 1_700_000_000_000 })),
    ).toEqual({ kind: 'position', epochMs: 1_700_000_000_000 })
  })
  it('parses servedProfile — the tier playing next to the one asked for', () => {
    expect(
      parseRecordedServerMessage(
        JSON.stringify({ t: 'servedProfile', profile: 'mid', requested: 'high' }),
      ),
    ).toEqual({ kind: 'servedProfile', profile: 'mid', requested: 'high' })
    expect(
      parseRecordedServerMessage(
        JSON.stringify({ t: 'servedProfile', profile: 'ultra', requested: 'high' }),
      ),
    ).toBeNull()
  })

  it('returns null for an unknown state value', () => {
    expect(parseRecordedServerMessage(JSON.stringify({ t: 'state', state: 'warp' }))).toBeNull()
  })
  it('returns null for a malformed / non-JSON frame', () => {
    expect(parseRecordedServerMessage('not-json')).toBeNull()
    expect(parseRecordedServerMessage('42')).toBeNull()
    expect(parseRecordedServerMessage('null')).toBeNull()
    expect(parseRecordedServerMessage(JSON.stringify({ t: 'position' }))).toBeNull()
    expect(parseRecordedServerMessage(JSON.stringify({ t: 'other', epochMs: 1 }))).toBeNull()
  })
})
