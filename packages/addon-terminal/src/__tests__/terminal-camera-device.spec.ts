import {
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  type IDeviceRuntimeState,
  snapshotCapability,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { installTerminalCameraRelay, TerminalCameraDevice } from '../terminal-camera-device.js'
import type { TerminalCameraRelay } from '../terminal-camera-relay.js'

function deviceContext(): DeviceContext {
  let runtimeState: IDeviceRuntimeState | null = null
  const runtimeStateMock: IDeviceRuntimeState = {
    installCapSchema: vi.fn(),
    setCapState: vi.fn(),
    getCapState: vi.fn(() => undefined),
    getCapField: vi.fn(),
    patchCapState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeCap: vi.fn(() => () => {}),
    snapshot: vi.fn(() => ({})),
    flush: vi.fn(async () => {}),
  } as unknown as IDeviceRuntimeState
  return {
    id: 42,
    stableId: 'terminal-camera-agent-a',
    parentDeviceId: null,
    persistedConfig: {
      instanceId: 'instance-a',
      nodeId: 'agent-a',
      profileId: 'monitor',
      profileLabel: 'BTM',
    },
    deviceMeta: {
      id: 42,
      stableId: 'terminal-camera-agent-a',
      type: DeviceType.Camera,
      name: 'Terminal BTM - Mac mini',
      location: null,
      disabled: false,
      addonId: 'terminal',
      metadata: null,
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
    api: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn() },
    persistConfig: vi.fn(async () => {}),
    devices: {},
    bindRuntimeState: vi.fn((state: IDeviceRuntimeState) => {
      runtimeState = state
      Object.assign(state, runtimeStateMock)
    }),
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtimeState) {
        runtimeState.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    fetchDevice: vi.fn(),
  } as unknown as DeviceContext
}

describe('TerminalCameraDevice snapshots', () => {
  it('uses the native snapshot relay instead of opening the MJPEG catalog stream', async () => {
    const snapshot = vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const streamUrl = vi.fn(() => 'http://127.0.0.1/stream/instance-a/agent-a/monitor.mjpeg')
    installTerminalCameraRelay({ snapshot, streamUrl } as unknown as TerminalCameraRelay)
    try {
      const ctx = deviceContext()
      const device = new TerminalCameraDevice(ctx)
      const registrations = ctx.registerNativeCap as ReturnType<typeof vi.fn>
      const snapshotRegistration = registrations.mock.calls.find(
        ([cap]) => (cap as { name: string }).name === snapshotCapability.name,
      )
      expect(device.features).toContain(DeviceFeature.NativeSnapshot)
      expect(snapshotRegistration).toBeDefined()

      const provider = snapshotRegistration![1] as {
        getSnapshot(input: {
          deviceId: number
        }): Promise<{ base64: string; contentType: string } | null>
      }
      await expect(provider.getSnapshot({ deviceId: 42 })).resolves.toEqual({
        base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
        contentType: 'image/jpeg',
      })
      expect(snapshot).toHaveBeenCalledWith('instance-a', 'agent-a', 'monitor')
      expect(streamUrl).not.toHaveBeenCalled()
    } finally {
      installTerminalCameraRelay(null)
    }
  })
})
