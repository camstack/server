/**
 * Customize tab of a dryer that can take the "Power and energy" extension: the whole meter is
 * linked to a metered plug (device 560) by one stored `capLink` (D1076).
 * Shows the "Source device" link row above the readings. Load alone (`--fixtures customize-meter-group`).
 */
import { defineFixtures } from './_define'
import washerArea from './customize-washer'
import { NOW } from './_time'

const washer = washerArea.handlers
const HA = 'provider-homeassistant'

const VIEW = {
  block: {
    id: 'blk-dryer-meter',
    name: 'customize:dryer-505',
    code: '',
    enabled: true,
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
            kind: 'capLink',
            cap: 'power-meter',
            linkId: 'meter-device',
            source: { addonId: HA, stableId: 'washer-plug' },
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
  description: 'Customize tab with the power-meter "Source device" whole-cap link row',
  handlers: {
    ...washer,
    'deviceManager.getBindings': bindingsWithoutMeter,
    'coreBlocks.getCustomization': (i: { stableId?: string }) =>
      i.stableId === 'appliance-505'
        ? { state: 'loaded', view: VIEW }
        : { state: 'loaded', view: null },
    'coreBlocks.getCapLinks': {
      status: 'ok',
      links: [
        {
          linkId: 'meter-device',
          cap: 'power-meter',
          slot: null,
          mode: 'project',
          source: { deviceId: 560, cap: 'power-meter' },
          state: 'linked',
        },
      ],
    },
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
