/**
 * Per-runtime pool provisioning.
 *
 * The defect these pin: every pool was built with the process-wide executor
 * options resolved ONCE for the node's DEFAULT backend, so an `openvino:npu`
 * pool on an onnx-default node came up with onnx's `concurrency: 4` — four
 * Python worker threads contending on one iGPU against a registry that has said
 * `openvino: 1` since 2026-06-24.
 */
import { describe, expect, it } from 'vitest'
import type { IScopedLogger, PipelineEngineChoice } from '@camstack/types'
import {
  overridesEqual,
  readOperatorOverride,
  resolvePoolProvisioning,
  runtimeIdForBackend,
} from '../pool-provisioning.js'
import { EngineFactory } from '../engine-factory.js'
import { resolveDeviceEngine } from '../resolve-device-engine.js'
import { tuningFor } from '../../runtimes.js'

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

describe('runtimeIdForBackend', () => {
  it('maps every device-pool backend onto its registry runtime', () => {
    expect(runtimeIdForBackend('openvino')).toBe('openvino')
    expect(runtimeIdForBackend('coreml')).toBe('coreml')
    expect(runtimeIdForBackend('edgetpu')).toBe('edgetpu')
    expect(runtimeIdForBackend('onnx')).toBe('onnx')
  })

  it('floors the onnxruntime-hosted backends (and anything unknown) to onnx', () => {
    expect(runtimeIdForBackend('cpu')).toBe('onnx')
    expect(runtimeIdForBackend('cuda')).toBe('onnx')
    expect(runtimeIdForBackend('nonsense')).toBe('onnx')
  })
})

describe('resolvePoolProvisioning — the pool provisions from ITS OWN runtime', () => {
  it('an openvino NPU pool gets openvino concurrency, never onnx 4', () => {
    const p = resolvePoolProvisioning(resolveDeviceEngine('openvino:npu'))
    expect(p.runtime).toBe('openvino')
    expect(p.concurrency).toBe(1)
    expect(p.numWorkers).toBe(1)
    expect(p.batchMode).toBe('none')
  })

  it('an openvino iGPU pool resolves the same row as the NPU pool', () => {
    expect(resolvePoolProvisioning(resolveDeviceEngine('openvino:gpu')).concurrency).toBe(1)
  })

  it('an onnx pool keeps the 4 worker threads the matrix sweep chose', () => {
    const p = resolvePoolProvisioning(resolveDeviceEngine('cpu'))
    expect(p.runtime).toBe('onnx')
    expect(p.concurrency).toBe(4)
    expect(p.batchMode).toBe('list')
  })

  it('a Coral pool is single-context: one thread, one subprocess', () => {
    const p = resolvePoolProvisioning(resolveDeviceEngine('edgetpu:usb'))
    expect(p.concurrency).toBe(1)
    expect(p.numWorkers).toBe(1)
  })

  it('reports no overridden fields when nothing is overridden', () => {
    expect(resolvePoolProvisioning(resolveDeviceEngine('openvino:npu')).overriddenFields).toEqual(
      [],
    )
  })

  it('every runtime resolves to exactly its registry row', () => {
    for (const [backend, runtime] of [
      ['openvino', 'openvino'],
      ['coreml', 'coreml'],
      ['edgetpu', 'edgetpu'],
      ['onnx', 'onnx'],
    ] as const) {
      const engine: PipelineEngineChoice = resolveDeviceEngine(backend)
      const p = resolvePoolProvisioning(engine)
      const row = tuningFor(runtime)
      expect(p.concurrency).toBe(row.concurrency)
      expect(p.numWorkers).toBe(row.numWorkers)
      expect(p.batchMode).toBe(row.batchMode)
      expect(p.windowMs).toBe(row.windowMs)
      expect(p.maxBatchSize).toBe(row.maxBatchSize)
    }
  })
})

describe('resolvePoolProvisioning — operator override wins', () => {
  it('an explicit concurrency beats the runtime registry row', () => {
    const p = resolvePoolProvisioning(resolveDeviceEngine('openvino:npu'), {
      concurrency: 3,
    })
    expect(p.concurrency).toBe(3)
    // Un-overridden fields still come from openvino's row.
    expect(p.batchMode).toBe('none')
  })

  it('names exactly the fields the operator overrode', () => {
    const p = resolvePoolProvisioning(resolveDeviceEngine('openvino:npu'), {
      concurrency: 3,
      batchMode: 'window',
    })
    expect(p.overriddenFields).toEqual(['concurrency', 'batchMode'])
  })

  it('never resolves below one worker thread / one subprocess', () => {
    const p = resolvePoolProvisioning(resolveDeviceEngine('onnx'), {
      concurrency: 0,
      numWorkers: -4,
    })
    expect(p.concurrency).toBe(1)
    expect(p.numWorkers).toBe(1)
  })
})

describe('readOperatorOverride — "Auto" is not an override', () => {
  it('an untouched settings blob yields no override at all', () => {
    expect(
      readOperatorOverride({
        concurrency: 0,
        numWorkers: 0,
        batchMode: '',
        windowMs: 0,
        maxBatchSize: 0,
        numStreams: 0,
        intraOpThreads: 0,
      }),
    ).toEqual({})
  })

  it('an empty store yields no override', () => {
    expect(readOperatorOverride({})).toEqual({})
  })

  it('picks up only the fields the operator actually moved', () => {
    expect(
      readOperatorOverride({
        concurrency: 2,
        numWorkers: 0,
        batchMode: 'window',
      }),
    ).toEqual({
      concurrency: 2,
      batchMode: 'window',
    })
  })

  it('rejects a garbage batch mode rather than passing it to the pool', () => {
    expect(readOperatorOverride({ batchMode: 'turbo' })).toEqual({})
  })

  it('rejects a non-numeric slider value', () => {
    expect(readOperatorOverride({ concurrency: '4' })).toEqual({})
  })
})

describe('overridesEqual', () => {
  it('two empty overrides are equal', () => {
    expect(overridesEqual({}, {})).toBe(true)
  })

  it('a changed field is not equal', () => {
    expect(overridesEqual({ concurrency: 1 }, { concurrency: 2 })).toBe(false)
  })

  it('an added field is not equal', () => {
    expect(overridesEqual({}, { concurrency: 2 })).toBe(false)
  })
})

describe('EngineFactory — provisioning is bound to the factory’s own engine', () => {
  function factoryFor(deviceKey: string): EngineFactory {
    return new EngineFactory({
      engine: resolveDeviceEngine(deviceKey),
      modelsDir: '/tmp/models',
      pythonPath: '/tmp/python',
      logger: captureLogger([]),
    })
  }

  it('an openvino factory resolves openvino concurrency, not the node default', () => {
    expect(factoryFor('openvino:npu').provisioning.concurrency).toBe(1)
  })

  it('an onnx factory built in the same process still resolves 4', () => {
    // Both factories exist at once: the provisioning cannot be a process-wide
    // value, it has to be derived from each factory's own engine.
    const openvino = factoryFor('openvino:gpu')
    const onnx = factoryFor('cpu')
    expect(openvino.provisioning.concurrency).toBe(1)
    expect(onnx.provisioning.concurrency).toBe(4)
  })

  it('carries the operator override through', () => {
    const factory = new EngineFactory({
      engine: resolveDeviceEngine('openvino:npu'),
      modelsDir: '/tmp/models',
      pythonPath: '/tmp/python',
      logger: captureLogger([]),
      provisioning: { concurrency: 2 },
    })
    expect(factory.provisioning.concurrency).toBe(2)
    expect(factory.provisioning.overriddenFields).toEqual(['concurrency'])
  })
})

describe('EngineFactory — the pool-init line names its device', () => {
  it('logs deviceKey / backend / device, and the fields the operator overrode', async () => {
    const lines: LoggedLine[] = []
    const factory = new EngineFactory({
      engine: resolveDeviceEngine('openvino:npu'),
      modelsDir: '/tmp/models',
      // Empty pythonPath makes `initialize` throw AFTER the provisioning line —
      // which is the point: a pool that never spawns must still say what it was.
      pythonPath: '',
      logger: captureLogger(lines),
    })
    await expect(factory.initialize([])).rejects.toThrow(/pythonPath is required/)

    const init = lines.find((l) => l.message === 'Python inference pool')
    expect(init).toBeDefined()
    expect(init?.meta['deviceKey']).toBe('openvino:npu')
    expect(init?.meta['backend']).toBe('openvino')
    expect(init?.meta['device']).toBe('npu')
    expect(init?.meta['concurrency']).toBe(1)
    expect(init?.meta['overriddenFields']).toEqual([])
    // The old `source: 'auto-default' | 'user-override'` field described the
    // concurrency tuning but read as the provenance of the engine choice, and
    // was 'user-override' on 100% of pools. It must not come back.
    expect(init?.meta).not.toHaveProperty('source')
  })

  it('a bare-backend engine still logs a device key', async () => {
    const lines: LoggedLine[] = []
    const factory = new EngineFactory({
      engine: { runtime: 'python', backend: 'onnx', format: 'onnx' },
      modelsDir: '/tmp/models',
      pythonPath: '',
      logger: captureLogger(lines),
    })
    await expect(factory.initialize([])).rejects.toThrow()
    const init = lines.find((l) => l.message === 'Python inference pool')
    expect(init?.meta['deviceKey']).toBe('onnx')
    expect(init?.meta['device']).toBeNull()
  })
})
