/**
 * The hourly, change-gated face rescore (D866): the decision to run, not the
 * run itself (that is `face-rescore-job.spec.ts`).
 */
import { describe, expect, it } from 'vitest'
import type { LogExtras } from '@camstack/types'
import { FaceRescoreJob, type FaceRescorePorts } from '../face-rescore-job.js'
import { FaceRescoreScheduler } from '../face-rescore-scheduler.js'
import type {
  FaceRescoreRunState,
  FaceRescoreStatePort,
} from '../store/face-rescore-state-store.js'
import { makeSilentLogger } from './test-helpers.js'

const MINUTE = 60_000

interface World {
  clock: number
  intervalMinutes: number | null
  galleryVersion: number
  pending: { count: number; maxTimestamp: number }
  saved: FaceRescoreRunState | null
  infos: string[]
  scans: number
  hold: Promise<void> | null
}

function build(world: World): { scheduler: FaceRescoreScheduler; job: FaceRescoreJob } {
  const logger = {
    ...makeSilentLogger(),
    info: (message: string, _extras?: LogExtras): void => {
      world.infos.push(message)
    },
  }
  const ports: FaceRescorePorts = {
    resolveClusterModelId: () => Promise.resolve('m1'),
    galleryManifest: () =>
      Promise.resolve([
        { sampleId: `s${String(world.galleryVersion)}`, identityId: 'anna', modelId: 'm1' },
      ]),
    pendingMarker: () => Promise.resolve(world.pending),
    loadGallery: () => Promise.resolve([]),
    identityNames: () => Promise.resolve(new Map()),
    paramsForDevice: () =>
      Promise.resolve({
        threshold: 0.9,
        margin: 0.05,
        minIdentitySamples: 1,
        suggestionMinCosine: 0.5,
        suggestionBandFactor: 0.55,
      }),
    listPendingFaceIds: () => {
      world.scans += 1
      return Promise.resolve(['f1'])
    },
    loadRescoreBatch: () => Promise.resolve({ rows: [], noVector: 0, gone: 0 }),
    applySuggestionBatch: () => Promise.resolve(),
    recordCompletion: (status) => {
      world.saved = { fingerprint: status.fingerprint, finishedAt: world.clock, report: status }
      return Promise.resolve()
    },
    pause: () => world.hold ?? Promise.resolve(),
    now: () => world.clock,
    newJobId: () => `job-${String(world.scans)}`,
    logger,
  }
  const job = new FaceRescoreJob(ports)
  const state: FaceRescoreStatePort = {
    load: () => Promise.resolve(world.saved),
    save: (s) => {
      world.saved = s
      return Promise.resolve()
    },
  }
  const scheduler = new FaceRescoreScheduler(
    {
      readIntervalMinutes: () =>
        world.intervalMinutes === null
          ? Promise.reject(new Error('settings down'))
          : Promise.resolve(world.intervalMinutes),
      job,
      fingerprintPorts: ports,
      state,
      now: () => world.clock,
      logger,
    },
    world.clock,
  )
  return { scheduler, job }
}

function newWorld(): World {
  return {
    clock: 1_000_000,
    intervalMinutes: 60,
    galleryVersion: 1,
    pending: { count: 5, maxTimestamp: 100 },
    saved: null,
    infos: [],
    scans: 0,
    hold: null,
  }
}

describe('FaceRescoreScheduler', () => {
  it('does not run at boot: the first run is one interval after start', async () => {
    const w = newWorld()
    const { scheduler } = build(w)
    expect(await scheduler.tick()).toBe('not-due')
    w.clock += 59 * MINUTE
    expect(await scheduler.tick()).toBe('not-due')
    expect(w.scans).toBe(0)
    w.clock += MINUTE
    expect(await scheduler.tick()).toBe('ran')
    expect(w.scans).toBe(1)
  })

  it('skips with one log line when nothing changed since the last completed run', async () => {
    const w = newWorld()
    const { scheduler } = build(w)
    w.clock += 60 * MINUTE
    expect(await scheduler.tick()).toBe('ran')
    w.clock += 60 * MINUTE
    expect(await scheduler.tick()).toBe('unchanged')
    expect(w.scans).toBe(1)
    expect(w.infos.filter((m) => m === 'face rescore skipped, unchanged')).toHaveLength(1)
  })

  it('runs again when a sample was added, or when a new unassigned face arrived', async () => {
    const w = newWorld()
    const { scheduler } = build(w)
    w.clock += 60 * MINUTE
    await scheduler.tick()
    w.galleryVersion = 2
    w.clock += 60 * MINUTE
    expect(await scheduler.tick()).toBe('ran')
    w.pending = { count: 6, maxTimestamp: 200 }
    w.clock += 60 * MINUTE
    expect(await scheduler.tick()).toBe('ran')
    expect(w.scans).toBe(3)
  })

  it('treats a manual run as done: the next tick sees the recorded fingerprint', async () => {
    const w = newWorld()
    const { scheduler, job } = build(w)
    job.start()
    await job.whenSettled()
    w.clock += 60 * MINUTE
    expect(await scheduler.tick()).toBe('unchanged')
    expect(w.scans).toBe(1)
  })

  it('shares the single-flight with the manual method', async () => {
    const w = newWorld()
    let release: () => void = () => {}
    w.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    w.pending = { count: 0, maxTimestamp: 0 }
    const { scheduler, job } = build(w)
    // A manual job in flight, held after its first (empty) pass.
    w.pending = { count: 1, maxTimestamp: 1 }
    const manual = job.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    w.clock += 60 * MINUTE
    expect(await scheduler.tick()).toBe('busy')
    expect(job.start().jobId).toBe(manual.jobId)
    expect(w.scans).toBe(1)
    release()
    await job.whenSettled()
  })

  it('0 disables it; the interval is re-read on every tick, no restart', async () => {
    const w = newWorld()
    w.intervalMinutes = 0
    const { scheduler } = build(w)
    w.clock += 600 * MINUTE
    expect(await scheduler.tick()).toBe('disabled')
    expect(w.scans).toBe(0)
    w.intervalMinutes = 10
    expect(await scheduler.tick()).toBe('ran')
  })

  it('a setting that cannot be read skips the tick instead of guessing', async () => {
    const w = newWorld()
    w.intervalMinutes = null
    const { scheduler } = build(w)
    w.clock += 600 * MINUTE
    expect(await scheduler.tick()).toBe('setting-unreadable')
    expect(w.scans).toBe(0)
  })
})
