import type { StorageLocation } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  discardAddonForType,
  discardEligible,
  discardProgressPct,
  discardSubtreesForType,
  parseDiscardStatus,
} from '../location-discard'

const HDD: StorageLocation = {
  id: 'eventMedia:default',
  type: 'eventMedia',
  displayName: 'Events (HDD)',
  providerId: 'filesystem',
  config: { basePath: '/recordings' },
  nodeId: 'hub',
  isSystem: true,
  enabled: false,
  createdAt: 1,
  updatedAt: 2,
}

const SSD: StorageLocation = {
  ...HDD,
  id: 'eventMedia:ssd',
  displayName: 'Events (SSD)',
  config: { basePath: '/media-fast/eventMedia' },
  enabled: true,
}

describe('discardSubtreesForType', () => {
  it('maps eventMedia to events/ only — never high/low/mid', () => {
    expect(discardSubtreesForType('eventMedia')).toEqual(['events'])
  })

  it('maps recordingsLow to low/ only', () => {
    expect(discardSubtreesForType('recordingsLow')).toEqual(['low'])
  })

  it('maps recordings to high/ and mid/, never low/ or events/', () => {
    expect(discardSubtreesForType('recordings')).toEqual(['high', 'mid'])
  })

  it('refuses unknown types', () => {
    expect(discardSubtreesForType('gallery')).toBeNull()
  })
})

describe('discardAddonForType', () => {
  it('routes events to pipeline-analytics and footage to recorder', () => {
    expect(discardAddonForType('eventMedia')).toBe('pipeline-analytics')
    expect(discardAddonForType('recordingsLow')).toBe('recorder')
    expect(discardAddonForType('recordings')).toBe('recorder')
    expect(discardAddonForType('gallery')).toBeNull()
  })
})

describe('discardEligible', () => {
  it('offers discard on a disabled location that has a writable sibling', () => {
    expect(discardEligible(HDD, [HDD, SSD])).toBe(true)
  })

  it('offers discard on a read-only location that has a writable sibling', () => {
    const drained: StorageLocation = {
      ...HDD,
      enabled: true,
      config: { ...HDD.config, readOnly: true },
    }
    expect(discardEligible(drained, [drained, SSD])).toBe(true)
  })

  it('refuses the still-writable default — new data would have nowhere to go after a wipe', () => {
    expect(discardEligible({ ...HDD, enabled: true }, [HDD, SSD])).toBe(false)
  })

  it('refuses the last location of its type (high has no sibling)', () => {
    const high: StorageLocation = {
      ...HDD,
      id: 'recordings:default',
      type: 'recordings',
      enabled: false,
    }
    expect(discardEligible(high, [high])).toBe(false)
  })

  it('refuses when the sibling is also frozen', () => {
    const frozenSsd: StorageLocation = { ...SSD, enabled: false }
    expect(discardEligible(HDD, [HDD, frozenSsd])).toBe(false)
  })
})

describe('parseDiscardStatus', () => {
  it('narrows a well-formed custom-action reply', () => {
    const status = parseDiscardStatus({
      running: true,
      locationId: 'eventMedia:default',
      jobId: 'job-1',
      phase: 'wiping-fs',
      camerasTotal: 10,
      camerasDone: 3,
      foldersRemoved: 3,
      dbRowsDeleted: 0,
      ownersCascaded: 0,
      detail: 'camera 104',
      startedAtMs: 1,
      finishedAtMs: null,
      error: null,
    })
    expect(status?.camerasDone).toBe(3)
    expect(status?.phase).toBe('wiping-fs')
  })

  it('returns null for a malformed reply rather than rendering undefined', () => {
    expect(parseDiscardStatus({ running: true })).toBeNull()
    expect(parseDiscardStatus(null)).toBeNull()
  })
})

describe('discardProgressPct', () => {
  it('scales with cameras during the FS pass and pins complete at 100', () => {
    expect(
      discardProgressPct({
        running: true,
        locationId: 'x',
        jobId: 'j',
        phase: 'wiping-fs',
        camerasTotal: 10,
        camerasDone: 5,
        foldersRemoved: 5,
        dbRowsDeleted: 0,
        ownersCascaded: 0,
        detail: '',
        startedAtMs: 1,
        finishedAtMs: null,
        error: null,
      }),
    ).toBe(43)
    expect(
      discardProgressPct({
        running: false,
        locationId: 'x',
        jobId: 'j',
        phase: 'complete',
        camerasTotal: 10,
        camerasDone: 10,
        foldersRemoved: 10,
        dbRowsDeleted: 1,
        ownersCascaded: 0,
        detail: '',
        startedAtMs: 1,
        finishedAtMs: 2,
        error: null,
      }),
    ).toBe(100)
  })
})
