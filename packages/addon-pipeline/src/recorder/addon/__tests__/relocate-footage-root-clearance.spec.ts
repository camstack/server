/**
 * A footage mover never runs beside a single-location repoint on the same
 * physical root (2026-10-20: a repoint of `homekitClips:default` and a relocate
 * job moved and deleted the same files). The storage orchestrator owns one claim
 * per root; `recording.relocateFootage` and the migration move ask it AFTER they
 * register the job, and cancel the job when it says no.
 */
import type { IScopedLogger, MoverClearanceAnswer } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { RelocateEngine } from '../../relocate-engine.js'
import type { SegmentStore } from '../../segment-store.js'
import { RecordingIndex } from '../../recording-index.js'
import type { RecordingConfigsState } from '../config-store.js'
import { buildRecordingProvider, type RecordingProviderDeps } from '../recording-provider.js'

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as IScopedLogger

function harness(clearance: (ids: readonly string[]) => Promise<MoverClearanceAnswer>) {
  const start = vi.fn(() => 'job-1')
  const cancel = vi.fn(() => true)
  const deps: RecordingProviderDeps = {
    index: new RecordingIndex(),
    segmentStore: {} as unknown as SegmentStore,
    nodeId: 'node-1',
    logger,
    configStore: {} as unknown as RecordingConfigsState,
    locations: () => [],
    refreshLocations: async () => [],
    capacity: async () => ({ availableBytes: null, totalBytes: null }),
    hydrateDevice: async () => {},
    dataDir: '/data',
    playbackBaseUrl: () => null,
    relocate: { start, cancel, list: () => [] } as unknown as RelocateEngine,
    moverClearance: clearance,
  }
  return { provider: buildRecordingProvider(deps), start, cancel }
}

const INPUT = {
  fromLocationId: 'recordings:default',
  toLocationId: 'recordings:nas',
}

describe('recording.relocateFootage — root clearance', () => {
  it('starts when no repoint holds the root', async () => {
    const asked: Array<readonly string[]> = []
    const h = harness(async (ids) => {
      asked.push(ids)
      return { clear: true }
    })
    expect(await h.provider.relocateFootage(INPUT)).toEqual({ jobId: 'job-1' })
    expect(asked[0]).toEqual(['recordings:default', 'recordings:nas'])
    expect(h.cancel).not.toHaveBeenCalled()
  })

  it('is refused without starting a job while a repoint holds the root', async () => {
    const h = harness(async () => ({
      clear: false,
      repointLocationId: 'homekitClips:default',
    }))
    await expect(h.provider.relocateFootage(INPUT)).rejects.toThrow(/mover refused/)
    expect(h.start).not.toHaveBeenCalled()
  })

  it('cancels the job it started when a repoint claimed the root in between', async () => {
    let calls = 0
    const h = harness(async () => {
      calls += 1
      return calls === 1
        ? { clear: true }
        : { clear: false, repointLocationId: 'homekitClips:default' }
    })
    await expect(h.provider.relocateFootage(INPUT)).rejects.toThrow(/mover refused/)
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.cancel).toHaveBeenCalledWith('job-1')
  })
})
