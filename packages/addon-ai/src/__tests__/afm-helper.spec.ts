import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AFM_MAX_CONSECUTIVE_TIMEOUTS, AppleFmHelper } from '../runtime/apple/afm-helper.js'
import { fakeSpawner, flush } from './support/fake-afm-process.js'
import { createTestLogger, makeTestLogger } from './support/logger.js'

const BINARY = '/addon/native/afm/camstack-afm'

function helperWith(
  spawner: ReturnType<typeof fakeSpawner>,
  overrides: Partial<ConstructorParameters<typeof AppleFmHelper>[0]> = {},
): AppleFmHelper {
  return new AppleFmHelper({
    binaryPath: BINARY,
    spawn: spawner.spawn,
    exists: () => true,
    logger: makeTestLogger(),
    ...overrides,
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AppleFmHelper', () => {
  it('spawns lazily, writes one line per request and matches the reply by id', async () => {
    const spawner = fakeSpawner((proc) => {
      proc.onRequest = (req, p) => p.reply({ id: req.id, ok: true, text: 'ciao' })
    })
    const helper = helperWith(spawner)
    expect(spawner.processes).toHaveLength(0)

    const outcome = await helper.request({ op: 'generate', prompt: 'x' }, { timeoutMs: 1000 })

    expect(spawner.processes).toHaveLength(1)
    expect(spawner.processes[0]?.written[0]).toMatchObject({ op: 'generate', prompt: 'x' })
    expect(outcome).toEqual({
      kind: 'reply',
      reply: { id: spawner.processes[0]?.written[0]?.id, ok: true, text: 'ciao' },
    })
  })

  it('a missing binary is helperMissing and never spawns', async () => {
    const spawner = fakeSpawner()
    const helper = helperWith(spawner, { exists: () => false })
    const outcome = await helper.request({ op: 'probe' }, { timeoutMs: 1000 })
    expect(outcome).toMatchObject({ kind: 'unavailable', reason: 'helperMissing' })
    expect(spawner.processes).toHaveLength(0)
  })

  it('a timeout resolves `timeout` AND tells the helper to stop that generation', async () => {
    vi.useFakeTimers()
    const spawner = fakeSpawner()
    const helper = helperWith(spawner)
    const pending = helper.request({ op: 'generate', prompt: 'x' }, { timeoutMs: 500 })
    await vi.advanceTimersByTimeAsync(501)
    expect(await pending).toEqual({ kind: 'timeout' })
    const [generate, cancel] = spawner.processes[0]?.written ?? []
    expect(cancel).toMatchObject({ op: 'cancel', target: generate?.id })
  })

  it('an abort resolves `cancelled` at once and forwards a cancel for the same id', async () => {
    const spawner = fakeSpawner()
    const helper = helperWith(spawner)
    const controller = new AbortController()
    const pending = helper.request(
      { op: 'generate', prompt: 'x' },
      { timeoutMs: 60_000, signal: controller.signal },
    )
    controller.abort()
    expect(await pending).toEqual({ kind: 'cancelled' })
    const [generate, cancel] = spawner.processes[0]?.written ?? []
    expect(cancel).toMatchObject({ op: 'cancel', target: generate?.id })
  })

  it('an already-aborted signal never reaches the helper', async () => {
    const spawner = fakeSpawner()
    const helper = helperWith(spawner)
    const controller = new AbortController()
    controller.abort()
    const outcome = await helper.request(
      { op: 'generate', prompt: 'x' },
      { timeoutMs: 1000, signal: controller.signal },
    )
    expect(outcome).toEqual({ kind: 'cancelled' })
    expect(spawner.processes).toHaveLength(0)
  })

  it('a crash answers every pending request `crashed`, logs it, and the next request respawns', async () => {
    const spawner = fakeSpawner()
    const { logger, entries } = createTestLogger()
    const helper = helperWith(spawner, {
      logger,
      crashPolicy: { windowMs: 60_000, maxCrashes: 5, maxBackoffMs: 0 },
    })
    const a = helper.request({ op: 'generate', prompt: 'a' }, { timeoutMs: 60_000 })
    const b = helper.request({ op: 'probe' }, { timeoutMs: 60_000 })
    spawner.processes[0]?.exit(1)
    expect(await a).toMatchObject({ kind: 'crashed' })
    expect(await b).toMatchObject({ kind: 'crashed' })
    expect(entries.some((e) => e.level === 'warn' && e.message.includes('exited'))).toBe(true)

    spawner.processes.length = 0
    const next = helper.request({ op: 'probe' }, { timeoutMs: 60_000 })
    expect(spawner.processes).toHaveLength(1)
    spawner.processes[0]?.exit(0)
    await next
  })

  it('crashes past the bound mark the helper terminally failed — no infinite respawn (D6)', async () => {
    const spawner = fakeSpawner()
    const helper = helperWith(spawner, {
      crashPolicy: { windowMs: 60_000, maxCrashes: 2, maxBackoffMs: 0 },
    })
    for (let i = 0; i < 2; i++) {
      const p = helper.request({ op: 'probe' }, { timeoutMs: 60_000 })
      spawner.processes.at(-1)?.exit(1)
      await p
    }
    const spawned = spawner.processes.length
    const outcome = await helper.request({ op: 'probe' }, { timeoutMs: 60_000 })
    expect(outcome).toMatchObject({ kind: 'unavailable', reason: 'helperCrashed' })
    expect(spawner.processes).toHaveLength(spawned)
    expect(helper.state()).toBe('failed')
  })

  it('inside the respawn backoff a request is refused, not queued', async () => {
    vi.useFakeTimers()
    const spawner = fakeSpawner()
    const helper = helperWith(spawner, {
      crashPolicy: { windowMs: 60_000, maxCrashes: 5, maxBackoffMs: 10_000 },
    })
    const p = helper.request({ op: 'probe' }, { timeoutMs: 60_000 })
    spawner.processes[0]?.exit(1)
    await p
    const refused = await helper.request({ op: 'probe' }, { timeoutMs: 60_000 })
    // Restarting is transient — never reported as a known absence.
    expect(refused).toMatchObject({ kind: 'crashed' })
    expect(spawner.processes).toHaveLength(1)
  })

  it('bounds concurrent generations and says `busy` beyond the bound', async () => {
    const spawner = fakeSpawner()
    const helper = helperWith(spawner, { maxInFlight: 1 })
    const first = helper.request(
      { op: 'generate', prompt: 'a' },
      { timeoutMs: 60_000, counted: true },
    )
    const second = await helper.request(
      { op: 'generate', prompt: 'b' },
      { timeoutMs: 60_000, counted: true },
    )
    expect(second).toEqual({ kind: 'busy' })
    const proc = spawner.processes[0]
    proc?.reply({ id: proc.written[0]?.id, ok: true })
    await first
    // The slot is free again once the first answered.
    const third = helper.request(
      { op: 'generate', prompt: 'c' },
      { timeoutMs: 60_000, counted: true },
    )
    await flush()
    proc?.reply({ id: proc.written.at(-1)?.id, ok: true })
    expect(await third).toMatchObject({ kind: 'reply' })
  })

  it('a line that is not JSON is logged and dropped, and the helper keeps serving', async () => {
    const spawner = fakeSpawner()
    const { logger, entries } = createTestLogger()
    const helper = helperWith(spawner, { logger })
    const pending = helper.request({ op: 'probe' }, { timeoutMs: 60_000 })
    const proc = spawner.processes[0]
    proc?.writeRaw('not json\n')
    await flush()
    expect(entries.some((e) => e.level === 'warn' && e.message.includes('unparseable'))).toBe(true)
    proc?.reply({ id: proc.written[0]?.id, ok: true })
    expect(await pending).toMatchObject({ kind: 'reply' })
  })

  it('dispose kills the child and is not counted as a crash', async () => {
    const spawner = fakeSpawner()
    const helper = helperWith(spawner)
    const pending = helper.request({ op: 'probe' }, { timeoutMs: 60_000 })
    helper.dispose()
    expect(spawner.processes[0]?.killed).toBe(true)
    expect(await pending).toMatchObject({ kind: 'crashed' })
    expect(helper.state()).toBe('idle')
  })

  it('a write that throws is handled as an exit, never a throw out of request()', async () => {
    const spawner = fakeSpawner((proc) => {
      proc.write = () => {
        throw new Error('EPIPE')
      }
    })
    const helper = helperWith(spawner, {
      crashPolicy: { windowMs: 60_000, maxCrashes: 5, maxBackoffMs: 0 },
    })
    expect(await helper.request({ op: 'probe' }, { timeoutMs: 60_000 })).toMatchObject({
      kind: 'crashed',
    })
    expect(helper.state()).toBe('idle')
  })

  it('a probe timeout means wedged: the helper is killed and that counts as a crash', async () => {
    vi.useFakeTimers()
    const spawner = fakeSpawner()
    const helper = helperWith(spawner, {
      crashPolicy: { windowMs: 60_000, maxCrashes: 1, maxBackoffMs: 0 },
    })
    const pending = helper.request({ op: 'probe' }, { timeoutMs: 500 })
    await vi.advanceTimersByTimeAsync(501)
    expect(await pending).toEqual({ kind: 'timeout' })
    expect(spawner.processes[0]?.killed).toBe(true)
    // maxCrashes 1: the kill alone trips the bound.
    expect(helper.state()).toBe('failed')
  })

  it(`${String(AFM_MAX_CONSECUTIVE_TIMEOUTS)} generation timeouts in a row kill it; a reply in between resets the count`, async () => {
    vi.useFakeTimers()
    const spawner = fakeSpawner()
    const helper = helperWith(spawner, {
      crashPolicy: { windowMs: 60_000, maxCrashes: 5, maxBackoffMs: 0 },
    })
    const timeOut = async (): Promise<void> => {
      const p = helper.request({ op: 'generate', prompt: 'x' }, { timeoutMs: 100, counted: true })
      await vi.advanceTimersByTimeAsync(101)
      await p
    }
    for (let i = 0; i < AFM_MAX_CONSECUTIVE_TIMEOUTS - 1; i++) await timeOut()
    const proc = spawner.processes[0]
    const answered = helper.request({ op: 'generate', prompt: 'y' }, { timeoutMs: 10_000 })
    const last = proc?.written.filter((r) => r.op === 'generate').at(-1)
    proc?.reply({ id: last?.id, ok: true })
    await vi.advanceTimersByTimeAsync(1)
    await answered
    await timeOut()
    expect(proc?.killed).toBe(false)
    for (let i = 0; i < AFM_MAX_CONSECUTIVE_TIMEOUTS - 1; i++) await timeOut()
    expect(proc?.killed).toBe(true)
  })
})

describe('AppleFmHelper — slow is not wedged (N2), a failed write kills (N3)', () => {
  it('caller timeouts answered LATE by a live helper never kill it', async () => {
    vi.useFakeTimers()
    const spawner = fakeSpawner()
    const helper = helperWith(spawner)
    const proc = () => spawner.processes[0]
    for (let i = 0; i < AFM_MAX_CONSECUTIVE_TIMEOUTS + 2; i++) {
      const p = helper.request({ op: 'generate', prompt: 'x' }, { timeoutMs: 100, counted: true })
      await vi.advanceTimersByTimeAsync(101)
      expect(await p).toEqual({ kind: 'timeout' })
      // The model finishes after the caller's short budget: late, but alive.
      const late = proc()
        ?.written.filter((r) => r.op === 'generate')
        .at(-1)
      proc()?.reply({ id: late?.id, ok: true })
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(proc()?.killed).toBe(false)
    expect(helper.state()).toBe('running')
  })

  it('a helper that acks every cancel but never answers a generation IS wedged', async () => {
    vi.useFakeTimers()
    const spawner = fakeSpawner((proc) => {
      // The reader thread is alive and acks at once; the model path is stuck.
      proc.onRequest = (req, p) => {
        if (req.op === 'cancel') p.reply({ id: req.id, ok: true, found: true })
      }
    })
    const helper = helperWith(spawner, {
      crashPolicy: { windowMs: 60_000, maxCrashes: 5, maxBackoffMs: 0 },
    })
    for (let i = 0; i < AFM_MAX_CONSECUTIVE_TIMEOUTS; i++) {
      const p = helper.request({ op: 'generate', prompt: 'x' }, { timeoutMs: 100, counted: true })
      await vi.advanceTimersByTimeAsync(101)
      await p
    }
    expect(spawner.processes[0]?.killed).toBe(true)
  })

  it('a write that fails kills the child rather than leaving it unowned', async () => {
    const spawner = fakeSpawner((proc) => {
      proc.write = () => {
        throw new Error('EPIPE')
      }
    })
    const helper = helperWith(spawner)
    await helper.request({ op: 'probe' }, { timeoutMs: 1_000 })
    expect(spawner.processes[0]?.killed).toBe(true)
  })
})

describe('AppleFmHelper against a real child whose stdin is closed', () => {
  it('an EPIPE on stdin is a crash of the helper, never an uncaught error in this process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-epipe-'))
    const script = path.join(dir, 'closes-stdin.sh')
    fs.writeFileSync(script, '#!/bin/sh\nexec 0<&-\nsleep 2\n', { mode: 0o755 })
    const helper = new AppleFmHelper({
      binaryPath: script,
      logger: makeTestLogger(),
      crashPolicy: { windowMs: 60_000, maxCrashes: 5, maxBackoffMs: 0 },
    })
    try {
      const first = helper.request({ op: 'probe' }, { timeoutMs: 5_000 })
      // Let the child close its stdin, then write into the dead pipe.
      await new Promise<void>((resolve) => setTimeout(resolve, 300))
      const second = helper.request({ op: 'probe' }, { timeoutMs: 5_000 })
      expect(await first).toMatchObject({ kind: 'crashed' })
      expect(await second).toMatchObject({ kind: 'crashed' })
    } finally {
      helper.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
    // A real child that lives 2 s, plus two requests bounded at 5 s each: the
    // default 5 s test bound is shorter than the case under a loaded full run.
  }, 15_000)
})
