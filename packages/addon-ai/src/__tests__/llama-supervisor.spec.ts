import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildLlamaArgs,
  type LlamaStartConfig,
  LlamaSupervisor,
} from '../runtime/llama-supervisor.js'
import { makeTestLogger } from './support/logger.js'

class FakeChild extends EventEmitter {
  readonly pid = 4242
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: string[] = []
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal))
    return true
  }
}

function config(overrides: Partial<LlamaStartConfig> = {}): LlamaStartConfig {
  return {
    nodeId: 'hub',
    modelId: 'qwen',
    modelPath: '/models/qwen.gguf',
    contextSize: 4096,
    gpuLayers: 0,
    parallel: 1,
    idleStopMinutes: 0,
    binaryPath: '/bin/llama-server',
    ...overrides,
  }
}

interface Harness {
  sup: LlamaSupervisor
  children: FakeChild[]
  spawnArgs: string[][]
  setHealth: (status: number) => void
}

function harness(
  opts: {
    health?: number
    startTimeoutMs?: number
    healthPollMs?: number
    killGraceMs?: number
  } = {},
): Harness {
  const children: FakeChild[] = []
  const spawnArgs: string[][] = []
  let health = opts.health ?? 200
  const spawnFn = ((_cmd: string, args: readonly string[]) => {
    spawnArgs.push([...args])
    const child = new FakeChild()
    children.push(child)
    return child
  }) as unknown as typeof import('node:child_process').spawn
  const fetchFn = (async () => ({ status: health })) as unknown as typeof fetch
  const sup = new LlamaSupervisor({
    logger: makeTestLogger(),
    spawnFn,
    fetchFn,
    pickPort: async () => 18080,
    startTimeoutMs: opts.startTimeoutMs ?? 120_000,
    healthPollMs: opts.healthPollMs ?? 15_000,
    killGraceMs: opts.killGraceMs ?? 5_000,
  })
  return { sup, children, spawnArgs, setHealth: (s) => (health = s) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('LlamaSupervisor.start', () => {
  it('spawns with the exact flag set and reaches ready when /health returns 200', async () => {
    const h = harness({ health: 200 })
    await h.sup.start(config())
    expect(h.spawnArgs[0]).toEqual([
      '-m',
      '/models/qwen.gguf',
      '--host',
      '127.0.0.1',
      '--port',
      '18080',
      '-c',
      '4096',
      '-ngl',
      '0',
      '--parallel',
      '1',
    ])
    await vi.advanceTimersByTimeAsync(600)
    expect(h.sup.status().state).toBe('ready')
    expect(h.sup.port).toBe(18080)
  })

  it('adds -t only with threads and --mmproj only with a projector', async () => {
    const h = harness()
    await h.sup.start(config({ threads: 6, mmprojPath: '/models/mmproj.gguf' }))
    const args = h.spawnArgs[0]!
    expect(args).toContain('-t')
    expect(args[args.indexOf('-t') + 1]).toBe('6')
    expect(args).toContain('--mmproj')
    expect(args[args.indexOf('--mmproj') + 1]).toBe('/models/mmproj.gguf')
  })

  it('attaches a no-op error listener at spawn (the wrapChild lesson)', async () => {
    const h = harness()
    await h.sup.start(config())
    expect(h.children[0]!.listenerCount('error')).toBeGreaterThan(0)
  })

  it('health never 200 within the start deadline → crashed', async () => {
    const h = harness({ health: 500, startTimeoutMs: 2_000 })
    await h.sup.start(config())
    await vi.advanceTimersByTimeAsync(2_500)
    expect(h.sup.status().state).toBe('crashed')
    expect(h.sup.status().lastError).toBeDefined()
    expect(h.children[0]!.signals).toContain('SIGKILL')
  })
})

describe('LlamaSupervisor crash policy', () => {
  it('unexpected exit while ready schedules a respawn after backoff', async () => {
    const h = harness({ health: 200 })
    await h.sup.start(config())
    await vi.advanceTimersByTimeAsync(600)
    expect(h.sup.status().state).toBe('ready')
    h.children[0]!.emit('exit', 1, null)
    expect(h.sup.status().state).toBe('crashed')
    await vi.advanceTimersByTimeAsync(600) // backoff 500ms for streak 1
    expect(h.spawnArgs.length).toBe(2)
  })

  it('breaker trips to failed after 5 crashes in the window — no further spawn', async () => {
    const h = harness({ health: 200 })
    await h.sup.start(config())
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(600) // reach ready
      const child = h.children.at(-1)!
      child.emit('exit', 1, null)
      await vi.advanceTimersByTimeAsync(5_000) // cover the growing backoff (≤4s)
    }
    expect(h.sup.status().state).toBe('failed')
    expect(h.spawnArgs.length).toBe(5)
  })
})

describe('LlamaSupervisor.stop', () => {
  it('SIGTERM then SIGKILL after the grace deadline, state stopped, no respawn', async () => {
    const h = harness({ health: 200, killGraceMs: 5_000 })
    await h.sup.start(config())
    await vi.advanceTimersByTimeAsync(600)
    const child = h.children[0]!
    const stopping = h.sup.stop()
    await vi.advanceTimersByTimeAsync(5_100)
    await stopping
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(h.sup.status().state).toBe('stopped')
    expect(h.spawnArgs.length).toBe(1)
  })
})

describe('LlamaSupervisor idle-stop', () => {
  it('idleStopMinutes 1 → auto-stops after 61s of no activity', async () => {
    const h = harness({ health: 200, killGraceMs: 1_000 })
    await h.sup.start(config({ idleStopMinutes: 1 }))
    await vi.advanceTimersByTimeAsync(600)
    expect(h.sup.status().state).toBe('ready')
    // idle check fires at 60s; stop() then escalates within the 1s grace.
    await vi.advanceTimersByTimeAsync(63_000)
    expect(h.sup.status().state).toBe('stopped')
  })

  it('idleStopMinutes 0 → never auto-stops', async () => {
    const h = harness({ health: 200 })
    await h.sup.start(config({ idleStopMinutes: 0 }))
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(h.sup.status().state).toBe('ready')
  })
})

describe('buildLlamaArgs — the whole tuning surface reaches the command line', () => {
  const base = {
    nodeId: 'hub',
    modelId: 'm',
    modelPath: '/models/m.gguf',
    contextSize: 8192,
    gpuLayers: 33,
    parallel: 2,
    idleStopMinutes: 30,
    binaryPath: '/bin/llama-server',
  }

  it('emits every configured flag, and omits the ones left unset', () => {
    const args = buildLlamaArgs(
      {
        ...base,
        threads: 6,
        batchSize: 512,
        ubatchSize: 128,
        flashAttention: true,
        mlock: true,
        noMmap: true,
        cacheTypeK: 'q8_0',
        cacheTypeV: 'q4_0',
        mmprojPath: '/models/mmproj.gguf',
      },
      18080,
    )
    const joined = args.join(' ')
    // A knob the operator can set that never reaches argv is a knob that does
    // nothing — this suite is what makes that impossible to ship.
    expect(joined).toContain('-c 8192')
    expect(joined).toContain('-ngl 33')
    expect(joined).toContain('--parallel 2')
    expect(joined).toContain('-t 6')
    expect(joined).toContain('-b 512')
    expect(joined).toContain('-ub 128')
    expect(joined).toContain('--flash-attn')
    expect(joined).toContain('--mlock')
    expect(joined).toContain('--no-mmap')
    expect(joined).toContain('--cache-type-k q8_0')
    expect(joined).toContain('--cache-type-v q4_0')
    expect(joined).toContain('--mmproj /models/mmproj.gguf')
  })

  it('a bare config carries no optional flag at all', () => {
    const joined = buildLlamaArgs(base, 18080).join(' ')
    for (const flag of [
      '-t ',
      '-b ',
      '-ub ',
      '--flash-attn',
      '--mlock',
      '--no-mmap',
      '--cache-type',
    ]) {
      expect(joined).not.toContain(flag)
    }
  })

  it('never binds wider than loopback — a managed model is node-local', () => {
    // Binding wider would publish an unauthenticated inference endpoint on the LAN.
    expect(buildLlamaArgs(base, 18080).join(' ')).toContain('--host 127.0.0.1')
  })
})
