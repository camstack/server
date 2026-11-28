/**
 * planning#720 follow-ups.
 *
 *  1. `routedDeviceKeys` (the operator's opt-in a default re-derivation honours)
 *     forgets a device whose pool is gone — an idle-evicted pool is what a
 *     disabled accelerator looks like from here — so it is never a move target.
 *  2. A default pool whose start was superseded by a re-derivation does not
 *     lose the dispatch that waited on it: the start is retried for the new
 *     default and the dispatch is served by it.
 */
import type { IScopedLogger } from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineFactory } from '../engine/engine-factory.js'
import { deviceKeyOf, resolveDeviceEngine } from '../engine/resolve-device-engine.js'
import { DetectionPipelineProvider } from '../provider.js'

interface LoggedLine {
  readonly level: string
  readonly message: string
  readonly tags: Record<string, unknown>
}

function captureLogger(sink: LoggedLine[]): IScopedLogger {
  const record =
    (level: string) =>
    (message: string, opts?: { tags?: Record<string, unknown> }): void => {
      sink.push({ level, message, tags: opts?.tags ?? {} })
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

function makeProvider(lines: LoggedLine[]): DetectionPipelineProvider {
  const provider = new DetectionPipelineProvider(
    { readAddonStore: async () => ({}), writeAddonStore: async () => undefined },
    '/tmp/camstack-test-models-720-followups',
    captureLogger(lines),
  )
  provider['currentEngine'] = resolveDeviceEngine('openvino:gpu')
  provider['defaultDeviceCandidates'] = ['openvino:gpu', 'edgetpu:usb', 'cpu']
  provider['startProvisioningForCurrentEngine'] = () => undefined
  provider['assertEngineReady'] = async () => undefined
  provider['ensureBackendDeps'] = async () => undefined
  return provider
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('routedDeviceKeys', () => {
  it('forgets a device whose pool was evicted, so it is not a default move target', async () => {
    const lines: LoggedLine[] = []
    const provider = makeProvider(lines)
    provider['routedDeviceKeys'].add('edgetpu:usb')
    const coral = { isReady: () => true, dispose: async () => undefined } as EngineFactory
    provider['factoriesByDevice'].set('edgetpu:usb', coral)

    expect(provider['defaultMayMoveTo']('edgetpu:usb')).toBe(true)
    await provider['disposeDevicePool']('edgetpu:usb')
    expect(provider['defaultMayMoveTo']('edgetpu:usb')).toBe(false)

    provider['deviceLiveness'].recordAbsent('openvino:gpu', 'no-gpu-device', 'no GPU')
    provider['rederiveDefaultEngineIfFailed'](7)
    expect(deviceKeyOf(provider['currentEngine'])).toBe(deviceKeyOf(resolveDeviceEngine('cpu')))
  })
})

describe('killEngine', () => {
  it('forgets the killed engine as a move target', async () => {
    const provider = makeProvider([])
    provider['routedDeviceKeys'].add('openvino:gpu')
    provider['engineFactory'] = {
      isReady: () => true,
      dispose: async () => undefined,
    } as EngineFactory
    expect(provider['defaultMayMoveTo']('openvino:gpu')).toBe(true)
    await provider.killEngine({ engine: resolveDeviceEngine('openvino:gpu') })
    expect(provider['defaultMayMoveTo']('openvino:gpu')).toBe(false)
  })
})

describe('a default pool superseded while starting', () => {
  it('gives up after 3 starts when the default flips on every start', async () => {
    const lines: LoggedLine[] = []
    const provider = makeProvider(lines)
    let starts = 0
    vi.spyOn(EngineFactory.prototype, 'initialize').mockImplementation(async () => {
      starts++
      provider['currentEngine'] = resolveDeviceEngine(starts % 2 === 1 ? 'cpu' : 'openvino:gpu')
    })
    vi.spyOn(EngineFactory.prototype, 'dispose').mockResolvedValue(undefined)

    await expect(provider['ensureEngineFactory']()).rejects.toThrow(/superseded while starting/)

    expect(starts).toBe(3)
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('giving up'))).toBe(true)
  })

  it('re-starts for the new default and serves the waiting dispatch', async () => {
    const lines: LoggedLine[] = []
    const provider = makeProvider(lines)
    let starts = 0
    vi.spyOn(EngineFactory.prototype, 'initialize').mockImplementation(async () => {
      starts++
      if (starts === 1) provider['currentEngine'] = resolveDeviceEngine('cpu')
    })
    vi.spyOn(EngineFactory.prototype, 'dispose').mockResolvedValue(undefined)

    await expect(provider['ensureEngineFactory']()).resolves.toBeUndefined()

    expect(starts).toBe(2)
    expect(provider['engineFactory']).not.toBeNull()
    expect(deviceKeyOf(provider['currentEngine'])).toBe(deviceKeyOf(resolveDeviceEngine('cpu')))
    expect(lines.some((l) => l.message.includes('superseded while starting'))).toBe(true)
  })
})
