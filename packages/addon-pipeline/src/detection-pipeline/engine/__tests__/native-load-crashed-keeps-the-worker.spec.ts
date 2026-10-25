import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

/**
 * A model the native compiler crashes on is REFUSED by name; the worker lives
 * (D910, mirrors D742 for Core ML).
 *
 * 2026-10-22, hub `openvino:gpu`: the iGPU compiler SIGSEGVed the pool worker
 * three times in 15 s. The pool now compiles a cold GPU/NPU model in a child
 * first (`openvino_compile_probe.py`); a child killed by a signal makes the
 * worker answer the load with `reason: "native-load-crashed"` and keep serving.
 * The host must carry that reason to the caller as a typed refusal, and must
 * not treat it as a poisoned or dead worker.
 */

const spawned: FakeChild[] = []

class FakeChild extends EventEmitter {
  readonly stdin = { write: vi.fn((_chunk: Buffer) => true), end: vi.fn() }
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kill = vi.fn((signal: NodeJS.Signals) => {
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  })
}

vi.mock('node:child_process', () => ({
  spawn: () => {
    const c = new FakeChild()
    spawned.push(c)
    return c
  },
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: () => true }
})

interface WrittenFrame {
  readonly reqId: number
  readonly msgType: number
  readonly body: Buffer
}

/** Every frame the host wrote, as (header, payload) pairs. */
function written(child: FakeChild): WrittenFrame[] {
  const chunks = child.stdin.write.mock.calls.map((c) => c[0])
  const out: WrittenFrame[] = []
  for (let i = 0; i + 1 < chunks.length; i += 2) {
    const header = chunks[i]!
    out.push({ reqId: header.readUInt32LE(4), msgType: header[8]!, body: chunks[i + 1]! })
  }
  return out
}

function commands(child: FakeChild): { reqId: number; cmd: Record<string, unknown> }[] {
  return written(child)
    .filter((f) => f.msgType === 0x00 && f.reqId !== 0)
    .map((f) => ({ reqId: f.reqId, cmd: JSON.parse(f.body.toString('utf8')) }))
}

function reply(child: FakeChild, reqId: number, payload: Record<string, unknown>): void {
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  const frame = Buffer.allocUnsafe(8 + json.length)
  frame.writeUInt32LE(4 + json.length, 0)
  frame.writeUInt32LE(reqId, 4)
  json.copy(frame, 8)
  child.stdout.emit('data', frame)
}

/** Every pool a test built — disposed after it. */
const pools: import('../shared-inference-pool.js').SharedInferencePool[] = []

const MODEL = {
  path: '/data/models/openvino/camstack-yolov9m-320-int8.xml',
  inputSize: 320,
  preprocessMode: 'letterbox',
  postprocessor: 'yolo',
  confidence: 0.5,
} as const

beforeEach(() => {
  spawned.length = 0
  vi.resetModules()
})

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.dispose()))
  for (const child of spawned) {
    child.removeAllListeners()
    child.stdout.removeAllListeners()
    child.stderr.removeAllListeners()
  }
  spawned.length = 0
  vi.clearAllMocks()
})

describe('a native-load-crashed answer refuses the model and keeps the worker', () => {
  it('rejects the load with the typed reason and the model, and does not recycle the worker', async () => {
    const mod = await import('../shared-inference-pool.js')
    const errors: string[] = []
    const log = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: (message: string) => void errors.push(message),
      child: () => log,
    }
    const pool = new mod.SharedInferencePool('/usr/bin/python3', 'openvino', log as never, {
      numWorkers: 1,
      device: 'gpu',
    })
    pools.push(pool)
    const init = pool.initialize([])
    const child = spawned[0]!
    reply(child, 0, { status: 'ready', models: 0, protocolVersion: 2 })
    await init

    const load = pool.loadModel(3, MODEL as never)
    const reqId = commands(child).find((c) => c.cmd['cmd'] === 'load')!.reqId
    reply(child, reqId, {
      cmd: 'load',
      index: 3,
      status: 'error',
      reason: 'native-load-crashed',
      modelId: 'camstack-yolov9m-320-int8',
      error:
        'OpenVINO model camstack-yolov9m-320-int8.xml crashes the native compiler on device=gpu',
    })
    await expect(load).rejects.toMatchObject({
      reason: 'native-load-crashed',
      model: 'camstack-yolov9m-320-int8',
    })

    expect(child.kill).not.toHaveBeenCalled()
    expect(errors.filter((m) => m.startsWith('pool worker POISONED'))).toEqual([])
    // The worker takes the next load: nothing was recycled.
    void pool.loadModel(4, MODEL as never).catch(() => undefined)
    expect(commands(child).filter((c) => c.cmd['cmd'] === 'load')).toHaveLength(2)
  })
})
