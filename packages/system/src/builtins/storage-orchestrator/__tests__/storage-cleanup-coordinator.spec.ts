import type {
  IScopedLogger,
  LedgerWalkReport,
  StorageCleanupJob,
  StorageLocation,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  StorageCleanupCoordinator,
  type StorageCleanupParticipants,
} from '../storage-cleanup-coordinator.js'
import { StorageOrchestratorService } from '../storage-orchestrator.service.js'

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
  withTags: vi.fn(),
} as unknown as IScopedLogger

function location(
  id: string,
  type: string,
  extra?: Partial<StorageLocation>,
): Omit<StorageLocation, 'createdAt' | 'updatedAt'> {
  return {
    id,
    type,
    displayName: id,
    providerId: 'fs',
    config: {},
    isSystem: extra?.isSystem ?? false,
    enabled: extra?.enabled,
    ...extra,
  }
}

function emptyWalk(locationId: string, forgotten = 0, bytes = 0): LedgerWalkReport {
  return {
    locationId,
    applied: true,
    refused: null,
    archiveSegments: 0,
    archiveBytes: 0,
    hoursClaimed: 0,
    hoursWalked: 0,
    hoursMissing: 0,
    listings: 0,
    segmentsClaimed: 0,
    ghostSegments: forgotten,
    ghostBytes: bytes,
    ghostHoursWhole: 0,
    forgottenSegments: forgotten,
    forgottenBytes: bytes,
    orphanFiles: 0,
    orphanSample: [],
    hoursSkipped: 0,
    skippedByReason: {
      'live-tail': 0,
      'listing-error': 0,
      'path-mismatch': 0,
      'durable-refused': 0,
    },
    bounded: false,
    byDevice: [],
  }
}

function harness(options?: {
  orphanPasses?: readonly { reclaimed: number; bytes: number; complete: boolean }[]
  debug?: { reclaimed: number; bytes: number }
  walks?: ReadonlyMap<string, LedgerWalkReport>
}) {
  const locations = new StorageOrchestratorService(logger, () => [])
  locations.upsertLocation(location('recordings:ssd', 'recordings', { enabled: true }))
  locations.upsertLocation(
    location('recordings:default', 'recordings', { enabled: false, isSystem: true }),
  )
  let state: StorageCleanupJob | null = null
  let now = 1_000
  const orphanPasses = [
    ...(options?.orphanPasses ?? [{ reclaimed: 4, bytes: 400, complete: true }]),
  ]
  let orphanPass = 0
  let orphanRunning = false
  let debugRunning = false
  const walks: string[] = []
  const participants: StorageCleanupParticipants = {
    startOrphan: async () => {
      orphanRunning = true
      return { started: true, alreadyRunning: false }
    },
    orphanStatus: async () => {
      if (orphanRunning) {
        orphanRunning = false
        const pass = orphanPasses[Math.min(orphanPass, orphanPasses.length - 1)]!
        orphanPass += 1
        return {
          running: false,
          complete: pass.complete,
          totalReclaimed: pass.reclaimed,
          totalBytesReclaimed: pass.bytes,
          error: null,
        }
      }
      return {
        running: false,
        complete: true,
        totalReclaimed: 0,
        totalBytesReclaimed: 0,
        error: null,
      }
    },
    startDebugMedia: async () => {
      debugRunning = true
      return { started: true, alreadyRunning: false }
    },
    debugMediaStatus: async () => {
      if (!debugRunning) {
        return { running: false, totalReclaimed: 0, totalBytesReclaimed: 0, error: null }
      }
      debugRunning = false
      return {
        running: false,
        totalReclaimed: options?.debug?.reclaimed ?? 0,
        totalBytesReclaimed: options?.debug?.bytes ?? 0,
        error: null,
      }
    },
    walkLedger: async (input) => {
      walks.push(input.locationId)
      return options?.walks?.get(input.locationId) ?? emptyWalk(input.locationId)
    },
  }
  const coordinator = new StorageCleanupCoordinator({
    locations,
    state: {
      get: async () => state,
      set: async (value) => {
        state = value
      },
    },
    participants,
    now: () => now++,
    newId: () => 'cleanup-1',
    sleep: async () => undefined,
    pollMs: 0,
  })
  return { coordinator, walks, locations }
}

describe('StorageCleanupCoordinator', () => {
  it('returns a jobId immediately and finishes orphans + ghosts without debug media', async () => {
    const { coordinator, walks } = harness({
      walks: new Map([['recordings:default', emptyWalk('recordings:default', 11, 8_000)]]),
    })
    const jobId = await coordinator.start({})
    expect(jobId).toBe('cleanup-1')
    await vi.waitFor(async () => {
      const job = await coordinator.status()
      expect(job?.phase).toBe('done')
    })
    const job = await coordinator.status()
    expect(job?.orphansReclaimed).toBe(4)
    expect(job?.orphanBytesReclaimed).toBe(400)
    expect(job?.debugMediaReclaimed).toBe(0)
    expect(job?.ghostsForgotten).toBe(11)
    expect(job?.ghostBytesForgotten).toBe(8_000)
    expect(walks).toEqual(['recordings:default'])
  })

  it('pages orphan reclaim until the addon reports complete', async () => {
    const { coordinator } = harness({
      orphanPasses: [
        { reclaimed: 20, bytes: 100, complete: false },
        { reclaimed: 3, bytes: 30, complete: true },
      ],
    })
    await coordinator.start({})
    await vi.waitFor(async () => {
      expect((await coordinator.status())?.phase).toBe('done')
    })
    const job = await coordinator.status()
    expect(job?.orphansReclaimed).toBe(23)
    expect(job?.orphanBytesReclaimed).toBe(130)
  })

  it('runs debug media only when asked', async () => {
    const { coordinator } = harness({ debug: { reclaimed: 9, bytes: 90 } })
    await coordinator.start({ includeDebugMedia: true })
    await vi.waitFor(async () => {
      expect((await coordinator.status())?.phase).toBe('done')
    })
    const job = await coordinator.status()
    expect(job?.debugMediaReclaimed).toBe(9)
    expect(job?.debugMediaBytesReclaimed).toBe(90)
  })

  it('does not walk an enabled footage location', async () => {
    const { coordinator, walks } = harness()
    await coordinator.start({})
    await vi.waitFor(async () => {
      expect((await coordinator.status())?.phase).toBe('done')
    })
    expect(walks).toEqual(['recordings:default'])
  })
})
