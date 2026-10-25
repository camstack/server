import type {
  IScopedLogger,
  RelocateJob,
  StorageLocation,
  StorageMigrationJob,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { StorageMigrationCoordinator } from '../storage-migration-coordinator.js'
import { StorageOrchestratorService } from '../storage-orchestrator.service.js'

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
  withTags: vi.fn(),
} as unknown as IScopedLogger

function location(id: string, type: string): Omit<StorageLocation, 'createdAt' | 'updatedAt'> {
  return { id, type, displayName: id, providerId: 'fs', config: {}, isSystem: false }
}

function doneJob(jobId: string): RelocateJob {
  return {
    jobId,
    state: 'done',
    fromLocationId: 'from',
    toLocationId: 'to',
    deviceId: null,
    entities: ['segments'],
    filesMoved: 1,
    bytesMoved: 1,
    filesTotal: 1,
    startedAt: 1,
    finishedAt: 2,
    error: null,
  }
}

function buildHarness(options?: {
  failRecorder?: boolean
  running?: boolean
  failRefreshOnce?: boolean
  /** NULL-locationId rows at PLAN time — what the plan-time gate reads. */
  unstampedRows?: number
  /**
   * The analytics node cannot say — `countUnstamped` answers `null`.
   *
   * Not a hypothetical: this count paged 1.25 M rows at 200 per RPC and hit
   * the 60 s deadline on every call it ever made on the live hub. "Could not
   * measure" is the state this gate spent its whole life in, and it must not
   * be the state that lets a cutover through.
   */
  unstampedUnmeasurable?: boolean
  /**
   * From this 1-based call onward, `countUnstamped` answers `null`. Call 1 is
   * the plan's; the `sealing` phase then makes a pre-count and a re-count, so
   * `3` targets the re-count specifically — the one the job's gate reads.
   */
  unmeasurableFromCall?: number
  /** The count lands, but only as "there are some" — size unknown. */
  unstampedSizeUnknown?: boolean
  /**
   * NULL rows that appear AFTER the plan-time count — a retrain writer racing
   * the cutover. The plan gate cannot see these, which is the whole reason the
   * job carries its own `sealing` phase.
   */
  raceRows?: number
  /** Of those, the ones a seal pass cannot stamp. */
  unsealableRows?: number
  /** realpath-equivalent key per location id; absent = `null` (unanswerable). */
  deviceKeys?: Readonly<Record<string, string>>
  /**
   * Polls a running mover survives before it reports `done`, ADVANCING its
   * counters on each one.
   *
   * A fixture whose progress never changes would pass against a coordinator
   * that hard-coded zero, which is the whole thing this pins.
   */
  movingPolls?: number
  /** Ledger census per footage source location; `null` = unanswerable. */
  footageResidue?: Readonly<Record<string, { segments: number; bytes: number } | null>>
  /** Rows a media pass would still select; `null` = unanswerable. */
  mediaResidue?: { rows: number } | null
  /** Movers already running that NO migration armed — the shape on the hub
   *  when a drain was started by hand against `recording.relocateFootage`. */
  preexistingMovers?: readonly RelocateJob[]
}) {
  const locations = new StorageOrchestratorService(logger, () => [])
  // D383: there is no `isDefault` flag any more, and none is needed here —
  // `resolveEnabled`'s own create-time rule ("first location of a type is
  // born enabled, every later one born inert") reproduces exactly the
  // old:enabled / new:disabled shape this fixture always wanted.
  for (const type of ['recordings', 'recordingsLow', 'eventMedia', 'galleryMedia', 'backups']) {
    locations.upsertLocation(location(`${type}:old`, type))
    locations.upsertLocation(location(`${type}:new`, type))
  }
  let state: StorageMigrationJob | null = null
  let next = 0
  const calls: string[] = []
  const defaultsAtResume: string[] = []
  const jobs = new Map<string, RelocateJob>()
  /** Which engine holds each mover — the fixture's stand-in for two addons. */
  const moverLane = new Map<string, 'recorder' | 'analytics'>()
  for (const mover of options?.preexistingMovers ?? []) {
    jobs.set(mover.jobId, mover)
    moverLane.set(mover.jobId, 'recorder')
  }
  let recorderMoveRunning = false
  let mediaMoveRunning = false
  let refreshFailures = options?.failRefreshOnce === true ? 1 : 0
  let unstamped = options?.raceRows ?? options?.unstampedRows ?? 0
  const unsealable = options?.unsealableRows ?? 0
  let countCalls = 0
  const participant = (name: string) => ({
    pause: async (): Promise<void> => {
      calls.push(`pause:${name}`)
    },
    resume: async (): Promise<void> => {
      calls.push(`resume:${name}`)
      defaultsAtResume.push(`${name}:${locations.writeTargets('recordings')[0]?.id ?? 'none'}`)
    },
  })
  /** Remaining advancing polls per mover job id. */
  const pollsLeft = new Map<string, number>()
  let mediaResidueThrows = false
  const start = async (name: string, label: string) => {
    if (name === 'recorder' && options?.failRecorder) throw new Error('copy failed')
    if (name === 'recorder' && recorderMoveRunning) {
      throw new Error('recorder relocation is already running')
    }
    if (name === 'analytics' && mediaMoveRunning) {
      throw new Error('a media relocation is already running')
    }
    if (name === 'recorder') recorderMoveRunning = true
    if (name === 'analytics') mediaMoveRunning = true
    const jobId = `${name}-${next++}`
    moverLane.set(jobId, name === 'recorder' ? 'recorder' : 'analytics')
    const moving = options?.movingPolls ?? 0
    if (moving > 0) pollsLeft.set(jobId, moving)
    jobs.set(
      jobId,
      options?.running || moving > 0
        ? {
            ...doneJob(jobId),
            state: 'running',
            finishedAt: null,
            filesMoved: 0,
            bytesMoved: 0,
            filesTotal: moving > 0 ? 100 * moving : 1,
          }
        : doneJob(jobId),
    )
    calls.push(label)
    return { jobId }
  }
  /**
   * One poll of a mover that is genuinely WORKING: the counters move, and it
   * only reports `done` once its budget is spent. A fixture that returned the
   * same numbers forever would be satisfied by a coordinator that folded a
   * constant.
   */
  const advance = (jobId: string): void => {
    const remaining = pollsLeft.get(jobId)
    if (remaining === undefined) return
    const job = jobs.get(jobId)
    if (!job) return
    const filesMoved = job.filesMoved + 100
    const bytesMoved = job.bytesMoved + 1_000_000
    if (remaining <= 1) {
      pollsLeft.delete(jobId)
      jobs.set(jobId, { ...job, state: 'done', finishedAt: 9, filesMoved, bytesMoved })
      return
    }
    pollsLeft.set(jobId, remaining - 1)
    jobs.set(jobId, { ...job, filesMoved, bytesMoved })
  }
  const coordinator = new StorageMigrationCoordinator({
    locations,
    state: {
      get: async () => state,
      set: async (value) => {
        state = value
      },
    },
    participants: {
      pipeline: participant('pipeline'),
      recorder: {
        ...participant('recorder'),
        startMove: () => start('recorder', 'move:recorder'),
        startDrain: () => start('recorder', 'drain:recorder'),
        getMove: async (jobId) => {
          advance(jobId)
          const job = jobs.get(jobId) ?? null
          if (job?.state !== 'running') recorderMoveRunning = false
          return job
        },
        listMovers: async () =>
          [...jobs.values()].filter((job) => moverLane.get(job.jobId) === 'recorder'),
        // `null` (unanswerable) has to be expressible per location, so an
        // absent key is an EMPTY source and an explicit `null` is an
        // unanswerable one. `?? {}` would collapse the two.
        residue: async ({ fromLocationId }) =>
          Object.hasOwn(options?.footageResidue ?? {}, fromLocationId)
            ? (options?.footageResidue?.[fromLocationId] ?? null)
            : { segments: 0, bytes: 0 },
        cancelMove: async (jobId) => {
          const job = jobs.get(jobId)
          if (job) jobs.set(jobId, { ...job, state: 'cancelled', finishedAt: 3 })
          recorderMoveRunning = false
          return true
        },
        refresh: async () => {
          if (refreshFailures > 0) {
            refreshFailures--
            throw new Error('refresh failed')
          }
          calls.push('refresh:recorder')
        },
      },
      analytics: {
        ...participant('analytics'),
        startMove: () => start('analytics', 'move:analytics'),
        startDrain: async (input) => {
          if (input.mode !== 'seal') return start('analytics', 'drain:analytics')
          // A seal stamps every row it CAN; `unsealable` is the population it
          // cannot reach (a retrain writer still emitting NULL behind it).
          const started = await start('analytics', `seal:analytics:${input.toLocationId}`)
          unstamped = unsealable
          return started
        },
        countUnstamped: async () => {
          // The FIRST count is the plan's; everything after it sees whatever a
          // racing writer has since produced.
          countCalls++
          if (options?.unstampedUnmeasurable === true) return null
          if (
            options?.unmeasurableFromCall !== undefined &&
            countCalls >= options.unmeasurableFromCall
          )
            return null
          const total = countCalls === 1 ? (options?.unstampedRows ?? 0) : unstamped
          const rows = options?.unstampedSizeUnknown === true ? null : total
          return {
            media: { present: total > 0, rows },
            retrainFrames: { present: false, rows: 0 },
            anyPresent: total > 0,
            total: rows,
          }
        },
        getMove: async (jobId) => {
          advance(jobId)
          const job = jobs.get(jobId) ?? null
          if (job?.state !== 'running') mediaMoveRunning = false
          return job
        },
        listMovers: async () =>
          [...jobs.values()].filter((job) => moverLane.get(job.jobId) === 'analytics'),
        residue: async () => {
          // The addon is down / restarting — a THROW, not a null. The
          // participants' own "I could not answer" is already `null`, so a
          // fixture that returned null here would not exercise the isolation.
          if (mediaResidueThrows) throw new Error('media relocation unavailable')
          return options !== undefined && 'mediaResidue' in options
            ? (options.mediaResidue ?? null)
            : { rows: 0 }
        },
        cancelMove: async (jobId) => {
          const job = jobs.get(jobId)
          if (job) jobs.set(jobId, { ...job, state: 'cancelled', finishedAt: 3 })
          mediaMoveRunning = false
          return true
        },
        refresh: async () => {
          calls.push('refresh:analytics')
        },
      },
    },
    now: () => 1,
    newId: () => 'migration-1',
    pollMs: 0,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    deviceKeyOf: async (locationId) => options?.deviceKeys?.[locationId] ?? null,
  })
  return {
    coordinator,
    locations,
    calls,
    defaultsAtResume,
    state: () => state,
    setState: (nextState: StorageMigrationJob | null) => {
      state = nextState
    },
    failMediaResidue: () => {
      mediaResidueThrows = true
    },
  }
}

async function waitTerminal(
  harness: ReturnType<typeof buildHarness>,
): Promise<StorageMigrationJob> {
  for (let i = 0; i < 100; i++) {
    const job = await harness.coordinator.status()
    if (job?.phase === 'done' || job?.phase === 'failed' || job?.phase === 'cancelled') return job
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('migration did not finish')
}

async function waitPhase(
  harness: ReturnType<typeof buildHarness>,
  phase: StorageMigrationJob['phase'],
): Promise<StorageMigrationJob> {
  for (let i = 0; i < 100; i++) {
    const job = await harness.coordinator.status()
    if (job?.phase === phase) return job
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`migration did not reach ${phase}`)
}

describe('StorageMigrationCoordinator', () => {
  it('reserves the coordinator slot before asynchronous planning', async () => {
    const h = buildHarness({ running: true })
    const results = await Promise.allSettled([
      h.coordinator.start({ destinations: { recordings: 'recordings:new' } }),
      h.coordinator.start({ destinations: { recordings: 'recordings:new' } }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('pauses, moves, repoints, refreshes, then resumes in reverse order', async () => {
    const h = buildHarness()
    await h.coordinator.start({
      destinations: { recordings: 'recordings:new', eventMedia: 'eventMedia:new' },
    })
    expect((await waitTerminal(h)).phase).toBe('done')
    expect(h.locations.writeTargets('recordings')[0]?.id).toBe('recordings:new')
    expect(h.locations.writeTargets('eventMedia')[0]?.id).toBe('eventMedia:new')
    expect(h.calls).toEqual([
      'pause:pipeline',
      'pause:recorder',
      'pause:analytics',
      'move:analytics',
      'move:recorder',
      'refresh:recorder',
      'refresh:analytics',
      'resume:analytics',
      'resume:recorder',
      'resume:pipeline',
    ])
    expect(h.defaultsAtResume).toEqual([
      'analytics:recordings:new',
      'recorder:recordings:new',
      'pipeline:recordings:new',
    ])
  })

  it('cancels before repoint and always releases the pause lease', async () => {
    const h = buildHarness({ running: true })
    const jobId = await h.coordinator.start({ destinations: { recordings: 'recordings:new' } })
    for (let i = 0; i < 100 && (await h.coordinator.status())?.phase !== 'moving'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await h.coordinator.cancel(jobId)
    expect((await waitTerminal(h)).phase).toBe('cancelled')
    expect(h.locations.writeTargets('recordings')[0]?.id).toBe('recordings:old')
    expect(h.calls).toEqual(
      expect.arrayContaining(['resume:analytics', 'resume:recorder', 'resume:pipeline']),
    )
  })

  it('serializes recordings and recordingsLow through the recorder mover', async () => {
    const h = buildHarness()
    await h.coordinator.start({
      destinations: { recordings: 'recordings:new', recordingsLow: 'recordingsLow:new' },
    })
    expect((await waitTerminal(h)).phase).toBe('done')
    expect(h.calls.filter((call) => call === 'move:recorder')).toHaveLength(2)
    expect(h.locations.writeTargets('recordingsLow')[0]?.id).toBe('recordingsLow:new')
  })

  it('fails closed and releases a partially acquired pause lease', async () => {
    const h = buildHarness({ failRecorder: true })
    await h.coordinator.start({ destinations: { recordings: 'recordings:new' } })
    expect((await waitTerminal(h)).phase).toBe('failed')
    expect(h.locations.writeTargets('recordings')[0]?.id).toBe('recordings:old')
    expect(h.calls).toContain('resume:pipeline')
  })

  it('recovers at repointing and re-establishes defaults before resuming', async () => {
    const h = buildHarness()
    h.setState({
      jobId: 'recovery',
      phase: 'repointing',
      mode: 'blocking',
      destinations: { recordings: 'recordings:new' },
      throttleMbps: 40,
      moves: [
        {
          storageClass: 'recordings',
          fromLocationId: 'recordings:old',
          toLocationId: 'recordings:new',
          moverJobId: 'old-child',
          state: 'done',
          error: null,
          progress: null,
        },
      ],
      pauseLeaseId: 'recovery',
      pausedParticipants: ['pipeline', 'recorder', 'analytics'],
      repointed: false,
      cancelRequested: false,
      startedAt: 1,
      updatedAt: 1,
      finishedAt: null,
      error: null,
    })
    await h.coordinator.recover()
    expect((await waitTerminal(h)).phase).toBe('done')
    expect(h.locations.writeTargets('recordings')[0]?.id).toBe('recordings:new')
    expect(h.defaultsAtResume).toEqual([
      'analytics:recordings:new',
      'recorder:recordings:new',
      'pipeline:recordings:new',
    ])
  })

  it('reacquires in-memory participant leases before continuing a recovered move', async () => {
    const h = buildHarness()
    h.setState({
      jobId: 'moving-recovery',
      phase: 'moving',
      mode: 'blocking',
      destinations: { recordings: 'recordings:new' },
      throttleMbps: 40,
      moves: [
        {
          storageClass: 'recordings',
          fromLocationId: 'recordings:old',
          toLocationId: 'recordings:new',
          moverJobId: 'lost-child',
          state: null,
          error: null,
          progress: null,
        },
      ],
      pauseLeaseId: 'lost-lease',
      pausedParticipants: ['pipeline', 'recorder', 'analytics'],
      repointed: false,
      cancelRequested: false,
      startedAt: 1,
      updatedAt: 1,
      finishedAt: null,
      error: null,
    })
    await h.coordinator.recover()
    expect((await waitTerminal(h)).phase).toBe('done')
    expect(h.calls.slice(0, 3)).toEqual(['pause:pipeline', 'pause:recorder', 'pause:analytics'])
    expect(h.calls).toContain('move:recorder')
  })

  it('retains the pause after a post-repoint refresh failure and retries on recovery', async () => {
    const h = buildHarness({ failRefreshOnce: true })
    await h.coordinator.start({ destinations: { recordings: 'recordings:new' } })
    expect((await waitPhase(h, 'refreshing')).repointed).toBe(true)
    expect(h.locations.writeTargets('recordings')[0]?.id).toBe('recordings:new')
    expect(h.calls).not.toContain('resume:pipeline')
    await h.coordinator.recover()
    expect((await waitTerminal(h)).phase).toBe('done')
    expect(h.calls).toContain('refresh:recorder')
    expect(h.calls.slice(-3)).toEqual(['resume:analytics', 'resume:recorder', 'resume:pipeline'])
  })
})

describe('StorageMigrationCoordinator — non-blocking cutover', () => {
  it('repoints and resumes BEFORE it moves a byte, and drains unleased', async () => {
    const h = buildHarness()
    await h.coordinator.start({
      mode: 'nonBlocking',
      destinations: { recordings: 'recordings:new' },
    })
    expect((await waitTerminal(h)).phase).toBe('done')
    // The order IS the design: every pause/refresh/resume happens before any
    // mover is armed, and the mover that does run is the UNLEASED one.
    expect(h.calls).toEqual([
      'pause:pipeline',
      'pause:recorder',
      'pause:analytics',
      'refresh:recorder',
      'resume:analytics',
      'resume:recorder',
      'resume:pipeline',
      'drain:recorder',
    ])
    expect(h.calls).not.toContain('move:recorder')
    expect(h.locations.writeTargets('recordings')[0]?.id).toBe('recordings:new')
    // Writers come back on the NEW root — that is what makes the drain safe to
    // run behind them.
    expect(h.defaultsAtResume).toEqual([
      'analytics:recordings:new',
      'recorder:recordings:new',
      'pipeline:recordings:new',
    ])
  })

  it('records the mode on the job so status can tell the two apart', async () => {
    const blocking = buildHarness()
    await blocking.coordinator.start({ destinations: { recordings: 'recordings:new' } })
    expect((await waitTerminal(blocking)).mode).toBe('blocking')
    const nonBlocking = buildHarness()
    await nonBlocking.coordinator.start({
      mode: 'nonBlocking',
      destinations: { recordings: 'recordings:new' },
    })
    expect((await waitTerminal(nonBlocking)).mode).toBe('nonBlocking')
  })

  it('cancels mid-drain and leaves both locations reachable', async () => {
    const h = buildHarness({ running: true })
    const jobId = await h.coordinator.start({
      mode: 'nonBlocking',
      destinations: { recordings: 'recordings:new' },
    })
    await waitPhase(h, 'draining')
    // The long half of a non-blocking migration is repointed AND running. A
    // cancel there is a supported outcome, not a refusal.
    expect(await h.coordinator.cancel(jobId)).toBe(true)
    expect((await waitTerminal(h)).phase).toBe('cancelled')
    // Neither location goes away: the destination is the new default, the
    // source is still a first-class location every reader unions over.
    expect(h.locations.writeTargets('recordings')[0]?.id).toBe('recordings:new')
    expect(h.locations.getLocationById('recordings:old')).toBeDefined()
  })

  it('refuses to cancel while the cutover itself is in flight', async () => {
    const h = buildHarness({ failRefreshOnce: true })
    const jobId = await h.coordinator.start({
      mode: 'nonBlocking',
      destinations: { recordings: 'recordings:new' },
    })
    // Stalled in `refreshing`: repointed, writers still paused on stale roots.
    // Cancelling here would resume them against a default they cannot see.
    expect((await waitPhase(h, 'refreshing')).repointed).toBe(true)
    expect(await h.coordinator.cancel(jobId)).toBe(false)
  })

  it('does not re-pause every writer to recover a drain', async () => {
    const h = buildHarness()
    h.setState({
      jobId: 'drain-recovery',
      phase: 'draining',
      mode: 'nonBlocking',
      destinations: { recordings: 'recordings:new' },
      throttleMbps: 40,
      moves: [
        {
          storageClass: 'recordings',
          fromLocationId: 'recordings:old',
          toLocationId: 'recordings:new',
          moverJobId: null,
          state: null,
          error: null,
          progress: null,
        },
      ],
      pauseLeaseId: null,
      pausedParticipants: [],
      repointed: true,
      cancelRequested: false,
      startedAt: 1,
      updatedAt: 1,
      finishedAt: null,
      error: null,
    })
    await h.coordinator.recover()
    expect((await waitTerminal(h)).phase).toBe('done')
    // Re-acquiring a maintenance lease here would stop recording for the length
    // of the drain — the exact cost this mode exists to avoid.
    expect(h.calls.filter((call) => call.startsWith('pause:'))).toEqual([])
    expect(h.calls).toContain('drain:recorder')
  })

  it('fails a drain terminally instead of rewinding to refreshing', async () => {
    const h = buildHarness({ failRecorder: true })
    await h.coordinator.start({
      mode: 'nonBlocking',
      destinations: { recordings: 'recordings:new' },
    })
    const job = await waitTerminal(h)
    // Repointed, but every writer is already up on the new root: a drain
    // failure is an ordinary terminal failure, and the class stays readable
    // from both locations.
    expect(job.phase).toBe('failed')
    expect(job.repointed).toBe(true)
    expect(h.calls).toContain('resume:pipeline')
  })
})

describe('StorageMigrationCoordinator — the eventMedia seal', () => {
  it('refuses to PLAN a non-blocking eventMedia cutover while rows carry no location', async () => {
    const h = buildHarness({ unstampedRows: 7 })
    await expect(
      h.coordinator.plan({ mode: 'nonBlocking', destinations: { eventMedia: 'eventMedia:new' } }),
    ).rejects.toThrow(/7 event-media row\(s\) still carry no locationId/)
  })

  it('permits the same plan once the count is zero', async () => {
    const h = buildHarness({ unstampedRows: 0 })
    const plan = await h.coordinator.plan({
      mode: 'nonBlocking',
      destinations: { eventMedia: 'eventMedia:new' },
    })
    expect(plan.mode).toBe('nonBlocking')
    expect(plan.moves).toHaveLength(1)
    expect(plan.findings.some((f) => f.code === 'unstampedEventMediaRows')).toBe(false)
  })

  it('lets a BLOCKING migration through, with the count as a finding', async () => {
    const h = buildHarness({ unstampedRows: 7 })
    const plan = await h.coordinator.plan({ destinations: { eventMedia: 'eventMedia:new' } })
    const finding = plan.findings.find((f) => f.code === 'unstampedEventMediaRows')
    expect(finding?.message).toContain('7 event-media row(s)')
  })

  it('refuses a non-blocking plan when the count could not be TAKEN', async () => {
    // Unknown is not an absence. A gate that opened here would repoint the
    // default over a collection nobody managed to read.
    const h = buildHarness({ unstampedUnmeasurable: true })
    await expect(
      h.coordinator.plan({ mode: 'nonBlocking', destinations: { eventMedia: 'eventMedia:new' } }),
    ).rejects.toThrow(/could not determine whether any event-media row/)
  })

  it('reports the unmeasured count on a BLOCKING plan instead of omitting it', async () => {
    const h = buildHarness({ unstampedUnmeasurable: true })
    const plan = await h.coordinator.plan({ destinations: { eventMedia: 'eventMedia:new' } })
    const finding = plan.findings.find((f) => f.code === 'unstampedEventMediaRows')
    expect(finding?.message).toContain('could not be taken')
    expect(finding?.message).toContain('unknown, not as zero')
  })

  it('refuses on "some, size unknown" — the number is decoration, presence is the gate', async () => {
    const h = buildHarness({ unstampedRows: 7, unstampedSizeUnknown: true })
    await expect(
      h.coordinator.plan({ mode: 'nonBlocking', destinations: { eventMedia: 'eventMedia:new' } }),
    ).rejects.toThrow(/an unknown number of event-media row\(s\) still carry no locationId/)
  })

  it('fails the JOB when the post-seal re-count cannot be taken', async () => {
    // The plan-time count lands clean; the RE-count after the seal does not.
    // The job's own gate must be no softer than the plan's — it is the one
    // standing between a racing writer and the repoint.
    const h = buildHarness({ unstampedRows: 0, unmeasurableFromCall: 3 })
    await h.coordinator.start({
      mode: 'nonBlocking',
      destinations: { eventMedia: 'eventMedia:new' },
    })
    const job = await waitTerminal(h)
    expect(job.phase).toBe('failed')
    expect(job.error).toMatch(/could not be\s+measured afterwards/)
    expect(job.repointed).toBe(false)
    expect(h.locations.writeTargets('eventMedia')[0]?.id).toBe('eventMedia:old')
  })

  it('seals against the SOURCE before anything is paused', async () => {
    // Rows written between the plan and the start: the plan gate passed, the
    // in-job seal is what catches them.
    const h = buildHarness({ unstampedRows: 0 })
    await h.coordinator.start({
      mode: 'nonBlocking',
      destinations: { eventMedia: 'eventMedia:new' },
    })
    expect((await waitTerminal(h)).phase).toBe('done')
    // Nothing to seal, so no seal ran — and the whole cutover still happened.
    expect(h.calls.some((call) => call.startsWith('seal:'))).toBe(false)
    expect(h.locations.writeTargets('eventMedia')[0]?.id).toBe('eventMedia:new')
  })

  it('stamps rows that raced the plan with the SOURCE id, never the destination', async () => {
    // The plan gate saw zero; four rows appeared behind it. The in-job seal is
    // the only thing standing between them and a repoint.
    const h = buildHarness({ unstampedRows: 0, raceRows: 4, unsealableRows: 0 })
    await h.coordinator.start({
      mode: 'nonBlocking',
      destinations: { eventMedia: 'eventMedia:new' },
    })
    expect((await waitTerminal(h)).phase).toBe('done')
    // The bytes have not moved. Stamping them with the destination would be
    // the very orphaning the seal exists to prevent.
    expect(h.calls[0]).toBe('seal:analytics:eventMedia:old')
    expect(h.calls.indexOf('seal:analytics:eventMedia:old')).toBeLessThan(
      h.calls.indexOf('pause:pipeline'),
    )
  })

  it('fails the job before pausing or repointing when the seal cannot finish', async () => {
    const h = buildHarness({ unstampedRows: 0, raceRows: 4, unsealableRows: 2 })
    await h.coordinator.start({
      mode: 'nonBlocking',
      destinations: { eventMedia: 'eventMedia:new' },
    })
    const job = await waitTerminal(h)
    expect(job.phase).toBe('failed')
    expect(job.error).toMatch(/seal left 2 row\(s\) without a locationId/)
    expect(job.repointed).toBe(false)
    expect(h.calls).not.toContain('pause:pipeline')
    expect(h.locations.writeTargets('eventMedia')[0]?.id).toBe('eventMedia:old')
  })
})

describe('StorageMigrationCoordinator — four classes', () => {
  it('refuses a class no mover owns instead of repointing it empty', async () => {
    const h = buildHarness()
    await expect(h.coordinator.plan({ destinations: { backups: 'backups:new' } })).rejects.toThrow(
      /No mover owns "backups"/,
    )
  })

  it('refuses galleryMedia — the enrolled gallery is not a storage class', async () => {
    const h = buildHarness()
    await expect(
      h.coordinator.plan({ destinations: { galleryMedia: 'galleryMedia:new' } }),
    ).rejects.toThrow(/no longer a storage class/)
  })

  it('names an unanswerable same-device question rather than assuming it is clear', async () => {
    const h = buildHarness()
    const plan = await h.coordinator.plan({ destinations: { recordings: 'recordings:new' } })
    const finding = plan.findings.find((f) => f.code === 'deviceIdentityUnknown')
    expect(finding?.message).toContain('PATH identity, not st_dev')
  })

  it('a named source outside the write set moves bytes, leaves the write target unchanged, and stays disabled', async () => {
    const h = buildHarness()
    // `recordings` already has two locations by this point (`:old`, `:new`),
    // so this THIRD one is born disabled by `resolveEnabled`'s create rule —
    // never in the write set to begin with, which is what makes it a
    // `freezeSource` move rather than a live cutover.
    h.locations.upsertLocation(location('recordings:hdd', 'recordings'))
    const plan = await h.coordinator.plan({
      destinations: { recordings: 'recordings:new' },
      sources: { recordings: 'recordings:hdd' },
    })
    expect(plan.moves[0]).toMatchObject({
      fromLocationId: 'recordings:hdd',
      toLocationId: 'recordings:new',
      freezeSource: true,
    })
    await h.coordinator.start({
      destinations: { recordings: 'recordings:new' },
      sources: { recordings: 'recordings:hdd' },
    })
    const job = await waitTerminal(h)
    expect(job.phase).toBe('done')
    expect(h.locations.writeTargets('recordings')[0]?.id).toBe('recordings:old')
    expect(h.locations.getLocationById('recordings:hdd')?.enabled).toBe(false)
  })

  it('reports a destination that resolves onto its own source', async () => {
    const h = buildHarness({
      deviceKeys: { 'recordings:old': '/mnt/disk1', 'recordings:new': '/mnt/disk1' },
    })
    const plan = await h.coordinator.plan({ destinations: { recordings: 'recordings:new' } })
    expect(plan.findings.some((f) => f.code === 'sharesDeviceWithSource')).toBe(true)
  })

  it('serializes two eventMedia-lane jobs through the one media engine', async () => {
    const h = buildHarness()
    await h.coordinator.start({
      destinations: { eventMedia: 'eventMedia:new' },
    })
    expect((await waitTerminal(h)).phase).toBe('done')
    expect(h.calls.filter((call) => call === 'move:analytics')).toHaveLength(1)
  })
})

/**
 * The mover's numbers, where an operator reads them.
 *
 * The fixture that matters here is a mover whose counters MOVE. A mover stuck
 * at one value would be satisfied by a coordinator that folded a constant — or
 * folded nothing and left the field at its initial `null`-shaped zero.
 */
describe('StorageMigrationCoordinator — mover progress', () => {
  it('folds the mover counters onto the durable move, and they advance', async () => {
    const h = buildHarness({ movingPolls: 4 })
    await h.coordinator.start({ destinations: { recordings: 'recordings:new' } })
    const seen: number[] = []
    for (let i = 0; i < 200; i++) {
      const job = await h.coordinator.status()
      const progress = job?.moves[0]?.progress ?? null
      if (progress !== null && seen[seen.length - 1] !== progress.filesMoved) {
        seen.push(progress.filesMoved)
      }
      if (job?.phase === 'done') break
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    // Strictly increasing, more than one distinct value, and it lands on the
    // denominator: a folded constant produces one value, and no fold produces
    // none at all.
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.toSorted((a, b) => a - b)).toEqual(seen)
    const final = (await h.coordinator.status())?.moves[0]?.progress
    expect(final?.filesMoved).toBe(400)
    expect(final?.filesTotal).toBe(400)
    expect(final?.bytesMoved).toBe(4_000_000)
    // The MOVER's own start, not the migration's — a rate computed from the
    // migration's start would average in time nothing was running.
    expect(final?.startedAt).toBe(1)
    expect(final?.observedAt).toBe(1)
  })

  it('carries the last observed counters into the terminal record', async () => {
    const h = buildHarness({ movingPolls: 2 })
    await h.coordinator.start({ destinations: { recordings: 'recordings:new' } })
    const job = await waitTerminal(h)
    expect(job.phase).toBe('done')
    expect(job.moves[0]?.progress).not.toBeNull()
    expect(job.moves[0]?.progress?.filesMoved).toBe(200)
  })

  it('lists a mover no migration armed, and marks it unowned', async () => {
    const byHand: RelocateJob = {
      ...doneJob('cefb41c2'),
      state: 'running',
      finishedAt: null,
      filesMoved: 3588,
      filesTotal: 136_885,
      bytesMoved: 2_505_552_556,
    }
    const h = buildHarness({ preexistingMovers: [byHand] })
    const movers = await h.coordinator.movers()
    const unowned = movers.find((mover) => mover.job.jobId === 'cefb41c2')
    expect(unowned?.migrationJobId).toBeNull()
    expect(unowned?.lane).toBe('footage')
    expect(unowned?.job.filesTotal).toBe(136_885)
  })

  it('attributes a mover the running migration armed', async () => {
    const h = buildHarness({ running: true })
    const jobId = await h.coordinator.start({ destinations: { recordings: 'recordings:new' } })
    await waitPhase(h, 'moving')
    const movers = await h.coordinator.movers()
    expect(movers).toHaveLength(1)
    expect(movers[0]?.migrationJobId).toBe(jobId)
    await h.coordinator.cancel(jobId)
    await waitTerminal(h)
  })
})

/**
 * The drain half, on its own.
 *
 * The situation this exists for, hit live on 2026-08-29: a migration reached
 * `done`, so the destination IS the default and `start` correctly refuses it —
 * but the drain never finished and 80.3 GB stayed on the source with no
 * supported way to move it.
 */
describe('StorageMigrationCoordinator — drain', () => {
  /**
   * A migration that reached `done`: `recordingsLow:new` is the default, and
   * `recordingsLow:old` still holds whatever `residue` says.
   */
  async function afterMigration(
    residue: Readonly<Record<string, { segments: number; bytes: number } | null>>,
    extra?: { movingPolls?: number },
  ) {
    const h = buildHarness({ footageResidue: residue, ...extra })
    // `setDefaultLocations(type -> id)` is retired (D383); `setWriteTargets`
    // takes the explicit enable/disable pair a real cutover's `repointing`
    // phase would apply.
    await h.locations.setWriteTargets(
      new Map([
        ['recordingsLow:new', true],
        ['recordingsLow:old', false],
      ]),
    )
    return h
  }

  it('offers a resume when the source still holds rows', async () => {
    const h = await afterMigration({
      'recordingsLow:old': { segments: 145_664, bytes: 80_300_000_000 },
    })
    const residue = await h.coordinator.residue()
    const low = residue.find((entry) => entry.storageClass === 'recordingsLow')
    expect(low?.fromLocationId).toBe('recordingsLow:old')
    expect(low?.toLocationId).toBe('recordingsLow:new')
    expect(low?.items).toBe(145_664)
    expect(low?.bytes).toBe(80_300_000_000)
  })

  it('offers no resume when the source is empty', async () => {
    const h = await afterMigration({})
    const residue = await h.coordinator.residue()
    expect(residue.filter((entry) => entry.storageClass === 'recordingsLow')).toEqual([])
    await expect(h.coordinator.drain({ classes: ['recordingsLow'] })).rejects.toThrow(
      /nothing left outside its write set/,
    )
  })

  it('still offers a resume the archive could not measure', async () => {
    const h = await afterMigration({ 'recordingsLow:old': null })
    const residue = await h.coordinator.residue()
    const low = residue.find((entry) => entry.storageClass === 'recordingsLow')
    // Unknown is not zero: dropping this entry would hide the one case an
    // operator most needs to act on.
    expect(low?.items).toBeNull()
    expect(low?.bytes).toBeNull()
  })

  it('drains without repointing, and without pausing anything', async () => {
    const h = await afterMigration({
      'recordingsLow:old': { segments: 145_664, bytes: 80_300_000_000 },
    })
    // `start` refuses, correctly — there is nothing left to repoint.
    await expect(
      h.coordinator.start({ destinations: { recordingsLow: 'recordingsLow:new' } }),
    ).rejects.toThrow(/already the only write target for "recordingsLow"/)

    const jobId = await h.coordinator.drain({ classes: ['recordingsLow'] })
    const job = await waitTerminal(h)
    expect(job.jobId).toBe(jobId)
    expect(job.phase).toBe('done')
    expect(job.mode).toBe('nonBlocking')
    expect(job.moves[0]?.fromLocationId).toBe('recordingsLow:old')
    expect(job.moves[0]?.toLocationId).toBe('recordingsLow:new')
    // It went through the UNLEASED entry point and never touched a writer.
    expect(h.calls).toContain('drain:recorder')
    expect(h.calls.filter((call) => call.startsWith('pause:'))).toEqual([])
    expect(h.calls.filter((call) => call.startsWith('resume:'))).toEqual([])
    expect(h.calls.filter((call) => call.startsWith('refresh:'))).toEqual([])
    // And the default is exactly where the migration left it.
    expect(h.locations.writeTargets('recordingsLow')[0]?.id).toBe('recordingsLow:new')
  })

  it('reports the drain progress on the same shape a migration uses', async () => {
    const h = await afterMigration(
      { 'recordingsLow:old': { segments: 400, bytes: 1 } },
      { movingPolls: 3 },
    )
    await h.coordinator.drain({ classes: ['recordingsLow'] })
    const job = await waitTerminal(h)
    expect(job.moves[0]?.progress?.filesMoved).toBe(300)
  })

  it('refuses a class no mover owns rather than starting a job that moves nothing', async () => {
    const h = await afterMigration({ 'recordingsLow:old': { segments: 1, bytes: 1 } })
    await expect(h.coordinator.drain({ classes: ['backups'] })).rejects.toThrow(/No mover owns/)
  })

  it('refuses a drain while a migration is running', async () => {
    const h = buildHarness({
      running: true,
      footageResidue: { 'recordingsLow:old': { segments: 1, bytes: 1 } },
    })
    const jobId = await h.coordinator.start({ destinations: { recordings: 'recordings:new' } })
    await waitPhase(h, 'moving')
    await expect(h.coordinator.drain({ classes: ['recordingsLow'] })).rejects.toThrow(
      /already active/,
    )
    await h.coordinator.cancel(jobId)
    await waitTerminal(h)
  })

  it('keeps reporting the footage lane when the media addon cannot answer', async () => {
    const h = await afterMigration({
      'recordingsLow:old': { segments: 145_664, bytes: 80_300_000_000 },
    })
    h.failMediaResidue()
    const residue = await h.coordinator.residue()
    // The footage residue survives an unrelated addon being mid-restart. It
    // would not if one throwing read took the whole call down — and an operator
    // with 80 GB stranded would be told nothing at all.
    expect(residue.find((entry) => entry.storageClass === 'recordingsLow')?.items).toBe(145_664)
    // And the lane that could not answer is LISTED as unknown, not dropped.
    expect(residue.find((entry) => entry.storageClass === 'eventMedia')?.items).toBeNull()
  })

  it('drains the media lane against the current default', async () => {
    const h = buildHarness({ mediaResidue: { rows: 12 } })
    const residue = await h.coordinator.residue()
    const media = residue.find((entry) => entry.storageClass === 'eventMedia')
    expect(media?.fromLocationId).toBe('eventMedia:new')
    expect(media?.toLocationId).toBe('eventMedia:old')
    expect(media?.items).toBe(12)
    // The media lane counts rows, not bytes, and says so rather than guessing.
    expect(media?.bytes).toBeNull()
    await h.coordinator.drain({ classes: ['eventMedia'] })
    const job = await waitTerminal(h)
    expect(job.phase).toBe('done')
    expect(h.calls).toContain('drain:analytics')
  })
})
