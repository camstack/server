/**
 * Customize tab of a washer whose "running" is read from a metered plug:
 * `/devices/505?tab=customize` has `running = dwell(x >= 10, 100000, 480000, 2)` with x the
 * plug's `power-meter.power` (device 560). The row's change dialog opens the stored source.
 * Load alone (`--fixtures customize-washer`).
 */
import appliancesArea from './appliances'
import { defineFixtures } from './_define'
import { NOW } from './_time'

const base = appliancesArea.handlers
const HA = 'provider-homeassistant'

const PLUG = {
  id: 560,
  stableId: 'washer-plug',
  addonId: HA,
  type: 'switch',
  name: 'Washer plug',
  location: 'Kitchen',
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
}

const literal = (expr: string) => ({ kind: 'expression' as const, expr, bindings: {} })

const VIEW = {
  block: {
    id: 'blk-washer-running',
    name: 'customize:washer-505',
    code: '',
    enabled: true,
    placement: 'hub',
    createdAt: 1,
    updatedAt: NOW,
    createdBy: 'admin',
    status: 'running',
    lastChangedAt: 1,
    source: {
      kind: 'composition',
      composition: {
        target: { kind: 'existing', device: { addonId: HA, stableId: 'appliance-505' } },
        features: [
          {
            kind: 'fields',
            cap: 'running-state',
            fields: {
              source: literal('"assigned"'),
              phase: literal('null'),
              lastFetchedAt: literal('now'),
              running: {
                kind: 'expression',
                expr: 'dwell(x >= 10, 100000, 480000, 2)',
                bindings: {
                  x: {
                    kind: 'from',
                    source: { addonId: HA, stableId: 'washer-plug' },
                    cap: 'power-meter',
                    fieldPath: 'power',
                  },
                },
              },
              since: {
                kind: 'expression',
                expr: 'latchedAt(running)',
                bindings: {
                  running: {
                    kind: 'from',
                    source: { addonId: HA, stableId: 'appliance-505' },
                    cap: 'running-state',
                    fieldPath: 'running',
                  },
                },
              },
            },
          },
        ],
      },
    },
  },
  state: { kind: 'answered', state: null },
}

const listed = base['deviceManager.listAll']
const devices: readonly unknown[] = Array.isArray(listed) ? listed : []
const call = (name: string, input: unknown): unknown => {
  const h = base[name]
  return typeof h === 'function' ? Reflect.apply(h, undefined, [input]) : h
}

export default defineFixtures({
  area: 'customize-washer',
  description: 'Customize tab of a washer running from a metered plug (change dialog)',
  handlers: {
    ...base,
    'deviceManager.listAll': [...devices, PLUG],
    'coreBlocks.getCustomization': (i: { stableId?: string }) =>
      i.stableId === 'appliance-505'
        ? { state: 'loaded', view: VIEW }
        : { state: 'loaded', view: null },
    'alerts.list': [],
    'deviceManager.listLocations': [],
    'coreBlocks.listComposableCaps': { caps: [{ cap: 'running-state' }] },
    'deviceManager.listDeviceIdsByCaps': (i: { capNames?: readonly string[] }) =>
      i.capNames?.[0] === 'power-meter' ? [560] : call('deviceManager.listDeviceIdsByCaps', i),
    'deviceManager.getWireableFields': (i: { deviceId: number }) =>
      i.deviceId === 560
        ? { caps: [{ cap: 'power-meter', fields: [{ path: 'power', kind: 'number' }] }] }
        : call('deviceManager.getWireableFields', i),
    'deviceState.getSnapshot': (i: { deviceId: number }) =>
      i.deviceId === 560
        ? { 'power-meter': { power: 412, unit: 'W' } }
        : call('deviceState.getSnapshot', i),
    'coreBlocks.proposeRunningThreshold': {
      state: 'proposal',
      transform: {
        kind: 'threshold',
        comparison: 'gte',
        threshold: 7,
        startDwellMs: 90_000,
        stopDwellMs: 600_000,
      },
      confidence: 'high',
      notes: [],
      evidence: { spanMs: 14 * 86_400_000, runsFound: 9 },
    },
  },
})
