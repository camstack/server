/**
 * The lock hero with a linked door contact. `/devices/941` is a lock whose door
 * contact reads open (the lock reports door-open), `/devices/942` a locked lock
 * with a closed contact, `/devices/943` a lock whose contact has no reading yet,
 * `/devices/944` a lock with no contact linked. Load BEFORE `helpers`
 * (`--fixtures lock-door,helpers`): the first area answering a path wins, and
 * every other path falls through to it.
 */
import { CompositionSchema } from '../../../../packages/types/src/composition/composition.ts'
import helpersArea from './helpers'
import { defineFixtures } from './_define'

const HA = 'provider-homeassistant'

const device = (id: number, name: string, stableId: string, type: string) => ({
  id,
  stableId,
  addonId: HA,
  type,
  name,
  location: 'Front of house',
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: {},
})

interface LockRow {
  readonly lock: ReturnType<typeof device>
  readonly sensor: ReturnType<typeof device> | null
  readonly lockState: string
  readonly contact: { entryOpen: boolean; lastChangedAt: number } | null
}

const ROWS: readonly LockRow[] = [
  {
    lock: device(941, 'Front door', 'lock.front', 'lock'),
    sensor: device(951, 'Front door contact', 'binary_sensor.front', 'sensor'),
    lockState: 'door-open',
    contact: { entryOpen: true, lastChangedAt: 1 },
  },
  {
    lock: device(942, 'Back door', 'lock.back', 'lock'),
    sensor: device(952, 'Back door contact', 'binary_sensor.back', 'sensor'),
    lockState: 'locked',
    contact: { entryOpen: false, lastChangedAt: 1 },
  },
  {
    lock: device(943, 'Side door', 'lock.side', 'lock'),
    sensor: device(953, 'Side door contact', 'binary_sensor.side', 'sensor'),
    lockState: 'locked',
    contact: null,
  },
  {
    lock: device(944, 'Shed door', 'lock.shed', 'lock'),
    sensor: null,
    lockState: 'locked',
    contact: null,
  },
]

const ALL_DEVICES = ROWS.flatMap((r) => (r.sensor === null ? [r.lock] : [r.lock, r.sensor]))

const linkBlock = (row: LockRow) =>
  row.sensor === null
    ? null
    : {
        id: `blk-${row.lock.stableId}`,
        name: row.lock.name,
        code: '',
        enabled: true,
        placement: 'hub',
        createdAt: 1,
        updatedAt: 1,
        createdBy: 'admin',
        status: 'running',
        lastChangedAt: 1,
        source: {
          kind: 'composition',
          composition: CompositionSchema.parse({
            target: { kind: 'existing', device: { addonId: HA, stableId: row.lock.stableId } },
            features: [
              {
                kind: 'fields',
                cap: 'lock-control',
                fields: {
                  state: {
                    kind: 'expression',
                    expr: 'x',
                    bindings: {
                      x: {
                        kind: 'from',
                        source: { addonId: HA, stableId: row.sensor.stableId },
                        cap: 'contact',
                        fieldPath: 'entryOpen',
                      },
                    },
                  },
                },
              },
            ],
          }),
        },
      }

const base = (path: string): ((i: unknown) => unknown) => {
  const h = helpersArea.handlers[path]
  return typeof h === 'function' ? (i: unknown) => (h as (x: unknown) => unknown)(i) : () => h
}
const byId = (id: number | undefined) => ROWS.find((r) => r.lock.id === id || r.sensor?.id === id)

export default defineFixtures({
  area: 'lock-door',
  description: 'Lock hero card with a linked door contact (open, closed, unknown) and with none',
  handlers: {
    'deviceManager.listAll': (i: { addonId?: string }) => [
      ...(base('deviceManager.listAll')(i) as unknown[]),
      ...ALL_DEVICES.filter((d) => i.addonId === undefined || d.addonId === i.addonId),
    ],
    'deviceManager.getDevice': (i: { deviceId?: number }) =>
      ALL_DEVICES.find((d) => d.id === i.deviceId) ?? base('deviceManager.getDevice')(i),
    'deviceManager.getBindings': (i: { deviceId?: number }) => {
      const row = byId(i.deviceId)
      if (row === undefined) return base('deviceManager.getBindings')(i)
      const isLock = row.lock.id === i.deviceId
      return {
        deviceId: i.deviceId ?? 0,
        entries: (isLock ? ['lock-control', 'device-status'] : ['contact', 'device-status']).map(
          (capName) => ({
            capName,
            kind: 'native' as const,
            providerAddonId: HA,
            providerNodeId: 'hub',
            nativeAddonId: HA,
          }),
        ),
      }
    },
    'deviceState.getSnapshot': (i: { deviceId?: number }) => {
      const row = byId(i.deviceId)
      if (row === undefined) return base('deviceState.getSnapshot')(i)
      if (row.lock.id === i.deviceId) {
        return { 'lock-control': { state: row.lockState, lastChangedAt: 1 } }
      }
      return row.contact === null ? {} : { contact: row.contact }
    },
    'deviceState.getCapSlice': (i: { deviceId?: number; capName?: string }) => {
      const row = byId(i.deviceId)
      if (row === undefined) return base('deviceState.getCapSlice')(i)
      if (row.lock.id === i.deviceId && i.capName === 'lock-control') {
        return { state: row.lockState, lastChangedAt: 1 }
      }
      if (row.sensor?.id === i.deviceId && i.capName === 'contact') return row.contact ?? {}
      return {}
    },
    'coreBlocks.getCustomization': (i: { addonId?: string; stableId?: string }) => {
      const row = ROWS.find((r) => r.lock.stableId === i.stableId)
      const block = row === undefined ? null : linkBlock(row)
      return {
        state: 'loaded',
        view:
          block === null
            ? null
            : { block, state: { kind: 'answered', state: { blockId: block.id } } },
      }
    },
  },
})
