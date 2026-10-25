/** D692 §6.1/§6.2: the grouped payload v2, the tolerant legacy reader and the member order. */
import { describe, expect, it } from 'vitest'
import {
  boundAbsorbedIds,
  isGroupV2,
  memberAbsorbedIds,
  NC_OUTBOX_GROUP_ABSORBED_MAX,
  orderGroupMembers,
  readOutboxGroup,
} from '../grouped-payload.js'

describe('a member’s absorbed ids (review T10 MEDIUM-1)', () => {
  const base = { trackId: 'trk-9', className: 'person', triggerAt: 1 }
  it('a row without them, or with a malformed value, reads as none', () => {
    expect(memberAbsorbedIds(base)).toEqual([])
    expect(memberAbsorbedIds({ ...base, absorbedIds: [''] })).toEqual([])
    const tooMany = Array.from({ length: NC_OUTBOX_GROUP_ABSORBED_MAX + 1 }, (_, i) => `a${i}`)
    expect(memberAbsorbedIds({ ...base, absorbedIds: tooMany })).toEqual([])
    expect(memberAbsorbedIds({ ...base, absorbedIds: ['trk-1', 'trk-3'] })).toEqual([
      'trk-1',
      'trk-3',
    ])
  })
  it('the close keeps the LATEST ids up to the bound and names the rest', () => {
    const ids = Array.from({ length: NC_OUTBOX_GROUP_ABSORBED_MAX + 2 }, (_, i) => `a${i}`)
    const { kept, dropped } = boundAbsorbedIds([...ids, 'a0'])
    expect(kept).toHaveLength(NC_OUTBOX_GROUP_ABSORBED_MAX)
    expect(kept[0]).toBe('a2')
    expect(dropped).toEqual(['a0', 'a1'])
    expect(boundAbsorbedIds(['x'])).toEqual({ kept: ['x'], dropped: [] })
  })
})

describe('orderGroupMembers (§6.2 item 1)', () => {
  it('recognised first, then the rest, each by first-seen', () => {
    const out = orderGroupMembers([
      { trackId: 'p1', className: 'person', triggerAt: 1, firstSeenAt: 1 },
      {
        trackId: 'car',
        className: 'car',
        label: 'AB123CD',
        labelKind: 'plate',
        triggerAt: 9,
        firstSeenAt: 9,
      },
      {
        trackId: 'a',
        className: 'person',
        label: 'Person A',
        labelKind: 'identity',
        triggerAt: 5,
        firstSeenAt: 5,
      },
      { trackId: 'dog', className: 'dog', triggerAt: 2, firstSeenAt: 2 },
    ])
    expect(out.map((m) => m.trackId)).toEqual(['a', 'car', 'p1', 'dog'])
    expect(out[0]).not.toHaveProperty('firstSeenAt')
  })
  it('an unattributed label is not a recognition — it orders with the rest', () => {
    const out = orderGroupMembers([
      { trackId: 'x', className: 'person', label: 'courier', triggerAt: 1, firstSeenAt: 1 },
      {
        trackId: 'a',
        className: 'person',
        label: 'Person A',
        labelKind: 'identity',
        triggerAt: 5,
        firstSeenAt: 5,
      },
    ])
    expect(out.map((m) => m.trackId)).toEqual(['a', 'x'])
  })
  it('keeps each member’s own event identity for its tile (D694)', () => {
    const [m] = orderGroupMembers([
      {
        trackId: 't',
        className: 'person',
        triggerAt: 1,
        firstSeenAt: 1,
        eventId: '292786',
        eventDeviceId: 101,
        eventAt: 1,
      },
    ])
    expect(m).toMatchObject({ eventId: '292786', eventDeviceId: 101, eventAt: 1 })
  })
})

describe('readOutboxGroup', () => {
  it('reads a v2 group as is', () => {
    const g = {
      version: 2 as const,
      key: 'grp:r:1:t@1',
      openedAt: 1,
      closedAt: 9,
      closeReason: 'all-final' as const,
      members: [{ trackId: 't', className: 'person', triggerAt: 1 }],
    }
    expect(isGroupV2(g)).toBe(true)
    expect(readOutboxGroup(g)).toEqual({
      key: 'grp:r:1:t@1',
      openedAt: 1,
      members: g.members,
      legacy: false,
    })
  })
  it('reads a D143 legacy row: members kept, revision/anchor/bbox ignored, no window time', () => {
    const v = readOutboxGroup({
      key: 'g',
      revision: 3,
      anchorTrackId: 't2',
      members: [{ trackId: 't1', className: 'person', at: 5, bbox: { x: 0, y: 0, w: 1, h: 1 } }],
    })
    expect(v).toEqual({
      key: 'g',
      members: [{ trackId: 't1', className: 'person', triggerAt: 5 }],
      legacy: true,
    })
  })
  it('a legacy member keeps its label and kind', () => {
    const v = readOutboxGroup({
      key: 'g',
      revision: 1,
      anchorTrackId: 't1',
      members: [
        { trackId: 't1', className: 'person', label: 'Person A', labelKind: 'identity', at: 5 },
      ],
    })
    expect(v?.members[0]).toEqual({
      trackId: 't1',
      className: 'person',
      label: 'Person A',
      labelKind: 'identity',
      triggerAt: 5,
    })
  })
  it('no group → undefined', () => {
    expect(readOutboxGroup(undefined)).toBeUndefined()
  })
})
