import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockFirstCall } from '../../../__tests__/support/vitest-mock.js'

/**
 * Framing test for PythonTextEncoderEngine: it must emit a UTF-8 length-prefixed
 * request frame and decode the float32 tensor response frame — without spawning a
 * real Python. We mock `node:child_process.spawn` with a fake process whose stdin
 * we inspect and whose stdout we drive with hand-built frames.
 */

interface FakeChild extends EventEmitter {
  readonly stdin: PassThrough
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  kill: (signal?: string) => boolean
}

const spawnMock = vi.fn<(...args: readonly unknown[]) => FakeChild>()

vi.mock('node:child_process', () => ({
  spawn: (...args: readonly unknown[]): FakeChild => spawnMock(...args),
}))

const { PythonTextEncoderEngine } = await import('../python-text-encoder-engine.js')
const { ClipTextEngines } = await import('../../addon/clip-text-engines.js')
const { CrashBudget } = await import('../../addon/crash-budget.js')
const { RequirementsGate } = await import('../../addon/model-requirements.js')
const { BUILTIN_CLIP_MODELS } = await import('../../../shared/clip/clip-model-registry.js')
const { CLIP_TEXT_MODELS } = await import('../../catalogs/embedding-models.js')

function makeChild(): FakeChild {
  const emitter = new EventEmitter() as FakeChild
  const child = Object.assign(emitter, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
  return child
}

/** Build a length-prefixed frame: [4B LE len][payload]. */
function frame(payload: Buffer): Buffer {
  const len = Buffer.allocUnsafe(4)
  len.writeUInt32LE(payload.length, 0)
  return Buffer.concat([len, payload])
}

/** Encode a 1-D float32 tensor payload: [1B ndims][dims×4B][float32 data]. */
function tensorPayload(values: readonly number[]): Buffer {
  const head = Buffer.allocUnsafe(1 + 4)
  head.writeUInt8(1, 0)
  head.writeUInt32LE(values.length, 1)
  const data = Buffer.allocUnsafe(values.length * 4)
  values.forEach((v, i) => data.writeFloatLE(v, i * 4))
  return Buffer.concat([head, data])
}

/** Read a single length-prefixed frame's payload from a written buffer. */
function readFramePayload(buf: Buffer): Buffer {
  const len = buf.readUInt32LE(0)
  return buf.subarray(4, 4 + len)
}

afterEach(() => {
  spawnMock.mockReset()
})

describe('PythonTextEncoderEngine framing', () => {
  it('spawns with model + tokenizer args and decodes a tensor response', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)

    const engine = new PythonTextEncoderEngine(
      '/usr/bin/python',
      '/scripts/text_encoder_inference.py',
      '/models/text.onnx',
      '/models/tokenizer.json',
      { contextLength: 64, padId: 0 },
    )

    const init = engine.initialize()
    // Emit the ready frame (0x01).
    child.stdout.write(frame(Buffer.from([0x01])))
    await init

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const args = mockFirstCall(spawnMock)
    expect(args[0]).toBe('/usr/bin/python')
    // The MODEL's window rides on the argv (D649) — a SigLIP2 tower has 64
    // positions, and the script's default is CLIP's 77.
    expect(args[1]).toEqual([
      '/scripts/text_encoder_inference.py',
      '/models/text.onnx',
      '/models/tokenizer.json',
      '--context-length',
      '64',
      '--pad-id',
      '0',
    ])

    // Capture what the engine writes to stdin when we call encode().
    const writes: Buffer[] = []
    child.stdin.on('data', (chunk: Buffer) => writes.push(chunk))

    const encodePromise = engine.encode('a photo of a cat')
    // Respond with a 3-value float tensor.
    child.stdout.write(frame(tensorPayload([0.5, -0.25, 1])))

    const result = await encodePromise
    expect(Array.from(result)).toEqual([0.5, -0.25, 1])

    // The request frame must carry the UTF-8 text bytes.
    const sent = Buffer.concat(writes)
    expect(readFramePayload(sent).toString('utf-8')).toBe('a photo of a cat')
  })

  it('rejects an unexpected ready frame', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)

    const engine = new PythonTextEncoderEngine(
      '/usr/bin/python',
      '/scripts/text_encoder_inference.py',
      '/models/text.onnx',
      '/models/tokenizer.json',
      { contextLength: 64, padId: 0 },
    )
    const init = engine.initialize()
    child.stdout.write(frame(Buffer.from([0x02])))
    await expect(init).rejects.toThrow('unexpected ready frame')
  })

  async function readyEngine(): Promise<{
    engine: InstanceType<typeof PythonTextEncoderEngine>
    child: FakeChild
  }> {
    const child = makeChild()
    spawnMock.mockReturnValue(child)
    const engine = new PythonTextEncoderEngine(
      '/usr/bin/python',
      '/scripts/text_encoder_inference.py',
      '/models/text.onnx',
      '/models/tokenizer.json',
      { contextLength: 64, padId: 0 },
    )
    const init = engine.initialize()
    child.stdout.write(frame(Buffer.from([0x01])))
    await init
    return { engine, child }
  }

  // D649 fix round: a SIGTERM exit has code null, and the old guard
  // (`code !== 0 && code !== null`) left the in-flight encode waiting forever.
  it('an encode in flight REJECTS when the engine is disposed (SIGTERM, code null)', async () => {
    const { engine, child } = await readyEngine()
    const inFlight = engine.encode('a cat')
    const disposed = engine.dispose()
    child.emit('exit', null, 'SIGTERM')
    await expect(inFlight).rejects.toThrow(/disposed|exited/)
    await disposed
  })

  it('an encode in flight REJECTS on a clean exit (code 0) too', async () => {
    const { engine, child } = await readyEngine()
    const inFlight = engine.encode('a cat')
    child.emit('exit', 0, null)
    await expect(inFlight).rejects.toThrow(/exited/)
  })

  it('two concurrent encodes each get THEIR answer, in order', async () => {
    const { engine, child } = await readyEngine()
    const a = engine.encode('a')
    const b = engine.encode('b')
    child.stdout.write(Buffer.concat([frame(tensorPayload([1])), frame(tensorPayload([2]))]))
    expect(Array.from(await a)).toEqual([1])
    expect(Array.from(await b)).toEqual([2])
  })

  // D649 review round 2: after an UNEXPECTED exit (OOM kill, decode crash) the
  // next encode used to write into a dead pipe and wait forever.
  it('after a crash the engine is DEAD: the next encode rejects at once, by name', async () => {
    const { engine, child } = await readyEngine()
    expect(engine.isAlive()).toBe(true)
    child.emit('exit', null, 'SIGKILL')
    expect(engine.isAlive()).toBe(false)
    const started = Date.now()
    await expect(engine.encode('a cat')).rejects.toThrow(
      /engine is dead — process exited \(code null, signal SIGKILL\)/,
    )
    expect(Date.now() - started).toBeLessThan(100)
  })

  it('an EPIPE on stdin fails the waiter and marks the engine dead — never an uncaught error', async () => {
    const { engine, child } = await readyEngine()
    const inFlight = engine.encode('a cat')
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    await expect(inFlight).rejects.toThrow(/stdin error: write EPIPE/)
    expect(engine.isAlive()).toBe(false)
  })
})

describe('crash budget, end to end through a REAL engine over a mocked spawn (D6)', () => {
  /**
   * Each spawned child says ready, then dies (SIGKILL — an OOM) on its first
   * inference: the model loads fine and crashes on use, forever.
   */
  function crashingChild(): FakeChild {
    const child = makeChild()
    setImmediate(() => child.stdout.write(frame(Buffer.from([0x01]))))
    child.stdin.on('data', () => {
      setImmediate(() => child.emit('exit', null, 'SIGKILL'))
    })
    return child
  }

  function towers(): {
    engines: InstanceType<typeof ClipTextEngines>
    budget: InstanceType<typeof CrashBudget>
    errors: unknown[]
  } {
    const errors: unknown[] = []
    const budget = new CrashBudget({
      tower: 'text',
      nodeId: () => 'hub',
      logger: { info: () => {}, error: (m: string) => errors.push(m) },
      maxCrashes: 3,
    })
    const engines = new ClipTextEngines({
      activeModelId: () => null,
      budget,
      requirements: new RequirementsGate({
        tower: 'text',
        nodeId: () => 'hub',
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      }),
      logger: { info: () => {}, warn: () => {} },
      registry: BUILTIN_CLIP_MODELS,
      textCatalog: CLIP_TEXT_MODELS,
      // Constructed, not started — `initialize()` (the spawn) is the holder's call.
      build: async (spec) =>
        new PythonTextEncoderEngine(
          '/usr/bin/python',
          '/scripts/text_encoder_inference.py',
          `/models/${spec.textEntry.id}.onnx`,
          `/models/${spec.meta.tokenizerFile}`,
          { contextLength: spec.meta.contextLength, padId: spec.meta.padId },
        ),
    })
    return { engines, budget, errors }
  }

  it('N crashes put the model in FAILED; the next query is refused by name WITHOUT spawning', async () => {
    spawnMock.mockImplementation(() => crashingChild())
    const { engines, errors } = towers()
    for (let i = 0; i < 3; i++) {
      await expect(engines.encode('siglip2-b16-224', 'a van')).rejects.toThrow(/exited|dead/)
    }
    expect(spawnMock).toHaveBeenCalledTimes(3)
    await expect(engines.encode('siglip2-b16-224', 'a van')).rejects.toThrow(
      /\[embedding-model-failed model=siglip2-b16-224 tower=text node=hub\] siglip2-b16-224 \(text tower\) crashed 3 times/,
    )
    await expect(engines.encode('siglip2-b16-224', 'a van')).rejects.toThrow(
      /embedding-model-failed/,
    )
    expect(spawnMock).toHaveBeenCalledTimes(3) // no fourth, fifth… spawn
    expect(errors).toHaveLength(1) // ONE error at the transition, not one per request
  })

  it('a model change (reset) clears FAILED, and the tower is tried again', async () => {
    spawnMock.mockImplementation(() => crashingChild())
    const { engines, budget } = towers()
    for (let i = 0; i < 4; i++) {
      await engines.encode('siglip2-b16-224', 'a').catch(() => undefined)
    }
    expect(budget.failed().map((f) => f.modelId)).toEqual(['siglip2-b16-224'])
    expect(budget.reset(undefined, 'model-change')).toEqual(['siglip2-b16-224'])
    const before = spawnMock.mock.calls.length
    await engines.encode('siglip2-b16-224', 'a').catch(() => undefined)
    expect(spawnMock.mock.calls.length).toBe(before + 1)
  })

  it('a LOAD that keeps failing is bounded the same way — no retry per query forever', async () => {
    spawnMock.mockImplementation(() => {
      const child = makeChild()
      setImmediate(() => child.emit('exit', 1, null)) // dies before ready
      return child
    })
    const { engines } = towers()
    for (let i = 0; i < 3; i++) {
      await expect(engines.encode('siglip2-b16-224', 'a')).rejects.toThrow(/exited/)
    }
    await expect(engines.encode('siglip2-b16-224', 'a')).rejects.toThrow(
      /embedding-model-failed.*load failed/,
    )
    expect(spawnMock).toHaveBeenCalledTimes(3)
  })
})
