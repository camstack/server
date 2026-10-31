import { describe, expect, it } from 'vitest'
import {
  type AdoptedChildChannel,
  type DiscoveredChannel,
  planChannelReconciliation,
} from '../hub-channel-reconcile.js'

const HUB = 'mac-ec71db72bbfe'

const discovered: readonly DiscoveredChannel[] = [
  { childNativeId: 'cam-9527000HXOHJ142G', rtspChannel: 0 },
  { childNativeId: 'cam-952700093ABW14UB', rtspChannel: 1 },
  { childNativeId: 'cam-9527000MSU931AUT', rtspChannel: 3 },
]

describe('planChannelReconciliation', () => {
  /**
   * The live case: Magicam's blob was emptied, so it had NO channel. It was therefore
   * absent from the adopted-by-channel map, rendered as available for adoption, and its
   * pushes were dropped. The hub reports it on channel 3 — NOT the "next free" 2, which
   * is what guessing would have produced and would have bound it to an empty slot.
   */
  it('gives a channel back to a child that lost it entirely', () => {
    const children: readonly AdoptedChildChannel[] = [
      { deviceId: 3628, stableId: `${HUB}-cam-9527000HXOHJ142G`, channel: 0 },
      { deviceId: 3629, stableId: `${HUB}-cam-952700093ABW14UB`, channel: 1 },
      { deviceId: 3825, stableId: `${HUB}-cam-9527000MSU931AUT` },
    ]
    expect(planChannelReconciliation(discovered, children)).toEqual([
      { deviceId: 3825, stableId: `${HUB}-cam-9527000MSU931AUT`, from: null, to: 3 },
    ])
  })

  it('follows a camera that moved slot — identity is the UID, not the channel', () => {
    const children: readonly AdoptedChildChannel[] = [
      { deviceId: 3825, stableId: `${HUB}-cam-9527000MSU931AUT`, channel: 2 },
    ]
    expect(planChannelReconciliation(discovered, children)).toEqual([
      { deviceId: 3825, stableId: `${HUB}-cam-9527000MSU931AUT`, from: 2, to: 3 },
    ])
  })

  it('reports nothing when every child already agrees with the hub', () => {
    const children: readonly AdoptedChildChannel[] = [
      { deviceId: 3628, stableId: `${HUB}-cam-9527000HXOHJ142G`, channel: 0 },
      { deviceId: 3629, stableId: `${HUB}-cam-952700093ABW14UB`, channel: 1 },
      { deviceId: 3825, stableId: `${HUB}-cam-9527000MSU931AUT`, channel: 3 },
    ]
    expect(planChannelReconciliation(discovered, children)).toEqual([])
  })

  it('never adopts: a discovered channel with no adopted child is skipped', () => {
    expect(planChannelReconciliation(discovered, [])).toEqual([])
  })

  it('skips a discovered entry the hub could not put on a channel', () => {
    const children: readonly AdoptedChildChannel[] = [
      { deviceId: 3825, stableId: `${HUB}-cam-9527000MSU931AUT`, channel: 7 },
    ]
    const noChannel: readonly DiscoveredChannel[] = [{ childNativeId: 'cam-9527000MSU931AUT' }]
    expect(planChannelReconciliation(noChannel, children)).toEqual([])
  })

  /**
   * D985: a child migrated off a retired Hub device keeps that Hub's stableId prefix, and a
   * child adopted afterwards carries its integration's. Identity is the camera UID the id
   * ENDS with — the prefix is whichever hub or integration first adopted it.
   */
  it('matches a child by its camera identity whatever prefix its stableId carries', () => {
    const children: readonly AdoptedChildChannel[] = [
      {
        deviceId: 999,
        stableId: `integration-1-cam-9527000MSU931AUT`,
        channel: 0,
      },
    ]
    expect(planChannelReconciliation(discovered, children)).toEqual([
      { deviceId: 999, stableId: `integration-1-cam-9527000MSU931AUT`, from: 0, to: 3 },
    ])
  })

  it('does not match a channel-N id against a different camera uid', () => {
    const children: readonly AdoptedChildChannel[] = [
      { deviceId: 999, stableId: `${HUB}-channel-3`, channel: 0 },
    ]
    expect(planChannelReconciliation(discovered, children)).toEqual([])
  })
})
