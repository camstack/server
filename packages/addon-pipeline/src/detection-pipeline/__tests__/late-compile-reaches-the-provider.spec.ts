/**
 * A late compile travels from the worker, through the pool and the factory, to
 * the provider's back-off (D653 rounds 2-3).
 *
 * Only the Python process is faked. The provider builds a REAL device pool
 * (`resolveDeviceFactory` → `EngineFactory` → `SharedInferencePool` →
 * `PoolWorker`), a real model manager loads through it, and the worker's
 * answers are written onto the fake child's stdout. A test that called
 * `noteLateCompile` directly stayed green with the factory's forward removed;
 * this one cannot.
 *
 * Pinned: a `compile-timeout` backs the model off; a SUCCESSFUL late compile
 * of that model makes it loadable at once; a FAILED late compile keeps it
 * backed off and says so.
 */
import { EventEmitter } from 'node:events'
import type { IScopedLogger, PipelineDefaultStep } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineFactory } from '../engine/engine-factory.js'

const spawned: FakeChild[] = []

class FakeChild extends EventEmitter {
  readonly stdin = { write: vi.fn((_chunk: Buffer) => true), end: vi.fn() }
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly pid = 5151
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kill = vi.fn((signal: NodeJS.Signals) => {
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  })
}

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    spawn: () => {
      const c = new FakeChild()
      spawned.push(c)
      return c
    },
  }
})

interface LoggedLine {
  readonly level: string
  readonly message: string
  readonly meta: Record<string, unknown>
}

function captureLogger(sink: LoggedLine[]): IScopedLogger {
  const record =
    (level: string) =>
    (message: string, opts?: { meta?: Record<string, unknown> }): void => {
      sink.push({ level, message, meta: opts?.meta ?? {} })
    }
  const logger: IScopedLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function reply(child: FakeChild, reqId: number, payload: Record<string, unknown>): void {
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  const frame = Buffer.allocUnsafe(8 + json.length)
  frame.writeUInt32LE(4 + json.length, 0)
  frame.writeUInt32LE(reqId, 4)
  json.copy(frame, 8)
  child.stdout.emit('data', frame)
}

/** The `load` commands the host has written, in order. */
function loads(child: FakeChild): { reqId: number; path: string }[] {
  const chunks = child.stdin.write.mock.calls.map((c) => c[0])
  const out: { reqId: number; path: string }[] = []
  for (let i = 0; i + 1 < chunks.length; i += 2) {
    const header = chunks[i]!
    if (header[8] !== 0x00 || header.readUInt32LE(4) === 0) continue
    const cmd = JSON.parse(chunks[i + 1]!.toString('utf8')) as {
      cmd: string
      config?: { path: string }
    }
    if (cmd.cmd === 'load') out.push({ reqId: header.readUInt32LE(4), path: cmd.config!.path })
  }
  return out
}

function stemOf(path: string): string {
  const base = path.split('/').at(-1) ?? path
  return base.replace(/\.[^.]+$/, '')
}

const FACE: PipelineDefaultStep = {
  addonId: 'face-detection',
  addonName: 'Face Detection',
  slot: 'cropper',
  inputClasses: ['person'],
  outputClasses: ['face'],
  enabled: true,
  modelId: 'yunet-2023mar',
  children: [],
}

interface Rig {
  readonly provider: import('../provider.js').DetectionPipelineProvider
  readonly factory: EngineFactory
  readonly child: FakeChild
  readonly lines: LoggedLine[]
  dispatch(): Promise<void>
}

async function makeRig(): Promise<Rig> {
  const { DetectionPipelineProvider } = await import('../provider.js')
  const lines: LoggedLine[] = []
  const provider = new DetectionPipelineProvider(
    { readAddonStore: async () => ({}), writeAddonStore: async () => undefined },
    '/tmp/camstack-test-models',
    captureLogger(lines),
    null,
    null,
    { pythonPath: '/usr/bin/python3' },
  )
  // Nothing to download: this is about the LOAD, not the artifact.
  provider['resolveModelEntry'] = async () => undefined
  const building = provider['resolveDeviceFactory']('openvino:gpu')
  await vi.waitFor(() => expect(spawned).toHaveLength(1))
  const child = spawned[0]!
  reply(child, 0, { status: 'ready', models: 0, protocolVersion: 2 })
  const factory = await building
  return {
    provider,
    factory,
    child,
    lines,
    dispatch: () =>
      provider['ensureModelsForSteps']([FACE], factory, 'openvino', {
        deviceId: 101,
        deviceKey: 'openvino:gpu',
      }),
  }
}

/** Fail the first load with the worker's own `compile-timeout`; returns the model's stem. */
async function failWithCompileTimeout(rig: Rig): Promise<string> {
  const first = rig.dispatch()
  await vi.waitFor(() => expect(loads(rig.child)).toHaveLength(1))
  const load = loads(rig.child)[0]!
  const stem = stemOf(load.path)
  reply(rig.child, load.reqId, {
    cmd: 'load',
    index: 0,
    status: 'error',
    reason: 'compile-timeout',
    modelId: stem,
    compileElapsedMs: 120_000,
    error: `load of ${stem} did not return within 120000ms`,
  })
  await expect(first).rejects.toThrow(/compile-timeout/)
  return stem
}

beforeEach(() => {
  spawned.length = 0
  vi.resetModules()
})

afterEach(async () => {
  vi.useRealTimers()
})

describe('a late compile reaches the provider through the factory (D1)', () => {
  it('a SUCCESSFUL late compile makes that model loadable at once', async () => {
    const rig = await makeRig()
    const stem = await failWithCompileTimeout(rig)

    // Backed off: an immediate retry issues nothing.
    await expect(rig.dispatch()).rejects.toThrow(/not retried/)
    expect(loads(rig.child)).toHaveLength(1)

    reply(rig.child, 0xffffffff, {
      event: 'compile-finished-late',
      index: 0,
      modelId: stem,
      ok: true,
      elapsedMs: 130_000,
    })
    const retry = rig.dispatch()
    await vi.waitFor(() => expect(loads(rig.child)).toHaveLength(2))
    reply(rig.child, loads(rig.child)[1]!.reqId, { cmd: 'load', index: 0, status: 'ok', loadMs: 4 })
    await expect(retry).resolves.toBeUndefined()
    expect(
      rig.lines.find((l) => l.message === 'model loadable again after late compile'),
    ).toBeDefined()
    await rig.factory.dispose()
  })

  it('a FAILED late compile keeps the model backed off, and says so', async () => {
    const rig = await makeRig()
    const stem = await failWithCompileTimeout(rig)
    reply(rig.child, 0xffffffff, {
      event: 'compile-finished-late',
      index: 0,
      modelId: stem,
      ok: false,
      error: 'CL_OUT_OF_RESOURCES',
      elapsedMs: 130_000,
    })
    await expect(rig.dispatch()).rejects.toThrow(/not retried/)
    expect(loads(rig.child)).toHaveLength(1)
    const line = rig.lines.find((l) => l.message.startsWith('late compile failed'))
    expect(line?.meta['error']).toBe('CL_OUT_OF_RESOURCES')
    await rig.factory.dispose()
  })
})
