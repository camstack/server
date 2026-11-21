/**
 * Customize tab of a dryer that can take the "Power and energy" extension: `power` is already
 * read from a metered plug (device 560), the plug also exposes energy and voltage but no current.
 * Shows the "Source device" row above the readings. Load alone (`--fixtures customize-meter-group`).
 */
import { defineFixtures } from './_define'
import washerArea from './customize-washer'
import { NOW } from './_time'

const washer = washerArea.handlers
const HA = 'provider-homeassistant'

const literal = (expr: string) => ({ kind: 'expression' as const, expr, bindings: {} })

const VIEW = {
  block: {
    id: 'blk-dryer-meter',
    name: 'customize:dryer-505',
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
            cap: 'power-meter',
            fields: {
              lastFetchedAt: literal('now'),
              power: {
                kind: 'from',
                source: { addonId: HA, stableId: 'washer-plug' },
                cap: 'power-meter',
                fieldPath: 'power',
              },
            },
          },
        ],
      },
    },
  },
  state: { kind: 'answered', state: null },
}

const previous = washer['deviceManager.getWireableFields']
const previousBindings = washer['deviceManager.getBindings']

// The dryer has no native power-meter: the extension is offered (apply mode add).
const bindingsWithoutMeter = (input: { deviceId: number }): unknown => {
  const base: unknown =
    typeof previousBindings === 'function'
      ? Reflect.apply(previousBindings, undefined, [input])
      : previousBindings
  if (input.deviceId !== 505 || typeof base !== 'object' || base === null) return base
  const entries: unknown = Reflect.get(base, 'entries')
  if (!Array.isArray(entries)) return base
  return {
    ...base,
    entries: entries.filter((e) => Reflect.get(e, 'capName') !== 'power-meter'),
  }
}

const answerOther = (input: { deviceId: number }): unknown =>
  typeof previous === 'function' ? Reflect.apply(previous, undefined, [input]) : previous

export default defineFixtures({
  area: 'customize-meter-group',
  description: 'Customize tab with the power-meter "Source device" group row',
  handlers: {
    ...washer,
    'deviceManager.getBindings': bindingsWithoutMeter,
    'coreBlocks.getCustomization': (i: { stableId?: string }) =>
      i.stableId === 'appliance-505'
        ? { state: 'loaded', view: VIEW }
        : { state: 'loaded', view: null },
    'coreBlocks.listComposableCaps': { caps: [{ cap: 'running-state' }, { cap: 'power-meter' }] },
    'deviceManager.getWireableFields': (i: { deviceId: number }) =>
      i.deviceId === 560
        ? {
            caps: [
              {
                cap: 'power-meter',
                fields: [
                  { path: 'power', kind: 'number' },
                  { path: 'energy', kind: 'number' },
                  { path: 'voltage', kind: 'number' },
                ],
              },
            ],
          }
        : answerOther(i),
  },
})
