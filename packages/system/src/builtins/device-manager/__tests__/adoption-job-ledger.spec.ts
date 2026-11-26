/**
 * The adoption engine is the first producer of the `jobs` ledger (planning#719): it registers a
 * job when one starts, reports `{done, total, unit: 'candidates'}`, ends it with the engine's
 * terminal state, and answers the ledger's `job-source` questions.
 */
import type { IScopedLogger, JobRegisterInput, JobUpdateInput } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  AdoptionJobEngine,
  type AdoptionJobLedger,
  type AdoptionJobProvider,
} from '../adoption-job-engine.js'

function makeLogger(): IScopedLogger {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => l) }
  return l as unknown as IScopedLogger
}

function makeProvider(failOn: ReadonlySet<string> = new Set()): AdoptionJobProvider {
  let id = 100
  return {
    listCandidates: async () => ({ candidates: [] }),
    adopt: async (input) => {
      const child = input.childNativeIds[0] as string
      if (failOn.has(child)) throw new Error(`no ${child}`)
      id += 1
      return { adopted: [{ childNativeId: child, parentDeviceId: id, accessoryDeviceIds: [] }] }
    },
  }
}

interface LedgerRig {
  readonly ledger: AdoptionJobLedger
  readonly registered: JobRegisterInput[]
  readonly updates: JobUpdateInput[]
}

function makeLedger(opts: { failRegister?: boolean } = {}): LedgerRig {
  const registered: JobRegisterInput[] = []
  const updates: JobUpdateInput[] = []
  return {
    registered,
    updates,
    ledger: {
      register: async (input) => {
        if (opts.failRegister === true) throw new Error('jobs cap unavailable')
        registered.push(input)
        return { jobId: `ledger-${registered.length}` }
      },
      update: async (input) => {
        updates.push(input)
        return { updated: true }
      },
    },
  }
}

function makeEngine(provider: AdoptionJobProvider, ledger: AdoptionJobLedger): AdoptionJobEngine {
  let n = 0
  return new AdoptionJobEngine({
    resolveProvider: async () => provider,
    logger: makeLogger(),
    ledger,
    now: () => 1_000,
    newId: () => `adopt-${(n += 1)}`,
  })
}

const START = { addonId: 'provider-ha', integrationId: 'int_1', childNativeIds: ['a', 'b', 'c'] }

describe('adoption engine as a jobs producer', () => {
  it('registers a job on start and reports progress in candidates, then the terminal state', async () => {
    const rig = makeLedger()
    const engine = makeEngine(makeProvider(), rig.ledger)
    const { jobId } = await engine.start({ ...START, ownerUserId: 'alice' })
    await engine.waitForTest(jobId)

    expect(rig.registered).toHaveLength(1)
    expect(rig.registered[0]).toMatchObject({
      kind: 'adoption',
      producerAddonId: 'device-manager',
      ownerUserId: 'alice',
      audience: 'owner',
      cancellable: true,
      idempotencyKey: jobId,
      progress: { done: 0, total: 3, unit: 'candidates' },
    })
    expect(rig.registered[0]?.subject).toBeUndefined()
    const progress = rig.updates.map((u) => u.progress)
    expect(progress.at(-1)).toEqual({ done: 3, total: 3, unit: 'candidates' })
    expect(progress.some((p) => p?.done === 1)).toBe(true)
    expect(rig.updates.every((u) => u.jobId === 'ledger-1')).toBe(true)
    expect(rig.updates.at(-1)?.state).toBe('done')
  })

  it('an automatic job belongs to system and is visible to admins', async () => {
    const rig = makeLedger()
    const engine = makeEngine(makeProvider(), rig.ledger)
    const auto = await engine.start({ ...START, adoptedBy: 'auto', ownerUserId: 'alice' })
    await engine.waitForTest(auto.jobId)
    const unattended = await engine.start({ ...START })
    await engine.waitForTest(unattended.jobId)
    for (const registered of rig.registered) {
      expect(registered).toMatchObject({ ownerUserId: 'system', audience: 'admins' })
    }
    expect(rig.registered).toHaveLength(2)
  })

  it('per-candidate failures are results: the job itself still ends done', async () => {
    const rig = makeLedger()
    const engine = makeEngine(makeProvider(new Set(['a', 'b', 'c'])), rig.ledger)
    const { jobId } = await engine.start({ ...START, ownerUserId: 'alice' })
    await engine.waitForTest(jobId)
    expect(engine.get(jobId)?.state).toBe('done')
    expect(rig.updates.at(-1)?.state).toBe('done')
    expect(rig.updates.at(-1)?.failure).toBeUndefined()
  })

  it('a job that itself breaks ends failed in the ledger with the error', async () => {
    const rig = makeLedger()
    // The job loop breaks outside any one candidate: the already-adopted log line throws.
    const logger = makeLogger()
    logger.info = vi.fn((message: string) => {
      if (message.includes('already adopted')) throw new Error('log sink down')
    })
    const skipFirst: AdoptionJobProvider = {
      listCandidates: async () => ({
        candidates: [{ childNativeId: 'a', alreadyAdopted: true }],
        totalCount: 1,
      }),
      adopt: async () => ({ adopted: [] }),
    }
    let n = 0
    const engine = new AdoptionJobEngine({
      resolveProvider: async () => skipFirst,
      logger,
      ledger: rig.ledger,
      now: () => 1_000,
      newId: () => `adopt-${(n += 1)}`,
    })
    const { jobId } = await engine.start({ ...START, ownerUserId: 'alice' })
    await engine.waitForTest(jobId)
    expect(engine.get(jobId)?.state).toBe('failed')
    const last = rig.updates.at(-1)
    expect(last?.state).toBe('failed')
    expect(last?.failure).toEqual({ reason: 'error', message: 'log sink down' })
  })

  it('a ledger that cannot be reached never fails the adoption', async () => {
    const rig = makeLedger({ failRegister: true })
    const engine = makeEngine(makeProvider(), rig.ledger)
    const { jobId } = await engine.start({ ...START, ownerUserId: 'alice' })
    await engine.waitForTest(jobId)
    expect(engine.get(jobId)?.state).toBe('done')
    expect(engine.get(jobId)?.adopted).toBe(3)
    expect(rig.updates).toHaveLength(0)
  })

  it('answers the job-source questions by the ledger id: snapshot, cancel, result', async () => {
    const rig = makeLedger()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: AdoptionJobProvider = {
      listCandidates: async () => ({ candidates: [] }),
      adopt: async (input) => {
        await gate
        return {
          adopted: [
            {
              childNativeId: input.childNativeIds[0] as string,
              parentDeviceId: 1,
              accessoryDeviceIds: [],
            },
          ],
        }
      },
    }
    const engine = makeEngine(slow, rig.ledger)
    const { jobId } = await engine.start({ ...START, ownerUserId: 'alice' })
    for (let i = 0; i < 20 && rig.registered.length === 0; i += 1) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))

    expect(engine.ledgerSnapshot('ledger-1')).toMatchObject({
      state: 'running',
      cancellable: true,
      progress: { done: 0, total: 3, unit: 'candidates' },
    })
    expect(engine.ledgerSnapshot('ledger-unknown')).toBeNull()
    expect(engine.ledgerResult('ledger-1')?.href).toContain('/integrations/provider-ha')
    expect(engine.ledgerResult('ledger-unknown')).toBeNull()
    expect(engine.cancelByLedgerId('ledger-unknown')).toBe(false)
    expect(engine.cancelByLedgerId('ledger-1')).toBe(true)
    release()
    await engine.waitForTest(jobId)
    expect(engine.ledgerSnapshot('ledger-1')?.state).toBe('cancelled')
    expect(rig.updates.at(-1)?.state).toBe('cancelled')
  })
})
