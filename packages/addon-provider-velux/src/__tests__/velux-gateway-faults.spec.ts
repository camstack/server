/**
 * The gateway device publishes the KLF session as faults on the `error` cap:
 * cold until the first connect attempt, `connection-lost` while down,
 * `unreachable` once the run of failures is 2 min old, `auth-failed` on a
 * refused login, all cleared by a successful connect.
 */
import {
  type DeviceContext,
  DeviceType,
  type ErrorStatus,
  type IDeviceRuntimeState,
} from '@dominevo/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VeluxGatewayDevice } from '../devices/velux-gateway-device.js'
import { VELUX_GATEWAY_FAULT_TYPES, VELUX_UNREACHABLE_FAULT_MS } from '../velux-gateway-faults.js'
import {
  veluxGateways,
  type VeluxGatewayStatus,
  type VeluxNodeSource,
} from '../velux-node-resolver.js'
import { RecordingLogger } from './recording-logger.js'

const INT = 'int-7f3a'

interface Rig {
  readonly device: VeluxGatewayDevice
  readonly logger: RecordingLogger
  readonly emit: ReturnType<typeof vi.fn>
  readonly update: ReturnType<typeof vi.fn>
  slice(): ErrorStatus | undefined
}

function build(): Rig {
  const logger = new RecordingLogger()
  const emit = vi.fn(async () => {})
  const update = vi.fn(async () => {})
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
  const ctx = {
    id: 7,
    stableId: `velux:${INT}:gateway`,
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Gateway,
      name: 'Casa KLF',
      location: null,
      disabled: false,
      addonId: 'provider-velux',
      metadata: {},
    },
    persistedConfig: {
      integrationId: INT,
      system: 'velux',
      nativeId: `${INT}:gateway`,
    },
    initialRuntimeState: {},
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      getRecent: vi.fn(() => []),
    },
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({
      deviceState: { setCapSlice: vi.fn(async () => {}) },
    })),
    devices: { getChildren: vi.fn(async () => []) },
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {
      deviceManager: { setMetadata: { mutate: vi.fn(async () => {}) } },
      alerts: { emit: { mutate: emit }, update: { mutate: update } },
    },
    logger,
  } as unknown as DeviceContext
  const device = new VeluxGatewayDevice(ctx)
  return {
    device,
    logger,
    emit,
    update,
    slice: () => runtime?.getCapState<ErrorStatus>('error'),
  }
}

interface SessionState {
  status: VeluxGatewayStatus
  attempted: boolean
  loginRefused: boolean
  unreachableSince: number | null
  lastError: string | null
}

function session(state: Partial<SessionState>): void {
  const full: VeluxNodeSource = {
    getNodes: () => [],
    getNode: () => null,
    getConnection: () => ({ host: '192.168.20.65', password: 'secret' }),
    status: 'connected',
    firmware: null,
    attempted: true,
    loginRefused: false,
    unreachableSince: null,
    lastError: null,
    client: null,
    ...state,
  }
  veluxGateways.set(INT, full)
  veluxGateways.emitSnapshot(INT)
}

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-20T10:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  veluxGateways.clear()
})

describe('VeluxGatewayDevice faults', () => {
  it('declares every fault with a code, a label and a severity', () => {
    expect(VELUX_GATEWAY_FAULT_TYPES.map((f) => [f.code, f.severity])).toEqual([
      ['unreachable', 'error'],
      ['auth-failed', 'error'],
      ['connection-lost', 'warning'],
    ])
  })

  it('stays unknown before the first connect attempt, with nothing announced', async () => {
    const r = build()
    session({ status: 'disconnected', attempted: false })
    await r.device.onActivate()
    await settle()
    expect(r.slice()?.active).toBeNull()
    expect(r.emit).not.toHaveBeenCalled()
  })

  it('raises connection-lost (warning) while the session is down, below the threshold', async () => {
    const r = build()
    await r.device.onActivate()
    session({
      status: 'error',
      lastError: 'timeout',
      unreachableSince: Date.now(),
    })
    await settle()
    expect(r.slice()).toMatchObject({
      active: true,
      code: 'connection-lost',
      severity: 'warning',
    })
    expect(r.emit).toHaveBeenCalledTimes(1)
  })

  it('turns the same run into unreachable (error) once it is 2 minutes old, with no further tick', async () => {
    const r = build()
    await r.device.onActivate()
    const since = Date.now()
    session({ status: 'error', lastError: 'timeout', unreachableSince: since })
    await settle()
    await vi.advanceTimersByTimeAsync(VELUX_UNREACHABLE_FAULT_MS - 1000)
    expect(r.slice()?.code).toBe('connection-lost')
    await vi.advanceTimersByTimeAsync(1000)
    expect(r.slice()).toMatchObject({
      active: true,
      code: 'unreachable',
      severity: 'error',
      since,
    })
  })

  it('raises auth-failed (error) on a refused login, even right away', async () => {
    const r = build()
    await r.device.onActivate()
    session({
      status: 'error',
      lastError: 'login refused',
      loginRefused: true,
    })
    await settle()
    expect(r.slice()).toMatchObject({
      active: true,
      code: 'auth-failed',
      severity: 'error',
    })
  })

  it.each([
    [
      'connection-lost',
      (now: number) => ({
        status: 'error' as const,
        lastError: 'timeout',
        unreachableSince: now,
      }),
    ],
    [
      'auth-failed',
      () => ({
        status: 'error' as const,
        lastError: 'refused',
        loginRefused: true,
      }),
    ],
    [
      'unreachable',
      (now: number) => ({
        status: 'error' as const,
        lastError: 'timeout',
        unreachableSince: now - VELUX_UNREACHABLE_FAULT_MS - 1,
      }),
    ],
  ])('clears %s on a successful connect', async (code, down) => {
    const r = build()
    await r.device.onActivate()
    session(down(Date.now()))
    await settle()
    expect(r.slice()?.code).toBe(code)
    session({ status: 'connected' })
    await settle()
    expect(r.slice()).toMatchObject({ active: false, code: null })
    expect(r.update).toHaveBeenCalledTimes(1)
  })

  it('tags every fault log line with the device id', async () => {
    const r = build()
    await r.device.onActivate()
    session({
      status: 'error',
      lastError: 'timeout',
      unreachableSince: Date.now(),
    })
    await settle()
    const lines = r.logger.lines.filter((l) => l.message.includes('device error'))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of r.logger.lines) expect(l.tags['deviceId']).toBe(7)
  })
})
