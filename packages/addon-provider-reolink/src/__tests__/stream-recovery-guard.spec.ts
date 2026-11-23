/**
 * The self-healing stream asks the camera, before EVERY recovery attempt,
 * whether re-dialling may wake it. The answer follows the power source as it
 * is NOW, not as it was when the server was created.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRfc4571TcpServer } from '@apocaliss92/nodelink-js'
import { ReolinkCamera } from '../reolink-camera.js'

vi.mock('@apocaliss92/nodelink-js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@apocaliss92/nodelink-js')>()
  return { ...original, createRfc4571TcpServer: vi.fn() }
})

type PowerSource = 'adapter' | 'battery' | 'unknown'

interface CameraShape {
  readonly isBattery: boolean
  readonly hasBattery?: boolean
  readonly source?: PowerSource
}

interface MutablePower {
  source: PowerSource | undefined
}

interface SleepProbe {
  streamSourceMaySleep(): boolean
  ensureRfc4571Server(camStreamId: string, channel: number, profile: 'main'): Promise<unknown>
}

function makeCamera(shape: CameraShape): { camera: SleepProbe; power: MutablePower } {
  const power: MutablePower = { source: shape.source }
  const camera: SleepProbe = Object.create(ReolinkCamera.prototype)
  Object.defineProperties(camera, {
    id: { value: 3628 },
    stableId: { value: 'stable-3628' },
    isBattery: { value: shape.isBattery },
    getProbeFlags: { value: () => ({ hasBattery: shape.hasBattery }) },
    config: {
      value: {
        get: () =>
          power.source === undefined
            ? undefined
            : { powerSourceSnapshot: { source: power.source } },
      },
    },
    active: { value: new Map() },
    ctx: { value: { logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } } },
    ensureApi: { value: async () => ({}) },
    libLoggerAdapter: { value: () => ({}) },
  })
  return { camera, power }
}

describe('streamSourceMaySleep', () => {
  it.each<[string, CameraShape, boolean]>([
    ['battery camera on its adapter', { isBattery: true, source: 'adapter' }, false],
    ['battery camera on battery', { isBattery: true, source: 'battery' }, true],
    ['wired camera without a battery', { isBattery: false, hasBattery: false }, false],
    [
      'probe says battery while isBattery is false',
      { isBattery: false, hasBattery: true, source: 'battery' },
      true,
    ],
    ['battery camera, power source not known yet', { isBattery: true }, true],
    ['battery camera, power source reads unknown', { isBattery: true, source: 'unknown' }, true],
    ['wired camera, power snapshot unknown', { isBattery: false, source: 'unknown' }, false],
  ])('%s', (_name, shape, expected) => {
    expect(makeCamera(shape).camera.streamSourceMaySleep()).toBe(expected)
  })
})

describe('the recovery guard handed to the library', () => {
  beforeEach(() => {
    vi.mocked(createRfc4571TcpServer).mockReset()
    vi.mocked(createRfc4571TcpServer).mockRejectedValue(new Error('stop here'))
  })

  it('follows a power change after the server was created', async () => {
    const { camera, power } = makeCamera({ isBattery: true, source: 'adapter' })
    await camera.ensureRfc4571Server('native:main', 0, 'main')
    const options = vi.mocked(createRfc4571TcpServer).mock.calls[0]?.[0]
    const guard = options?.resilience?.recoveryGuard
    if (!guard) throw new Error('no recoveryGuard was passed')
    expect(guard()).toEqual({ allowed: true })
    power.source = 'battery'
    expect(guard()).toMatchObject({ allowed: false })
    power.source = 'adapter'
    expect(guard()).toEqual({ allowed: true })
  })
})
