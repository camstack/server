import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { BaseDevice } from '../base-device.js'
import { DeviceType } from '../device-type.js'
import type { DeviceContext } from '../device-context.js'
import { ERROR_STATUS_COLD, type ErrorStatus } from '../../capabilities/error.cap.js'
import {
  DEVICE_ERROR_ALERT_MAX_ATTEMPTS,
  deviceErrorAlertSeverity,
} from '../device-error-episode.js'

interface RuntimeStateLike {
  installCapSchema(capName: string, schema: z.ZodObject<z.core.$ZodLooseShape>): void
}
interface CapLike {
  readonly name: string
  readonly runtimeState?: z.ZodObject<z.core.$ZodLooseShape>
}

const schema = z.object({})

function fixture(): {
  device: FaultyDevice
  emit: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
} {
  let runtimeState: RuntimeStateLike | undefined
  const emit = vi.fn().mockResolvedValue(undefined)
  const update = vi.fn().mockResolvedValue(undefined)
  const ctx = {
    id: 42,
    stableId: 'vac-1',
    parentDeviceId: null,
    persistedConfig: {},
    deviceMeta: {
      id: 42,
      stableId: 'vac-1',
      addonId: 'test-addon',
      type: DeviceType.Sensor,
      name: 'Robot',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    api: { alerts: { emit: { mutate: emit }, update: { mutate: update } } },
    eventBus: { emit: vi.fn(), subscribe: vi.fn() },
    persistConfig: vi.fn(),
    bindRuntimeState: (rs: RuntimeStateLike) => {
      runtimeState = rs
    },
    registerNativeCap: vi.fn((cap: CapLike) => {
      if (cap.runtimeState) runtimeState?.installCapSchema(cap.name, cap.runtimeState)
    }),
    fetchDevice: vi.fn(),
  } as unknown as DeviceContext
  return { device: new FaultyDevice(ctx), emit, update }
}

class FaultyDevice extends BaseDevice<typeof schema> {
  features = [] as const
  constructor(ctx: DeviceContext) {
    super(ctx, schema, { type: DeviceType.Sensor })
    this.registerErrorCap()
  }
  report(reading: ErrorStatus): Promise<void> {
    return this.publishError(reading)
  }
}

const fault = (patch: Partial<ErrorStatus> = {}): ErrorStatus => ({
  active: true,
  code: '38',
  label: 'Dust bin missing',
  severity: 'error',
  since: null,
  lastFetchedAt: 1,
  ...patch,
})
const clear: ErrorStatus = { ...ERROR_STATUS_COLD, active: false, lastFetchedAt: 2 }

describe('BaseDevice.publishError: alert delivery', () => {
  it('opens a warning fault as a warning alert, an error fault as a critical one', async () => {
    expect(deviceErrorAlertSeverity('warning')).toBe('warning')
    expect(deviceErrorAlertSeverity('error')).toBe('critical')
    const { device, emit } = fixture()
    await device.report(fault({ severity: 'warning', code: 'connection-lost' }))
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]?.[0]).toMatchObject({ severity: 'warning' })
  })

  it('re-emits the same episode as critical when a warning fault becomes an error', async () => {
    const { device, emit, update } = fixture()
    await device.report(fault({ severity: 'warning', code: 'connection-lost' }))
    await device.report(fault({ severity: 'warning', code: 'connection-lost', lastFetchedAt: 2 }))
    expect(emit).toHaveBeenCalledTimes(1)
    await device.report(fault({ severity: 'error', code: 'unreachable', lastFetchedAt: 3 }))
    expect(emit).toHaveBeenCalledTimes(2)
    const first = emit.mock.calls[0]?.[0]
    const second = emit.mock.calls[1]?.[0]
    expect(second).toMatchObject({ severity: 'critical', id: 'device-error:42' })
    expect(second.metadata.episodeId).toBe(first.metadata.episodeId)
    // An error that eases back to a warning keeps the episode at its loudest tier.
    await device.report(fault({ severity: 'warning', code: 'connection-lost', lastFetchedAt: 4 }))
    expect(emit).toHaveBeenCalledTimes(2)
    expect(update).not.toHaveBeenCalled()
  })

  it('retries a failed open on the next reading, and stops once it lands', async () => {
    const { device, emit } = fixture()
    emit.mockRejectedValueOnce(new Error('alerts down'))
    await device.report(fault())
    expect(emit).toHaveBeenCalledTimes(1)
    await device.report(fault({ lastFetchedAt: 2 }))
    expect(emit).toHaveBeenCalledTimes(2)
    await device.report(fault({ lastFetchedAt: 3 }))
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('gives up on an open after the bounded number of attempts', async () => {
    const { device, emit } = fixture()
    emit.mockRejectedValue(new Error('alerts down'))
    for (let i = 0; i < DEVICE_ERROR_ALERT_MAX_ATTEMPTS + 3; i += 1) {
      await device.report(fault({ lastFetchedAt: i + 1 }))
    }
    expect(emit).toHaveBeenCalledTimes(DEVICE_ERROR_ALERT_MAX_ATTEMPTS)
  })

  it('does not close an alert that never opened', async () => {
    const { device, emit, update } = fixture()
    emit.mockRejectedValue(new Error('alerts down'))
    await device.report(fault())
    await device.report(clear)
    expect(update).not.toHaveBeenCalled()
    // The open that failed is not retried once the fault is gone.
    await device.report(clear)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('closes the alert of a fault restored from before a restart', async () => {
    const { device, emit, update } = fixture()
    device.runtimeState.setCapState('error', fault({ since: 100 }))
    await device.report(fault({ lastFetchedAt: 2 }))
    expect(emit).not.toHaveBeenCalled()
    await device.report(clear)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('retries a failed close on the next clear reading', async () => {
    const { device, update } = fixture()
    update.mockRejectedValueOnce(new Error('alerts down'))
    await device.report(fault())
    await device.report(clear)
    await device.report({ ...clear, lastFetchedAt: 9 })
    expect(update).toHaveBeenCalledTimes(2)
    await device.report({ ...clear, lastFetchedAt: 10 })
    expect(update).toHaveBeenCalledTimes(2)
  })
})
