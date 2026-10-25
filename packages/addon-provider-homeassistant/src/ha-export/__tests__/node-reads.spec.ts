import { describe, expect, it } from 'vitest'
import { footageForNode, shouldReadPackageStatus } from '../node-reads.js'

// `recording` is a SINGLETON cap: the recorder runs on ONE node and is
// deliberately inert everywhere else ("recording assigned elsewhere"). One
// unpinned read answers for the whole cluster and names the node it ran on;
// fanning the read out per node produced 685 warnings a day and never a value.
const USAGE = {
  nodeId: 'hub',
  totalUsedBytes: 1_000,
  devices: [
    { deviceId: 1, oldestMs: 500 },
    { deviceId: 2, oldestMs: null },
  ],
  locations: [
    { totalBytes: 1_000, availableBytes: 900 },
    { totalBytes: 1_000, availableBytes: 100 },
    { totalBytes: null, availableBytes: null },
  ],
}

describe('footageForNode', () => {
  it('attributes the singleton answer to the node that produced it', () => {
    expect(footageForNode('hub', USAGE)).toEqual({
      footageUsedBytes: 1_000,
      footageFreePercent: 10,
    })
  })

  it('leaves every other node unread rather than failed', () => {
    expect(footageForNode('agent-a', USAGE)).toEqual({
      footageUsedBytes: null,
      footageFreePercent: null,
    })
  })

  it('reads nothing from a missing answer', () => {
    expect(footageForNode('hub', null)).toEqual({
      footageUsedBytes: null,
      footageFreePercent: null,
    })
  })
})

describe('shouldReadPackageStatus', () => {
  it('asks only an ONLINE agent — the hub carries its own rows, an offline node cannot answer', () => {
    expect(shouldReadPackageStatus({ isHub: true, isOnline: true })).toBe(false)
    expect(shouldReadPackageStatus({ isHub: false, isOnline: false })).toBe(false)
    expect(shouldReadPackageStatus({ isHub: false, isOnline: true })).toBe(true)
  })
})
