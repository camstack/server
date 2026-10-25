/**
 * Test helper: a fake device registry behind the slice of `ctx.api` the
 * endpoint builders read (getDevice, getBindings, getChildren, ptz presets,
 * the alarm panel), so a spec can build the REAL endpoint shapes for any
 * combination of bound caps.
 */
import type { AddonApi, AddonContext, IScopedLogger } from '@camstack/types'
import type { DeviceBuildContext } from '../../handlers/discovery.js'
import type { DetectionSensorClass } from '../../handlers/endpoint-id.js'

export interface FakeDevice {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly capNames: readonly string[]
  readonly features?: readonly string[]
  readonly role?: string | null
  readonly parentDeviceId?: number | null
  readonly online?: boolean
}

export interface FakeApiExtras {
  readonly presets?: Readonly<Record<number, ReadonlyArray<{ name: string }>>>
  readonly panelStatus?: unknown
  /** Extra API namespaces merged over the registry ones (state reads). */
  readonly api?: Record<string, unknown>
  /** Detection classes a camera publishes sensors for (the R1 switch on). */
  readonly detectionClasses?: readonly DetectionSensorClass[]
  /** The R2 "Snapshots" switch. */
  readonly snapshots?: boolean
  /** R4 (D779): the object-detection classes the camera declares. */
  readonly objectDetection?: readonly ('person' | 'package')[]
}

export const quietLogger: IScopedLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  withTags: () => quietLogger,
  child: () => quietLogger,
}

function info(d: FakeDevice) {
  return {
    id: d.id,
    stableId: `stable-${d.id}`,
    name: d.name,
    type: d.type,
    features: d.features ?? [],
    role: d.role ?? null,
    parentDeviceId: d.parentDeviceId ?? null,
    location: null,
    online: d.online ?? true,
  }
}

export function fakeApi(devices: readonly FakeDevice[], extras: FakeApiExtras = {}): AddonApi {
  const byId = new Map(devices.map((d) => [d.id, d]))
  const api = {
    deviceManager: {
      getDevice: {
        query: async ({ deviceId }: { deviceId: number }) => {
          const d = byId.get(deviceId)
          return d === undefined ? null : info(d)
        },
      },
      getBindings: {
        query: async ({ deviceId }: { deviceId: number }) => ({
          entries: (byId.get(deviceId)?.capNames ?? []).map((capName) => ({ capName })),
        }),
      },
      getChildren: {
        query: async ({ parentDeviceId }: { parentDeviceId: number }) =>
          devices.filter((d) => d.parentDeviceId === parentDeviceId).map(info),
      },
    },
    ptz: {
      getPresets: {
        query: async ({ deviceId }: { deviceId: number }) =>
          (extras.presets?.[deviceId] ?? []).map((p, i) => ({
            id: String(i),
            name: p.name,
            fn: null,
          })),
      },
    },
    alarmPanel: {
      getStatus: {
        query: async () =>
          extras.panelStatus ?? {
            state: 'disarmed',
            availableModes: ['home', 'away'],
            requiresCode: false,
            lastChangedAt: 1,
          },
      },
    },
    ...extras.api,
  }
  // Documented test-stub boundary: the real AddonApi is far too large to build.
  return api as unknown as AddonApi
}

export function fakeBuildContext(
  devices: readonly FakeDevice[],
  extras: FakeApiExtras = {},
): DeviceBuildContext {
  // Documented test-stub boundary: only `api` is read by the builders.
  const classes = extras.detectionClasses
  return {
    ctx: { api: fakeApi(devices, extras) } as unknown as AddonContext,
    logger: quietLogger,
    ...(classes !== undefined ? { detectionClasses: async () => classes } : {}),
    ...(extras.snapshots === true ? { snapshots: true } : {}),
    ...(extras.objectDetection !== undefined
      ? { objectDetection: async () => extras.objectDetection ?? [] }
      : {}),
  }
}
