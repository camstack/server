/**
 * Unit tests for the background adoption job engine.
 *
 * The engine turns `device-adoption.adopt({childNativeIds: [...]})` — one
 * request, one 60s UDS deadline, all-or-nothing to the caller — into a job that
 * returns a `jobId` immediately and adopts ONE candidate per provider call.
 *
 * The fake provider here deliberately does NOT return instantly: `adopt` is
 * driven by a per-candidate deferred the test resolves by hand. A fake that
 * completed synchronously would make any scheduling look correct — this repo
 * has twice shipped a green suite because the fake supplied what production
 * forgot to fetch.
 */

import type { AdoptionCandidateResult, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { AdoptionJobProvider } from '../adoption-job-engine.js'
import { AdoptionJobEngine } from '../adoption-job-engine.js'

function makeLogger(): IScopedLogger {
  const l = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
  }
  return l as unknown as IScopedLogger
}

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
  reject(err: Error): void
}
function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A provider whose every `adopt` blocks until the test releases it. */
function makeProvider(opts?: { adopted?: ReadonlySet<string> }): {
  readonly provider: AdoptionJobProvider
  readonly gates: Map<string, Deferred>
  readonly calls: string[][]
} {
  const gates = new Map<string, Deferred>()
  const calls: string[][] = []
  let nextId = 100
  const provider: AdoptionJobProvider = {
    listCandidates: async () => ({
      candidates: [
        ...[...(opts?.adopted ?? [])].map((id) => ({ childNativeId: id, alreadyAdopted: true })),
      ],
      totalCount: opts?.adopted?.size ?? 0,
      page: 1,
      pageSize: 20000,
    }),
    adopt: async (input) => {
      calls.push([...input.childNativeIds])
      const id = input.childNativeIds[0] as string
      const gate = deferred()
      gates.set(id, gate)
      await gate.promise
      nextId += 1
      return {
        adopted: [{ childNativeId: id, parentDeviceId: nextId, accessoryDeviceIds: [nextId + 1] }],
      }
    },
  }
  return { provider, gates, calls }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}
/** Wait until `gates` has an entry for `id` (the engine reached that candidate). */
async function waitForGate(gates: Map<string, Deferred>, id: string): Promise<Deferred> {
  for (let i = 0; i < 200; i += 1) {
    const g = gates.get(id)
    if (g) return g
    await flush()
    await new Promise((r) => setTimeout(r, 0))
  }
  throw new Error(`engine never reached candidate ${id}`)
}

function makeEngine(provider: AdoptionJobProvider, logger = makeLogger()): AdoptionJobEngine {
  let n = 0
  return new AdoptionJobEngine({
    resolveProvider: async () => provider,
    logger,
    now: () => 1_000,
    newId: () => `job-${(n += 1)}`,
  })
}

describe('AdoptionJobEngine', () => {
  it('returns a jobId WITHOUT waiting for the adoption to finish', async () => {
    const { provider, gates } = makeProvider()
    const engine = makeEngine(provider)

    const { jobId } = await engine.start({
      addonId: 'provider-homeassistant',
      integrationId: 'int_0019',
      childNativeIds: ['a', 'b', 'c'],
    })

    expect(jobId).toBe('job-1')
    // Nothing has completed: the first provider call is still blocked.
    const job = engine.get(jobId)
    expect(job?.state).toBe('running')
    expect(job?.total).toBe(3)
    expect(job?.processed).toBe(0)
    await waitForGate(gates, 'a')
    expect(engine.get(jobId)?.currentChildNativeId).toBe('a')
  })

  it('adopts ONE candidate per provider call, never the whole array', async () => {
    const { provider, gates, calls } = makeProvider()
    const engine = makeEngine(provider)
    const { jobId } = await engine.start({
      addonId: 'x',
      integrationId: 'i',
      childNativeIds: ['a', 'b'],
    })

    ;(await waitForGate(gates, 'a')).resolve()
    ;(await waitForGate(gates, 'b')).resolve()
    await engine.waitForTest(jobId)

    // The whole point: the batch is decomposed. One array entry per call.
    expect(calls).toEqual([['a'], ['b']])
    expect(engine.get(jobId)?.state).toBe('done')
  })

  it('records a per-candidate result for EVERY candidate, including failures', async () => {
    const { provider, gates } = makeProvider()
    const engine = makeEngine(provider)
    const { jobId } = await engine.start({
      addonId: 'x',
      integrationId: 'i',
      childNativeIds: ['ok1', 'boom', 'ok2'],
    })

    ;(await waitForGate(gates, 'ok1')).resolve()
    ;(await waitForGate(gates, 'boom')).reject(new Error('provider exploded'))
    ;(await waitForGate(gates, 'ok2')).resolve()
    await engine.waitForTest(jobId)

    const job = engine.get(jobId)
    expect(job?.state).toBe('done')
    expect(job?.processed).toBe(3)
    expect(job?.adopted).toBe(2)
    expect(job?.failed).toBe(1)
    // A failure NEVER aborts the rest of the batch — 'ok2' still ran.
    const outcomes = (job?.results ?? []).map((r: AdoptionCandidateResult) => [
      r.childNativeId,
      r.outcome,
    ])
    expect(outcomes).toEqual([
      ['ok1', 'adopted'],
      ['boom', 'failed'],
      ['ok2', 'adopted'],
    ])
    expect(job?.results.find((r) => r.childNativeId === 'boom')?.error).toContain(
      'provider exploded',
    )
  })

  it('SKIPS an already-adopted candidate instead of failing on it (retry is safe)', async () => {
    // The operator's real retry: re-submit all 3 after a timeout landed 'a'.
    const { provider, gates, calls } = makeProvider({ adopted: new Set(['a']) })
    const engine = makeEngine(provider)
    const { jobId } = await engine.start({
      addonId: 'x',
      integrationId: 'i',
      childNativeIds: ['a', 'b'],
    })

    ;(await waitForGate(gates, 'b')).resolve()
    await engine.waitForTest(jobId)

    const job = engine.get(jobId)
    // 'a' was never sent to the provider — the cheap question came first.
    expect(calls).toEqual([['b']])
    expect(job?.alreadyAdopted).toBe(1)
    expect(job?.adopted).toBe(1)
    expect(job?.failed).toBe(0)
    expect(job?.state).toBe('done')
    expect(job?.results.find((r) => r.childNativeId === 'a')?.outcome).toBe('already-adopted')
  })

  it('cancel stops the loop and marks the untouched candidates cancelled', async () => {
    const { provider, gates, calls } = makeProvider()
    const engine = makeEngine(provider)
    const { jobId } = await engine.start({
      addonId: 'x',
      integrationId: 'i',
      childNativeIds: ['a', 'b', 'c'],
    })

    const gateA = await waitForGate(gates, 'a')
    expect(engine.cancel(jobId)).toBe(true)
    gateA.resolve()
    await engine.waitForTest(jobId)

    const job = engine.get(jobId)
    expect(job?.state).toBe('cancelled')
    // 'a' was in flight and completes; 'b' and 'c' are never dispatched.
    expect(calls).toEqual([['a']])
    expect(job?.results.map((r) => r.outcome)).toEqual(['adopted', 'cancelled', 'cancelled'])
  })

  it('logs every candidate outcome with the numeric deviceId tag', async () => {
    const logger = makeLogger()
    const { provider, gates } = makeProvider()
    const engine = makeEngine(provider, logger)
    const { jobId } = await engine.start({
      addonId: 'x',
      integrationId: 'i',
      childNativeIds: ['a'],
    })
    ;(await waitForGate(gates, 'a')).resolve()
    await engine.waitForTest(jobId)

    const infoCalls = (logger.info as unknown as ReturnType<typeof vi.fn>).mock.calls
    const landed = infoCalls.find(
      (c: readonly unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).includes('candidate adopted'),
    )
    expect(landed, 'a landed candidate must produce a log line').toBeDefined()
    // CLAUDE.md: every log line about a device carries tags.deviceId, numeric.
    const meta = landed?.[1] as { tags?: Record<string, unknown> } | undefined
    expect(typeof meta?.tags?.deviceId).toBe('number')
  })

  it('lists jobs newest-first and scopes them to the integration', async () => {
    const { provider, gates } = makeProvider()
    const engine = makeEngine(provider)
    const a = await engine.start({ addonId: 'x', integrationId: 'i1', childNativeIds: ['a'] })
    ;(await waitForGate(gates, 'a')).resolve()
    await engine.waitForTest(a.jobId)
    const b = await engine.start({ addonId: 'x', integrationId: 'i2', childNativeIds: ['b'] })
    ;(await waitForGate(gates, 'b')).resolve()
    await engine.waitForTest(b.jobId)

    expect(engine.list({ addonId: 'x' }).map((j) => j.jobId)).toEqual([b.jobId, a.jobId])
    expect(engine.list({ addonId: 'x', integrationId: 'i1' }).map((j) => j.jobId)).toEqual([
      a.jobId,
    ])
  })
})
