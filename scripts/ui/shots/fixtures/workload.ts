/**
 * The workload card (#585). `/devices/981` is a running VM with every resource
 * reported and a host link; `/devices/982` a stopped app container with ports
 * and an update waiting, whose provider serves no force stop and no pause;
 * `/devices/983` a host (load and temperature, reboot only, no power switch);
 * `/devices/984` a container whose state is not known yet (unknown, never
 * "stopped"). Load BEFORE `helpers` (`--fixtures workload,helpers`).
 */
import helpersArea from './helpers'
import { defineFixtures } from './_define'

const ADDON = 'provider-unraid'

const device = (id: number, name: string, role: string, parentDeviceId: number | null) => ({
  id,
  stableId: `unraid-tower-${id}`,
  addonId: ADDON,
  type: 'workload',
  name,
  location: null,
  disabled: false,
  parentDeviceId,
  role,
  online: true,
  probed: true,
  features: [],
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: {},
})

const NO_RESOURCES = {
  cpuPercent: null,
  memoryUsedBytes: null,
  memoryPercent: null,
  memoryLimitBytes: null,
  vcpus: null,
  diskUsedBytes: null,
  diskTotalBytes: null,
  netRxKbps: null,
  netTxKbps: null,
  load1: null,
  temperature: null,
}

const status = (patch: Record<string, unknown>): Record<string, unknown> => ({
  state: 'running',
  since: Date.now() - 3 * 86_400_000 - 4 * 3_600_000,
  hostDeviceId: null,
  image: null,
  os: null,
  version: null,
  autostart: null,
  resources: NO_RESOURCES,
  ports: [],
  addresses: [],
  updateAvailable: null,
  lastFetchedAt: 1,
  ...patch,
})

const SLICES: Readonly<Record<number, Record<string, unknown>>> = {
  981: status({
    hostDeviceId: 983,
    os: 'Debian 12',
    autostart: true,
    resources: {
      ...NO_RESOURCES,
      cpuPercent: 23.4,
      memoryUsedBytes: 6_442_450_944,
      memoryPercent: 75,
      memoryLimitBytes: 8_589_934_592,
      vcpus: 4,
      diskUsedBytes: 42_949_672_960,
      diskTotalBytes: 107_374_182_400,
      netRxKbps: 1840,
      netTxKbps: 312,
    },
    addresses: ['192.0.2.41', 'fd00::41'],
  }),
  982: status({
    state: 'stopped',
    since: Date.now() - 2 * 3_600_000,
    hostDeviceId: 983,
    image: 'ghcr.io/example/media-server:1.40',
    version: '1.40.2',
    autostart: false,
    ports: [
      { port: 8096, hostPort: 8096, hostIp: null, protocol: 'tcp' },
      { port: 1900, hostPort: 1900, hostIp: null, protocol: 'udp' },
    ],
    updateAvailable: true,
  }),
  983: status({
    since: Date.now() - 12 * 86_400_000,
    os: 'Unraid 7.1.4',
    version: '7.1.4',
    resources: {
      ...NO_RESOURCES,
      cpuPercent: 12,
      memoryPercent: 41,
      memoryUsedBytes: 26_843_545_600,
      memoryLimitBytes: 68_719_476_736,
      load1: 1.42,
      temperature: 48,
    },
    addresses: ['192.0.2.10'],
  }),
  984: status({ state: null, since: null }),
}

const OPTIONS: Readonly<Record<number, Record<string, boolean>>> = {
  981: {
    supportsStart: true,
    supportsStop: true,
    supportsRestart: true,
    supportsPause: true,
    supportsForceStop: true,
    hasResources: true,
    hasPorts: false,
    hasAddresses: true,
    hasAutostart: true,
    hasUpdateCheck: false,
  },
  982: {
    supportsStart: true,
    supportsStop: true,
    supportsRestart: true,
    supportsPause: false,
    supportsForceStop: false,
    hasResources: true,
    hasPorts: true,
    hasAddresses: false,
    hasAutostart: true,
    hasUpdateCheck: true,
  },
  983: {
    supportsStart: false,
    supportsStop: false,
    supportsRestart: true,
    supportsPause: false,
    supportsForceStop: false,
    hasResources: true,
    hasPorts: false,
    hasAddresses: true,
    hasAutostart: false,
    hasUpdateCheck: false,
  },
  984: {
    supportsStart: true,
    supportsStop: true,
    supportsRestart: true,
    supportsPause: false,
    supportsForceStop: false,
    hasResources: true,
    hasPorts: false,
    hasAddresses: false,
    hasAutostart: false,
    hasUpdateCheck: false,
  },
}

const DEVICES = [
  device(981, 'Home Assistant VM', 'vm', null),
  device(982, 'Media server', 'app-container', null),
  device(983, 'Tower', 'host', null),
  device(984, 'Backup agent', 'app-container', null),
]

/** A workload with start and stop also binds `switch` (the power hint, #462). */
const capsOf = (id: number): readonly string[] =>
  OPTIONS[id]?.supportsStart === true && OPTIONS[id]?.supportsStop === true
    ? ['workload', 'switch', 'device-status']
    : ['workload', 'device-status']

const base = (path: string): ((i: unknown) => unknown) => {
  const h = helpersArea.handlers[path]
  return typeof h === 'function' ? (i: unknown) => (h as (x: unknown) => unknown)(i) : () => h
}
const isOurs = (id: number | undefined): boolean => id !== undefined && id in SLICES
const switchSlice = (id: number) => ({
  on: !['stopped', 'crashed'].includes(String(SLICES[id]?.['state'])),
})

export default defineFixtures({
  area: 'workload',
  description:
    'Workload card (#585): a VM, an app container, a host and an unknown-state container',
  handlers: {
    'deviceManager.listAll': (i: { addonId?: string }) => [
      ...(base('deviceManager.listAll')(i) as unknown[]),
      ...DEVICES.filter((d) => i.addonId === undefined || d.addonId === i.addonId),
    ],
    'deviceManager.getDevice': (i: { deviceId?: number }) =>
      DEVICES.find((d) => d.id === i.deviceId) ?? base('deviceManager.getDevice')(i),
    'deviceManager.getBindings': (i: { deviceId?: number }) =>
      isOurs(i.deviceId)
        ? {
            deviceId: i.deviceId ?? 0,
            entries: capsOf(i.deviceId ?? 0).map((capName) => ({
              capName,
              kind: 'native' as const,
              providerAddonId: ADDON,
              providerNodeId: 'hub',
              nativeAddonId: ADDON,
            })),
          }
        : base('deviceManager.getBindings')(i),
    'workload.getOptions': (i: { deviceId?: number }) => OPTIONS[i.deviceId ?? 0] ?? null,
    'coreBlocks.getCustomization': { state: 'loaded', view: null },
    'deviceManager.getChildren': [],
    'powerSource.getStatus': {
      linked: false,
      switchDeviceId: null,
      switchName: null,
      switchOn: null,
      switchOnline: null,
      restartInProgress: false,
      offSeconds: 0,
    },
    'preferences.get': { rows: [] },
    'deviceState.getSnapshot': (i: { deviceId?: number }) =>
      isOurs(i.deviceId)
        ? {
            workload: SLICES[i.deviceId ?? 0],
            ...(capsOf(i.deviceId ?? 0).includes('switch')
              ? { switch: switchSlice(i.deviceId ?? 0) }
              : {}),
          }
        : base('deviceState.getSnapshot')(i),
    'deviceState.getCapSlice': (i: { deviceId?: number; capName?: string }) =>
      isOurs(i.deviceId) && i.capName === 'workload'
        ? SLICES[i.deviceId ?? 0]
        : isOurs(i.deviceId) && i.capName === 'switch'
          ? switchSlice(i.deviceId ?? 0)
          : isOurs(i.deviceId)
            ? {}
            : base('deviceState.getCapSlice')(i),
  },
})
