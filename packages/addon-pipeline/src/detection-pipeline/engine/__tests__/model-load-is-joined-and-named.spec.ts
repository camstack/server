/**
 * A model load that is already pending is JOINED, and a load that fails is
 * NAMED (D653).
 *
 * 2026-09-26, hub `openvino:gpu`: after one YuNet GPU compile hung, 43 further
 * `Loading step variant yunet` loads were issued behind it. Each was rejected
 * after 60 s and not one rejection was logged — every one of them looked like a
 * load still in progress. Each new dispatch re-issued the load, and each issue
 * allocated a fresh pool index that was never given back.
 *
 * Pinned here, against the real `PipelineModelManager`:
 *  1. two callers asking for the same (step, model) on the same pool while the
 *     first load is pending share ONE pool command;
 *  2. a rejected load is an ERROR line naming the model, the pool index and
 *     the device, with the pool's reason;
 *  3. the index a failed load allocated is handed back, so a retry reuses it
 *     instead of walking toward the 254-slot ceiling.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger, PipelineDefaultStep, PoolModelConfig } from '@camstack/types'
import { PipelineModelManager, type PoolModelSource } from '../pipeline-model-manager.js'
import { SharedInferencePool } from '../shared-inference-pool.js'

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

const SOURCE: PoolModelSource = {
  buildConfig: (_stepId, modelId): PoolModelConfig => ({
    path: `/data/models/openvino/camstack-${modelId}.xml`,
    inputSize: 320,
    preprocessMode: 'letterbox',
    postprocessor: 'yunet',
    confidence: 0.5,
  }),
  resolveDecode: () => ({ nmsIouThreshold: 0.45 }),
}

function faceStep(): PipelineDefaultStep {
  return {
    addonId: 'face-detection',
    addonName: 'Face Detection',
    slot: 'cropper',
    inputClasses: ['person'],
    outputClasses: ['face'],
    enabled: true,
    modelId: 'yunet-2023mar',
    children: [],
  }
}

interface Deferred {
  readonly promise: Promise<{ loadMs: number }>
  resolve(value: { loadMs: number }): void
  reject(err: Error): void
}

function deferred(): Deferred {
  let resolve!: (value: { loadMs: number }) => void
  let reject!: (err: Error) => void
  const promise = new Promise<{ loadMs: number }>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function harness(): {
  manager: PipelineModelManager
  pool: SharedInferencePool
  loads: Deferred[]
  loadModel: ReturnType<typeof vi.fn>
  lines: LoggedLine[]
} {
  const lines: LoggedLine[] = []
  const log = captureLogger(lines)
  const pool = new SharedInferencePool('/nonexistent/python', 'openvino', log, { device: 'gpu' })
  const loads: Deferred[] = []
  const loadModel = vi.fn((_index: number, _config: PoolModelConfig) => {
    const d = deferred()
    loads.push(d)
    return d.promise
  })
  vi.spyOn(pool, 'loadModel').mockImplementation(loadModel)
  const manager = new PipelineModelManager(pool, SOURCE, log, { deviceKey: 'openvino:gpu' })
  return { manager, pool, loads, loadModel, lines }
}

describe('an identical pending load is joined, not re-issued', () => {
  it('sends ONE load command for two callers of the same (step, model)', async () => {
    const h = harness()
    const first = h.manager.loadAdditional([faceStep()])
    const second = h.manager.loadAdditional([faceStep()])
    await Promise.resolve()
    expect(h.loadModel).toHaveBeenCalledTimes(1)

    h.loads[0]!.resolve({ loadMs: 1400 })
    await Promise.all([first, second])
    expect(h.loadModel).toHaveBeenCalledTimes(1)
    expect(h.manager.isLoadedWithModel('face-detection', 'yunet-2023mar')).toBe(true)
  })

  it('fails every joined caller with the one rejection', async () => {
    const h = harness()
    const first = h.manager.loadAdditional([faceStep()])
    const second = h.manager.loadAdditional([faceStep()])
    await Promise.resolve()
    h.loads[0]!.reject(
      new Error('Failed to load model at index 0: compile-timeout: did not return'),
    )
    await expect(first).rejects.toThrow(/compile-timeout/)
    await expect(second).rejects.toThrow(/compile-timeout/)
    expect(h.loadModel).toHaveBeenCalledTimes(1)
  })
})

describe('a rejected load is named', () => {
  it('logs an ERROR with the model, pool index, device and reason', async () => {
    const h = harness()
    const load = h.manager.loadAdditional([faceStep()])
    await Promise.resolve()
    h.loads[0]!.reject(
      new Error('Failed to load model at index 0: compile-timeout: did not return'),
    )
    await expect(load).rejects.toThrow()

    const line = h.lines.find(
      (l) => l.level === 'error' && l.message === 'Step variant load failed',
    )
    expect(line, 'a rejected load must never be silent').toBeDefined()
    expect(line!.meta).toMatchObject({
      step: 'face-detection',
      modelId: 'yunet-2023mar',
      poolIndex: 0,
      deviceKey: 'openvino:gpu',
    })
    expect(String(line!.meta['error'])).toMatch(/compile-timeout/)
  })

  it('hands back the index a failed load allocated', async () => {
    const h = harness()
    const load = h.manager.loadAdditional([faceStep()])
    await Promise.resolve()
    h.loads[0]!.reject(new Error('boom'))
    await expect(load).rejects.toThrow()

    const retry = h.manager.loadAdditional([faceStep()])
    await Promise.resolve()
    h.loads[1]!.resolve({ loadMs: 1 })
    await retry
    expect(h.loadModel.mock.calls.map((c) => c[0])).toEqual([0, 0])
  })
})
