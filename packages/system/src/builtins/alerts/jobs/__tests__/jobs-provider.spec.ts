/**
 * The `jobs` ledger over a REAL records engine: audience, cancel routing, terminal
 * monotonicity, idempotent register, retention on write (configured values), reconcile.
 */
import {
  createRecordsAccess,
  type CapCaller,
  type IScopedLogger,
  type JobRegisterInput,
  type JobSourceEntry,
  type JobState,
} from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRecordsWorld } from '../../../sqlite-storage/__tests__/support/records-world.js'
import { jobRecordKinds } from '../job-records.js'
import { JobStore } from '../job-store.js'
import {
  JobsProvider,
  PROGRESS_PERSIST_MS,
  RECONCILE_GRACE_MS,
  type IJobProducerClient,
} from '../jobs-provider.js'
import { jobsRetentionKnobs, resolveJobRetention } from '../jobs-retention-knobs.js'
import type { JobRetention } from '../job-policy.js'

const DAY = 24 * 60 * 60 * 1000
const ALICE: CapCaller = { userId: 'alice', isAdmin: false }
const BOB: CapCaller = { userId: 'bob', isAdmin: false }
const ADMIN: CapCaller = { userId: 'root', isAdmin: true }

function logger(): IScopedLogger {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => l) }
  return l as unknown as IScopedLogger
}

interface Producer extends IJobProducerClient {
  getJobs: ReturnType<typeof vi.fn<IJobProducerClient['getJobs']>>
  cancelJob: ReturnType<typeof vi.fn<IJobProducerClient['cancelJob']>>
  resolveResult: ReturnType<typeof vi.fn<IJobProducerClient['resolveResult']>>
}

function makeProducer(): Producer {
  return {
    getJobs: vi.fn<IJobProducerClient['getJobs']>(async () => []),
    cancelJob: vi.fn<IJobProducerClient['cancelJob']>(async () => ({ accepted: true })),
    resolveResult: vi.fn<IJobProducerClient['resolveResult']>(async () => null),
  }
}

function input(over: Partial<JobRegisterInput> = {}): JobRegisterInput {
  return {
    kind: 'adoption',
    producerAddonId: 'device-manager',
    ownerUserId: 'alice',
    audience: 'owner',
    titleKey: 'jobs.adoption.title',
    titleParams: {},
    state: 'running',
    cancellable: true,
    idempotencyKey: 'k-1',
    ...over,
  }
}

interface Rig {
  readonly jobs: JobsProvider
  readonly store: JobStore
  readonly producer: Producer
  readonly emitted: { jobId: string; state: JobState }[]
  readonly clock: { now: number }
  readonly retention: { value: JobRetention }
}

async function rig(): Promise<Rig> {
  const world = makeRecordsWorld()
  await world.provider.init()
  const records = createRecordsAccess({
    owner: 'alert-center',
    transport: world.transportFor('alert-center'),
    secrets: null,
  })
  await records.declare(jobRecordKinds)
  const store = JobStore.of(records)
  const producer = makeProducer()
  const emitted: { jobId: string; state: JobState }[] = []
  const clock = { now: 1_000_000_000 }
  const retention = { value: { retentionDays: 30, maxPerOwner: 200 } }
  let seq = 0
  const jobs = new JobsProvider({
    store,
    producers: producer,
    emitChanged: (jobId, state) => emitted.push({ jobId, state }),
    retention: () => retention.value,
    logger: logger(),
    now: () => clock.now,
    newId: () => `job-${(seq += 1)}`,
  })
  return { jobs, store, producer, emitted, clock, retention }
}

const list = (r: Rig, caller: CapCaller, entity?: { kind: string; id: string }) =>
  r.jobs.list(caller, { includeDismissed: false, ...(entity !== undefined ? { entity } : {}) })

describe('jobs provider — audience', () => {
  let r: Rig
  beforeEach(async () => {
    r = await rig()
  })

  it('the owner sees their job; another viewer does not', async () => {
    const { jobId } = await r.jobs.register(input())
    expect((await list(r, ALICE)).map((j) => j.jobId)).toEqual([jobId])
    expect(await list(r, BOB)).toEqual([])
    expect(await r.jobs.get(BOB, jobId)).toBeNull()
  })

  it('an admin sees an admins-audience job but never another user owner job', async () => {
    const mine = await r.jobs.register(input({ idempotencyKey: 'a', ownerUserId: 'alice' }))
    const system = await r.jobs.register(
      input({ idempotencyKey: 's', ownerUserId: 'system', audience: 'admins' }),
    )
    const ids = (await list(r, ADMIN)).map((j) => j.jobId)
    expect(ids).toEqual([system.jobId])
    expect(ids).not.toContain(mine.jobId)
    expect(await r.jobs.get(ADMIN, mine.jobId)).toBeNull()
    // a non-admin never sees the admins audience
    expect(await list(r, ALICE).then((l) => l.map((j) => j.jobId))).toEqual([mine.jobId])
  })

  it('dismiss hides per user and refuses a job the caller cannot see', async () => {
    const { jobId } = await r.jobs.register(input())
    expect(await r.jobs.dismiss(BOB, jobId)).toEqual({ dismissed: false })
    expect(await r.jobs.dismiss(ALICE, jobId)).toEqual({ dismissed: true })
    expect(await list(r, ALICE)).toEqual([])
    expect((await r.jobs.list(ALICE, { includeDismissed: true })).length).toBe(1)
  })

  it('the entity filter matches exactly and never leaks another user owner job', async () => {
    const entity = { kind: 'export', id: 'e1' }
    const mine = await r.jobs.register(input({ idempotencyKey: 'm', subject: { entity } }))
    await r.jobs.register(
      input({ idempotencyKey: 'other-entity', subject: { entity: { kind: 'export', id: 'e2' } } }),
    )
    await r.jobs.register(input({ idempotencyKey: 'no-entity' }))
    await r.jobs.register(
      input({ idempotencyKey: 'bobs', ownerUserId: 'bob', subject: { entity } }),
    )
    expect((await list(r, ALICE, entity)).map((j) => j.jobId)).toEqual([mine.jobId])
    expect((await list(r, ADMIN, entity)).length).toBe(0)
  })
})

describe('jobs provider — register / update', () => {
  it('register is idempotent on the idempotencyKey', async () => {
    const r = await rig()
    const a = await r.jobs.register(input())
    const b = await r.jobs.register(input({ titleKey: 'other' }))
    expect(b.jobId).toBe(a.jobId)
    expect((await r.store.all()).length).toBe(1)
    expect(r.emitted.length).toBe(1)
  })

  it('a terminal state never walks back', async () => {
    const r = await rig()
    const { jobId } = await r.jobs.register(input())
    expect(await r.jobs.update({ jobId, state: 'done' })).toEqual({ updated: true })
    expect(await r.jobs.update({ jobId, state: 'running' })).toEqual({ updated: false })
    expect(
      await r.jobs.update({ jobId, state: 'failed', failure: { reason: 'error', message: 'x' } }),
    ).toEqual({
      updated: false,
    })
    const job = await r.jobs.get(ALICE, jobId)
    expect(job?.state).toBe('done')
    expect(job?.failure).toBeNull()
    expect(job?.finishedAt).not.toBeNull()
    expect(r.emitted.map((e) => e.state)).toEqual(['running', 'done'])
  })

  it('a running job does not go back to queued', async () => {
    const r = await rig()
    const { jobId } = await r.jobs.register(input())
    await r.jobs.update({ jobId, state: 'queued' })
    expect((await r.jobs.get(ALICE, jobId))?.state).toBe('running')
  })

  it('progress is kept in memory and persisted at most once per 5 s; a transition writes at once', async () => {
    const r = await rig()
    const { jobId } = await r.jobs.register(input())
    const stored = async () => (await r.store.get(jobId))?.progress ?? null
    r.clock.now += 1_000
    await r.jobs.update({ jobId, progress: { done: 1, total: 10, unit: 'candidates' } })
    expect(await stored()).toBeNull()
    expect((await r.jobs.get(ALICE, jobId))?.progress?.done).toBe(1)
    r.clock.now += PROGRESS_PERSIST_MS
    await r.jobs.update({ jobId, progress: { done: 6, total: 10, unit: 'candidates' } })
    expect((await stored())?.done).toBe(6)
    r.clock.now += 100
    await r.jobs.update({ jobId, progress: { done: 7, total: 10, unit: 'candidates' } })
    expect((await stored())?.done).toBe(6)
    await r.jobs.update({ jobId, state: 'done' })
    expect((await r.store.get(jobId))?.progress?.done).toBe(7)
  })
})

describe('jobs provider — cancel', () => {
  it('routes to the producer pinned to producerAddonId and changes no state itself', async () => {
    const r = await rig()
    const { jobId } = await r.jobs.register(input())
    const out = await r.jobs.cancel(ALICE, jobId)
    expect(out).toEqual({ accepted: true, reason: null })
    expect(r.producer.cancelJob).toHaveBeenCalledWith('device-manager', jobId)
    expect((await r.jobs.get(ALICE, jobId))?.state).toBe('running')
    expect(r.emitted.length).toBe(1)
  })

  it('refuses a non-cancellable job, a terminal job and a job the caller cannot see', async () => {
    const r = await rig()
    const fixed = await r.jobs.register(input({ idempotencyKey: 'f', cancellable: false }))
    const done = await r.jobs.register(input({ idempotencyKey: 'd' }))
    await r.jobs.update({ jobId: done.jobId, state: 'done' })
    expect((await r.jobs.cancel(ALICE, fixed.jobId)).reason).toBe('not-cancellable')
    expect((await r.jobs.cancel(ALICE, done.jobId)).reason).toBe('terminal')
    expect((await r.jobs.cancel(BOB, fixed.jobId)).reason).toBe('not-found')
    expect(r.producer.cancelJob).not.toHaveBeenCalled()
  })

  it('any admin may cancel an admins-audience job; the producer saying no is reported', async () => {
    const r = await rig()
    const { jobId } = await r.jobs.register(input({ ownerUserId: 'system', audience: 'admins' }))
    expect((await r.jobs.cancel(ALICE, jobId)).reason).toBe('not-found')
    r.producer.cancelJob.mockResolvedValueOnce({ accepted: false })
    expect(await r.jobs.cancel(ADMIN, jobId)).toEqual({
      accepted: false,
      reason: 'producer-refused',
    })
    r.producer.cancelJob.mockRejectedValueOnce(new Error('down'))
    expect((await r.jobs.cancel(ADMIN, jobId)).reason).toBe('producer-unreachable')
    expect((await r.jobs.get(ADMIN, jobId))?.state).toBe('running')
  })
})

describe('jobs provider — retention on write', () => {
  async function finished(r: Rig, key: string, owner = 'alice'): Promise<string> {
    const { jobId } = await r.jobs.register(input({ idempotencyKey: key, ownerUserId: owner }))
    r.clock.now += 1_000
    await r.jobs.update({ jobId, state: 'done' })
    return jobId
  }

  it('keeps the newest maxPerOwner terminal jobs per owner and never prunes a running job', async () => {
    const r = await rig()
    r.retention.value = { retentionDays: 30, maxPerOwner: 2 }
    const running = await r.jobs.register(input({ idempotencyKey: 'run' }))
    const ids: string[] = []
    for (const k of ['a', 'b', 'c', 'd']) ids.push(await finished(r, k))
    const bobs = await finished(r, 'bob-1', 'bob')
    const left = (await r.store.all()).map((j) => j.jobId)
    expect(left).toContain(running.jobId)
    expect(left).toContain(bobs)
    expect(left).toContain(ids[3])
    expect(left).toContain(ids[2])
    expect(left).not.toContain(ids[0])
    expect(left).not.toContain(ids[1])
  })

  it('the configured knob decides what the prune keeps (days and per-owner count)', async () => {
    const r = await rig()
    const old = await finished(r, 'old')
    r.clock.now += 10 * DAY
    // 30-day window: the 10-day-old job survives the next write
    await finished(r, 'new-1')
    expect((await r.store.all()).map((j) => j.jobId)).toContain(old)
    // a configured 5-day window removes it on the next write
    r.retention.value = resolveJobRetention({ jobsRetentionDays: 5, jobsMaxPerOwner: 200 })
    await finished(r, 'new-2')
    expect((await r.store.all()).map((j) => j.jobId)).not.toContain(old)
  })

  it('deletes the dismissals together with the job', async () => {
    const r = await rig()
    r.retention.value = { retentionDays: 30, maxPerOwner: 1 }
    const first = await finished(r, 'one')
    await r.jobs.dismiss(ALICE, first)
    await finished(r, 'two')
    expect((await r.store.dismissedBy('alice')).has(first)).toBe(false)
  })

  it('the knobs list the configured values and fall back to defaults', () => {
    const knobs = jobsRetentionKnobs({ jobsRetentionDays: 7 })
    const days = knobs.find((k) => k.key === 'jobsRetentionDays')
    const count = knobs.find((k) => k.key === 'jobsMaxPerOwner')
    expect(days).toMatchObject({ value: 7, defaultValue: 30, min: 1, zeroMeansForever: false })
    expect(count).toMatchObject({ value: 200, defaultValue: 200, min: 1 })
    expect(days?.write).toMatchObject({
      method: 'updateScopedSettings',
      cap: 'jobs',
      key: 'jobsRetentionDays',
    })
  })
})

describe('jobs provider — reconcile', () => {
  const unknown = (jobId: string): JobSourceEntry => ({ jobId, unknown: true })
  const snap = (jobId: string, state: JobState): JobSourceEntry => ({
    jobId,
    snapshot: {
      state,
      failure: null,
      progress: { done: 3, total: 4, unit: 'candidates' },
      cancellable: true,
      finishedAt: null,
    },
  })

  async function aged(r: Rig): Promise<string> {
    const { jobId } = await r.jobs.register(input())
    r.clock.now += RECONCILE_GRACE_MS + 1
    return jobId
  }

  it('marks a job interrupted only when the SECOND read also says unknown', async () => {
    const r = await rig()
    const jobId = await aged(r)
    r.producer.getJobs.mockResolvedValue([unknown(jobId)])
    await r.jobs.reconcileProducer('device-manager')
    expect(r.producer.getJobs).toHaveBeenCalledTimes(2)
    const job = await r.jobs.get(ALICE, jobId)
    expect(job?.state).toBe('failed')
    expect(job?.failure?.reason).toBe('interrupted')
  })

  it('a first unknown contradicted by the second read leaves the job alive', async () => {
    const r = await rig()
    const jobId = await aged(r)
    r.producer.getJobs
      .mockResolvedValueOnce([unknown(jobId)])
      .mockResolvedValueOnce([snap(jobId, 'running')])
    await r.jobs.reconcileProducer('device-manager')
    const job = await r.jobs.get(ALICE, jobId)
    expect(job?.state).toBe('running')
    expect(job?.progress?.done).toBe(3)
  })

  it('a failed read changes nothing, first or second', async () => {
    const r = await rig()
    const jobId = await aged(r)
    r.producer.getJobs.mockRejectedValueOnce(new Error('unreachable'))
    await r.jobs.reconcileProducer('device-manager')
    expect((await r.jobs.get(ALICE, jobId))?.state).toBe('running')
    r.producer.getJobs
      .mockResolvedValueOnce([unknown(jobId)])
      .mockRejectedValueOnce(new Error('unreachable'))
    await r.jobs.reconcileProducer('device-manager')
    const job = await r.jobs.get(ALICE, jobId)
    expect(job?.state).toBe('running')
    expect(job?.failure).toBeNull()
  })

  it('takes the producer terminal snapshot, and leaves a job it just confirmed alone', async () => {
    const r = await rig()
    const fresh = await r.jobs.register(input({ idempotencyKey: 'fresh' }))
    await r.jobs.reconcileProducer('device-manager')
    expect(r.producer.getJobs).not.toHaveBeenCalled()
    r.clock.now += RECONCILE_GRACE_MS + 1
    r.producer.getJobs.mockResolvedValue([snap(fresh.jobId, 'done')])
    await r.jobs.reconcileProducer('device-manager')
    expect((await r.jobs.get(ALICE, fresh.jobId))?.state).toBe('done')
  })
})
