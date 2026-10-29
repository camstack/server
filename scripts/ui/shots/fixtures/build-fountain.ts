/**
 * Build → Custom device with a built pet fountain. `/build?tab=custom-device`
 * lists one composed device; `&block=blk-fountain` opens its card editor (the
 * Commands card: five method commands and the filter reset); `&new=1` is the
 * template picker and `&new=1&preset=pet-fountain` the fountain wizard. A
 * fountain container with its entities in the Kitchen, a filter pair and a
 * few devices elsewhere, so the picker has suggestions and non-suggestions.
 */
import { petFountainFromEntitiesComposition } from '../../../../packages/types/src/composition/presets/pet-fountain.ts'
import { defineFixtures } from './_define'

const HA = 'provider-homeassistant'

const entity = (
  id: number,
  name: string,
  stableId: string,
  type: string,
  parentDeviceId: number | null,
  location: string,
) => ({
  id,
  stableId,
  addonId: HA,
  type,
  name,
  location,
  disabled: false,
  parentDeviceId,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: {},
})

const FOUNTAIN_BOX = entity(300, 'Pet fountain', 'fountain', 'container', null, 'Kitchen')
const KITCHEN_ENTITIES = [
  entity(301, 'Water level', 'sensor.fountain_water_level', 'sensor', 300, 'Kitchen'),
  entity(302, 'Water volume', 'sensor.fountain_water_volume', 'sensor', 300, 'Kitchen'),
  entity(303, 'Pump', 'switch.fountain_pump', 'switch', 300, 'Kitchen'),
  entity(304, 'Pump cycle', 'switch.fountain_cycle', 'switch', 300, 'Kitchen'),
  entity(305, 'Pump on minutes', 'number.fountain_on_minutes', 'sensor', 300, 'Kitchen'),
  entity(306, 'Pump off minutes', 'number.fountain_off_minutes', 'sensor', 300, 'Kitchen'),
  entity(307, 'Last drink', 'sensor.fountain_last_drink', 'sensor', 300, 'Kitchen'),
  entity(308, 'Drink this hour', 'sensor.fountain_hour_drink', 'sensor', 300, 'Kitchen'),
  entity(309, 'Drink 24 h', 'sensor.fountain_24h_drink', 'sensor', 300, 'Kitchen'),
  entity(310, 'Drink today', 'sensor.fountain_today_drink', 'sensor', 300, 'Kitchen'),
  entity(311, 'Clear daily counters', 'button.fountain_clear_daily', 'sensor', 300, 'Kitchen'),
  entity(312, 'Filter days left', 'sensor.fountain_filter_days', 'sensor', 300, 'Kitchen'),
  entity(313, 'Filter changed', 'button.fountain_filter_changed', 'sensor', 300, 'Kitchen'),
]
const ELSEWHERE = [
  entity(320, 'Garage door', 'switch.garage_door', 'switch', null, 'Garage'),
  entity(321, 'Garage temperature', 'sensor.garage_temp', 'sensor', null, 'Garage'),
  entity(322, 'Hall lamp', 'switch.hall_lamp', 'switch', null, 'Hall'),
]
const FLEET = [FOUNTAIN_BOX, ...KITCHEN_ENTITIES, ...ELSEWHERE]

const ref = (stableId: string) => ({ addonId: HA, stableId })

const composition = petFountainFromEntitiesComposition({
  waterLevel: ref('sensor.fountain_water_level'),
  waterVolume: ref('sensor.fountain_water_volume'),
  pump: ref('switch.fountain_pump'),
  pumpInterval: ref('switch.fountain_cycle'),
  pumpOnMinutes: ref('number.fountain_on_minutes'),
  pumpOffMinutes: ref('number.fountain_off_minutes'),
  lastDrink: ref('sensor.fountain_last_drink'),
  currentHourDrink: ref('sensor.fountain_hour_drink'),
  last24hDrink: ref('sensor.fountain_24h_drink'),
  todayDrink: ref('sensor.fountain_today_drink'),
  clearDaily: ref('button.fountain_clear_daily'),
  filter: {
    daysRemaining: ref('sensor.fountain_filter_days'),
    changed: ref('button.fountain_filter_changed'),
  },
})

const BLOCK = {
  id: 'blk-fountain',
  name: 'Kitchen fountain',
  code: '',
  enabled: true,
  placement: 'hub',
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'admin',
  status: 'running',
  lastChangedAt: 1,
  source: { kind: 'composition', composition },
}

const CAPS_BY_STABLE_ID: Readonly<Record<string, readonly string[]>> = {
  'switch.fountain_pump': ['switch', 'device-status'],
  'switch.fountain_cycle': ['switch', 'device-status'],
  'number.fountain_on_minutes': ['control', 'device-status'],
  'number.fountain_off_minutes': ['control', 'device-status'],
  'button.fountain_clear_daily': ['button', 'device-status'],
  'button.fountain_filter_changed': ['button', 'device-status'],
  'switch.garage_door': ['switch', 'device-status'],
  'switch.hall_lamp': ['switch', 'device-status'],
}

function capsOf(deviceId: number | undefined): readonly string[] {
  const row = FLEET.find((d) => d.id === deviceId)
  return CAPS_BY_STABLE_ID[row?.stableId ?? ''] ?? ['enum-sensor', 'device-status']
}

export default defineFixtures({
  area: 'build-fountain',
  description: 'Built pet fountain: the Commands card and the fountain template wizard',
  handlers: {
    'deviceManager.listAll': FLEET,
    'deviceManager.getDevice': (input: { deviceId?: number }) =>
      FLEET.find((d) => d.id === input.deviceId) ?? null,
    'deviceManager.listDeviceIdsByCaps': (input: { capNames?: readonly string[] }) =>
      FLEET.filter((d) => capsOf(d.id).includes(input.capNames?.[0] ?? '')).map((d) => d.id),
    'deviceManager.getBindings': (input: { deviceId?: number }) => ({
      deviceId: input.deviceId ?? 0,
      entries: capsOf(input.deviceId).map((capName) => ({
        capName,
        kind: 'native' as const,
        providerAddonId: HA,
        providerNodeId: 'hub',
        nativeAddonId: HA,
      })),
    }),
    'deviceManager.listPersistedByAddon': [],
    'deviceManager.listSiteZones': [],
    'coreBlocks.list': { blocks: [BLOCK] },
    'coreBlocks.getComposition': (input: { blockId?: string }) =>
      input.blockId === 'blk-fountain'
        ? {
            state: 'loaded',
            view: {
              block: BLOCK,
              state: { kind: 'answered', state: { blockId: 'blk-fountain', deviceId: 900 } },
            },
          }
        : { state: 'loaded', view: null },
    'coreBlocks.listCompositions': {
      state: 'loaded',
      views: [
        {
          block: BLOCK,
          state: { kind: 'answered', state: { blockId: 'blk-fountain', deviceId: 900 } },
        },
      ],
    },
    'coreBlocks.getCustomization': { state: 'loaded', view: null },
    'coreBlocks.listComposableCaps': { caps: [] },
    'actions.list': [],
  },
})
