/**
 * The pure half of per-field ownership (D663): how a native slice and an owned
 * cap merge into what a consumer sees, and how the two travel in one row.
 */
import { describe, expect, it } from 'vitest'
import { BatteryStatusSchema } from '@camstack/types'
import {
  joinRuntimeBlob,
  mergeOwned,
  OWNED_FIELDS_KEY,
  type OwnedCap,
  splitRuntimeBlob,
} from '../field-ownership.js'

const NATIVE = { percentage: 40, charging: 'none', sleeping: false, lastUpdated: 1 }
const OWNED = {
  owner: 'blk-1',
  mode: 'replace' as const,
  fields: ['percentage'],
  values: { percentage: 90 },
}
const restored = () => ({ durability: 'restored' as const, volatileFields: [] })
const session = () => ({ durability: 'session' as const, volatileFields: [] })

describe('field ownership (D663)', () => {
  it('merged = native with the owned fields replaced', () => {
    expect(mergeOwned(NATIVE, OWNED, BatteryStatusSchema)).toEqual({
      kind: 'slice',
      slice: { ...NATIVE, percentage: 90 },
    })
  })

  it('replace with no native slice is HELD — never a partial slice', () => {
    expect(mergeOwned(null, OWNED, BatteryStatusSchema).kind).toBe('held')
  })

  it('a claimed field with NO value is HELD, naming it — never answered from the native slice (S5)', () => {
    const r = mergeOwned(
      NATIVE,
      { ...OWNED, fields: ['percentage', 'charging'], values: { percentage: 90 } },
      BatteryStatusSchema,
    )
    expect(r).toEqual({ kind: 'held', reason: 'claimed fields with no value yet: charging' })
  })

  it('a merge the schema refuses is HELD, naming the fields', () => {
    const r = mergeOwned(NATIVE, { ...OWNED, values: { percentage: 900 } }, BatteryStatusSchema)
    expect(r).toMatchObject({ kind: 'held' })
    expect(r.kind === 'held' && r.reason).toContain('percentage')
  })

  it('an add claim with no native slice merges the owned values alone', () => {
    const r = mergeOwned(null, { ...OWNED, mode: 'add' }, null)
    expect(r).toEqual({ kind: 'slice', slice: { percentage: 90 } })
  })

  it('the row round-trips: native slices + $owned (owner, mode, fields, values), values only for restored caps', () => {
    const owned = new Map<string, OwnedCap>([
      ['battery', OWNED],
      ['audio-metrics', { owner: 'b', mode: 'add', fields: ['x'], values: { x: 1 } }],
    ])
    const blob = joinRuntimeBlob({ battery: NATIVE }, owned, (c) =>
      c === 'battery' ? restored() : session(),
    )
    expect(blob.battery).toEqual(NATIVE)
    expect(blob[OWNED_FIELDS_KEY]).toEqual({
      battery: OWNED,
      'audio-metrics': { owner: 'b', mode: 'add', fields: ['x'], values: {} },
    })
    const back = splitRuntimeBlob(blob)
    expect(back.native).toEqual({ battery: NATIVE })
    expect(back.owned.get('battery')).toEqual(OWNED)
    expect(back.dropped).toEqual([])
  })

  it('a device with no claims joins to the native blob alone — no $owned key on its row', () => {
    expect(joinRuntimeBlob({ battery: NATIVE }, new Map(), restored)).toEqual({ battery: NATIVE })
  })

  it('a malformed $owned entry is dropped BY NAME with the rest intact (a bad row must not blank the device)', () => {
    const back = splitRuntimeBlob({
      battery: NATIVE,
      [OWNED_FIELDS_KEY]: { battery: { owner: 3 } },
    })
    expect(back.native).toEqual({ battery: NATIVE })
    expect(back.owned.size).toBe(0)
    expect(back.dropped).toEqual(['battery'])
  })

  it('a row with no $owned splits to its slices and an empty owned map', () => {
    const back = splitRuntimeBlob({ battery: NATIVE, 'device-status': { online: true } })
    expect(back.native).toEqual({ battery: NATIVE, 'device-status': { online: true } })
    expect(back.owned.size).toBe(0)
    expect(back.dropped).toEqual([])
  })
})
