/**
 * Two appliance device pages, each bound to `consumables` (D915) and so each
 * with the ONE Consumables section under its hero card: 501 "Kitchen
 * dishwasher" (`/devices/501` — salt low, rinse aid ok, as `supply` items) and
 * 502 "Robot vacuum" (`/devices/502` — a percent item, a replace item and an
 * unknown one, plus its tanks as `supply` / `waste` items, drawn as tank,
 * product and bin forms), and 503 "Utility dishwasher" (`/devices/503` —
 * every item ok, so the section starts collapsed on "All OK") and 504
 * "Mopping robot" (`/devices/504` — two tanks, a bin and a product). Their Customize
 * tabs (`?tab=customize`) list the consumables each device already has.
 * `/devices/510?tab=customize` is an HA sensor whose only native cap is
 * `numeric-sensor`, so Battery is offered (D944). `/devices/511?tab=customize`
 * is the same type with a native battery, so the card is absent.
 * 5063 "Pet feeder" is a feeder bound to `pet-feeder` only (no `consumables`
 * binding, as on a hub whose provider has not registered the cap); 5064 is
 * the same feeder WITH the binding, so its Consumables section shows. Data
 * is invented.
 * 5065 "Water fountain" is a pet fountain built from loose entities, with its
 * filter as a consumable.
 */
import { defineFixtures } from './_define'
import { NOW } from './_time'

const appliance = (id: number, name: string, type: string, addonId: string) => ({
  id,
  stableId: `appliance-${id}`,
  addonId,
  type,
  name,
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
  metadata: { manufacturer: 'Example', model: `${type}-1` },
})

const DEVICES: Readonly<Record<number, ReturnType<typeof appliance>>> = {
  501: appliance(501, 'Kitchen dishwasher', 'dishwasher', 'bosch-home-connect'),
  502: appliance(502, 'Robot vacuum', 'vacuum', 'provider-dreame'),
  503: appliance(503, 'Utility dishwasher', 'dishwasher', 'bosch-home-connect'),
  504: appliance(504, 'Mopping robot', 'vacuum', 'provider-dreame'),
  5063: {
    ...appliance(5063, 'Pet feeder', 'pet-feeder', 'provider-petkit'),
    location: '',
  },
  5064: appliance(5064, 'Pet feeder (consumables)', 'pet-feeder', 'provider-petkit'),
  // A fountain BUILT from loose entities (a composed device of type pet-fountain).
  5065: appliance(5065, 'Water fountain', 'pet-fountain', 'composer'),
  521: {
    ...appliance(521, 'Living room AC', 'climate', 'provider-homeassistant'),
    location: 'Living room',
  },
  522: {
    ...appliance(522, 'Bedroom AC', 'climate', 'provider-homeassistant'),
    location: 'Bedroom',
  },
  510: appliance(510, 'Filter life', 'sensor', 'provider-homeassistant'),
  511: appliance(511, 'Hall sensor', 'sensor', 'provider-homeassistant'),
  513: {
    ...appliance(513, 'Zigbee hub', 'container', 'provider-homeassistant'),
    location: 'Kitchen',
  },
  512: {
    ...appliance(512, 'Cupboard sensor', 'sensor', 'provider-homeassistant'),
    location: 'Kitchen',
    parentDeviceId: 513,
  },
  // Children named after their container (D356): the container's own list
  // shows them without the "Zigbee hub" prefix.
  514: {
    ...appliance(514, 'Zigbee hub - Door contact', 'sensor', 'provider-homeassistant'),
    parentDeviceId: 513,
  },
  515: {
    ...appliance(515, 'ZIGBEE HUB: Window contact', 'sensor', 'provider-homeassistant'),
    parentDeviceId: 513,
  },
}

const entry = (capName: string, nativeAddonId: string) => ({
  capName,
  kind: 'native',
  providerAddonId: nativeAddonId,
  providerNodeId: 'hub',
  nativeAddonId,
})

const BINDINGS: Readonly<Record<number, readonly ReturnType<typeof entry>[]>> = {
  501: [
    entry('device-status', 'bosch-home-connect'),
    entry('dishwasher', 'bosch-home-connect'),
    entry('consumables', 'bosch-home-connect'),
    entry('running-state', 'bosch-home-connect'),
  ],
  503: [
    entry('device-status', 'bosch-home-connect'),
    entry('dishwasher', 'bosch-home-connect'),
    entry('consumables', 'bosch-home-connect'),
    entry('running-state', 'bosch-home-connect'),
  ],
  504: [
    entry('device-status', 'provider-dreame'),
    entry('vacuum-control', 'provider-dreame'),
    entry('consumables', 'provider-dreame'),
  ],
  502: [
    entry('device-status', 'provider-dreame'),
    entry('vacuum-control', 'provider-dreame'),
    entry('consumables', 'provider-dreame'),
    entry('running-state', 'provider-dreame'),
  ],
  // 5063 is the feeder as the hub reports it today: no `consumables` binding.
  // 5064 is the same feeder once its provider registers the cap.
  5063: [entry('device-status', 'provider-petkit'), entry('pet-feeder', 'provider-petkit')],
  5064: [
    entry('device-status', 'provider-petkit'),
    entry('pet-feeder', 'provider-petkit'),
    entry('consumables', 'provider-petkit'),
  ],
  5065: [
    entry('device-status', 'composer'),
    entry('pet-fountain', 'composer'),
    entry('consumables', 'composer'),
  ],
  521: [
    entry('device-status', 'provider-homeassistant'),
    entry('climate-control', 'provider-homeassistant'),
  ],
  522: [
    entry('device-status', 'provider-homeassistant'),
    entry('climate-control', 'provider-homeassistant'),
  ],
  510: [entry('numeric-sensor', 'provider-homeassistant')],
  511: [
    entry('numeric-sensor', 'provider-homeassistant'),
    entry('battery', 'provider-homeassistant'),
  ],
  512: [entry('battery', 'provider-homeassistant')],
  513: [],
}

const DISHWASHER = {
  availability: 'available',
  state: 'idle',
  operationState: 'Ready',
  program: null,
  selectedProgram: 'Dishcare.Dishwasher.Program.Eco50',
  availablePrograms: ['Dishcare.Dishwasher.Program.Eco50', 'Dishcare.Dishwasher.Program.Quick65'],
  remaining: 12_600,
  delayedStart: 0,
  progress: 0,
  doorOpen: false,
  doorLocked: false,
  remoteStartAllowed: true,
  remoteControlActive: true,
  localControlActive: null,
  powerOn: true,
  powerState: 'On',
  halfLoad: false,
  hygienePlus: false,
  extraDry: true,
  intensiveZone: null,
  varioSpeedPlus: false,
  childLock: false,
  activeEvents: ['Dishcare.Dishwasher.Event.SaltNearlyEmpty'],
  errorCode: null,
  errorLabel: null,
  lastFetchedAt: NOW,
}

const supply = (key: string, label: string, status: string | null, form: string) => ({
  key,
  label,
  level: null,
  status,
  kind: 'supply',
  form,
  lastResetAt: null,
  resettable: false,
})

const DISHWASHER_CONSUMABLES = {
  items: [
    supply('salt', 'Salt', 'low', 'product'),
    supply('rinseAid', 'Rinse aid', 'ok', 'product'),
  ],
  lastChangedAt: NOW,
}

/** Every item ok: the section starts COLLAPSED with "All OK". */
const DISHWASHER_CONSUMABLES_OK = {
  items: [
    supply('salt', 'Salt', 'ok', 'product'),
    supply('rinseAid', 'Rinse aid', 'ok', 'product'),
  ],
  lastChangedAt: NOW,
}

/** Tanks, a bin and a product with known fills: every non-part form on screen. */
const TANK_CONSUMABLES = {
  items: [
    { ...supply('cleanWater', 'Clean water tank', null, 'tank'), level: 65 },
    {
      key: 'dirtyWater',
      label: 'Dirty water tank',
      level: 90,
      status: null,
      kind: 'waste',
      form: 'tank',
      lastResetAt: null,
      resettable: false,
    },
    {
      key: 'dustBin',
      label: 'Dust bin',
      level: 30,
      status: null,
      kind: 'waste',
      form: 'bin',
      lastResetAt: null,
      resettable: false,
    },
    supply('detergent', 'Detergent', 'empty', 'product'),
  ],
  lastChangedAt: NOW,
}

const CONSUMABLES = {
  items: [
    {
      key: 'main-brush',
      label: 'Main brush',
      level: 72,
      status: null,
      lastResetAt: NOW - 40 * 86_400_000,
      resettable: true,
    },
    {
      key: 'filter',
      label: 'Filter',
      level: null,
      status: 'replace',
      lastResetAt: null,
      resettable: true,
    },
    {
      key: 'mop-pad',
      label: 'Mop pad',
      level: null,
      status: null,
      lastResetAt: null,
      resettable: false,
    },
    supply('cleanWater', 'Clean water tank', 'low', 'tank'),
    {
      key: 'dirtyWater',
      label: 'Dirty water tank',
      level: null,
      status: 'ok',
      kind: 'waste',
      form: 'tank',
      lastResetAt: null,
      resettable: false,
    },
    supply('detergent', 'Detergent', null, 'product'),
    {
      key: 'dustBin',
      label: 'Dust bin',
      level: 40,
      status: null,
      kind: 'waste',
      form: 'bin',
      lastResetAt: null,
      resettable: false,
    },
  ],
  lastChangedAt: NOW,
}

const VACUUM = {
  state: 'docked',
  batteryLevel: 100,
  fanSpeed: 'standard',
  availableFanSpeeds: ['quiet', 'standard', 'strong'],
  progress: null,
  errorCode: null,
  errorLabel: null,
  lastChangedAt: NOW,
}

const PET_FEEDER = {
  foodLevel: 120,
  // The bowl is a mass in kilograms (D944): 22 g.
  bowlFood: 0.022,
  eating: false,
  food1: null,
  food2: null,
  lowFood: false,
  batteryPower: 88,
  desiccantLeftDays: 12 * 86_400,
  feeding: false,
  status: 'normal',
  error: null,
  errorCode: null,
  isDualHopper: false,
  childLock: false,
  indicatorLight: true,
  feedSound: true,
  volume: 3,
  lastFetchedAt: NOW,
}

const FEEDER_CONSUMABLES = {
  items: [
    {
      key: 'desiccant',
      label: 'Desiccant',
      level: 40,
      status: null,
      kind: 'wear',
      form: 'part',
      lastResetAt: null,
      resettable: true,
    },
  ],
  lastChangedAt: NOW,
}

const PET_FOUNTAIN = {
  waterLevel: 64,
  waterVolume: 1.3,
  empty: false,
  pumpRunning: true,
  pumpIntervalEnabled: true,
  pumpOnTime: 10 * 60,
  pumpOffTime: 20 * 60,
  lastDrink: 0.032,
  currentHourDrink: 0.085,
  last24hDrink: 0.61,
  todayDrink: 0.42,
  error: null,
  lastFetchedAt: NOW,
}

/** The fountain's filter: a wear part, resettable through the forwarded button. */
const FOUNTAIN_CONSUMABLES = {
  items: [
    {
      key: 'filter',
      label: 'Filter',
      level: 35,
      status: null,
      kind: 'wear',
      form: 'part',
      lastResetAt: NOW - 20 * 86_400_000,
      resettable: true,
    },
  ],
  lastChangedAt: NOW,
}

/** Climate hero: 521 shows an integer target, 522 a .5 target (5-30 step 0.5). */
const CLIMATE = {
  mode: 'cool',
  availableModes: ['off', 'cool', 'heat', 'auto', 'fan_only', 'dry'],
  fanMode: 'auto',
  availableFanModes: ['auto', 'low', 'medium', 'high'],
  preset: 'custom',
  availablePresets: ['none', 'eco', 'sleep', 'turbo', 'custom'],
  target: 21,
  targetHigh: null,
  targetLow: null,
  targetHumidity: null,
  currentTemp: 23,
  currentHumidity: 48,
  swingVertical: null,
  swingHorizontal: null,
  minTemp: 5,
  maxTemp: 30,
  tempStep: 0.5,
  lastFetchedAt: NOW,
}

const SLICES: Readonly<Record<string, unknown>> = {
  '521/device-status': { online: true, lastChangedAt: NOW },
  '521/climate-control': CLIMATE,
  '522/device-status': { online: true, lastChangedAt: NOW },
  '522/climate-control': { ...CLIMATE, target: 21.5 },
  '5063/device-status': { online: true, lastChangedAt: NOW },
  '5063/pet-feeder': PET_FEEDER,
  '5064/device-status': { online: true, lastChangedAt: NOW },
  '5064/pet-feeder': PET_FEEDER,
  '5064/consumables': FEEDER_CONSUMABLES,
  '5065/device-status': { online: true, lastChangedAt: NOW },
  '5065/pet-fountain': PET_FOUNTAIN,
  '5065/consumables': FOUNTAIN_CONSUMABLES,
  '501/device-status': { online: true, lastChangedAt: NOW },
  '501/dishwasher': DISHWASHER,
  '501/consumables': DISHWASHER_CONSUMABLES,
  '503/device-status': { online: true, lastChangedAt: NOW },
  '503/dishwasher': { ...DISHWASHER, activeEvents: [] },
  '503/consumables': DISHWASHER_CONSUMABLES_OK,
  '504/device-status': { online: true, lastChangedAt: NOW },
  '504/vacuum-control': VACUUM,
  '504/consumables': TANK_CONSUMABLES,
  '502/device-status': { online: true, lastChangedAt: NOW },
  '502/vacuum-control': VACUUM,
  '502/consumables': CONSUMABLES,
  '501/running-state': {
    running: true,
    since: NOW - 42 * 60_000,
    source: 'native',
    phase: 'Eco',
    lastFetchedAt: NOW,
  },
  '502/running-state': {
    running: false,
    since: NOW - 60_000,
    source: 'native',
    phase: null,
    lastFetchedAt: NOW,
  },
  '503/running-state': {
    running: null,
    since: null,
    source: 'native',
    phase: null,
    lastFetchedAt: null,
  },
  '512/battery': { level: 82, lastFetchedAt: NOW },
}

const WIREABLE: Readonly<Record<number, unknown>> = {
  501: {
    caps: [
      {
        cap: 'dishwasher',
        fields: [{ path: 'remaining', kind: 'number' }],
      },
      {
        cap: 'consumables',
        fields: [{ path: 'level', kind: 'number', item: true }],
        itemArray: { path: 'items', keyField: 'key' },
      },
    ],
  },
  502: {
    caps: [
      {
        cap: 'consumables',
        fields: [{ path: 'level', kind: 'number', item: true }],
        itemArray: { path: 'items', keyField: 'key' },
      },
    ],
  },
  510: {
    caps: [{ cap: 'numeric-sensor', fields: [{ path: 'value', kind: 'number' }] }],
  },
  512: {
    caps: [{ cap: 'battery', fields: [{ path: 'level', kind: 'number' }] }],
  },
}

const FILTER_SOURCE = {
  addonId: 'provider-homeassistant',
  stableId: 'appliance-510',
}
const expr = (text: string) => ({
  kind: 'expression' as const,
  expr: text,
  bindings: {},
})
const FILTER_VIEW = {
  block: {
    id: 'blk-dishwasher-filter',
    name: 'customize:dishwasher-501',
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
        target: {
          kind: 'existing',
          device: { addonId: 'bosch-home-connect', stableId: 'appliance-501' },
        },
        features: [
          {
            kind: 'fields',
            cap: 'consumables',
            fields: { lastChangedAt: expr('now'), lastFetchedAt: expr('now') },
            items: {
              filter: {
                label: 'Filter',
                fields: {
                  level: {
                    kind: 'from',
                    source: FILTER_SOURCE,
                    cap: 'numeric-sensor',
                    fieldPath: 'value',
                  },
                  kind: expr('"wear"'),
                  form: expr('"part"'),
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

const consumablesSection = (writerAddonId: string) => ({
  id: 'consumables-widget',
  title: 'Consumables',
  tab: 'consumables',
  location: 'hero',
  columns: 1,
  order: 5,
  fields: [
    {
      type: 'widget',
      key: '_consumables',
      label: 'Consumables',
      widgetId: 'host/consumables-panel',
      span: 1,
      source: 'settings',
      writerCapName: 'consumables',
      writerAddonId,
    },
  ],
})

const aggregateFor = (deviceId: number) => ({
  settings: {
    tabs: [],
    sections:
      deviceId === 502 || deviceId === 504
        ? [consumablesSection('provider-dreame')]
        : deviceId === 501 || deviceId === 503
          ? [consumablesSection('bosch-home-connect')]
          : deviceId === 5064
            ? [consumablesSection('provider-petkit')]
            : deviceId === 5065
              ? [consumablesSection('composer')]
              : [],
  },
  live: { sections: [] },
  tabs: undefined,
  deviceId,
})

export default defineFixtures({
  area: 'appliances',
  description: 'A dishwasher and a robot vacuum with consumables (pills, Customize defaults)',
  handlers: {
    'deviceManager.getDevice': (i: { deviceId: number }) => DEVICES[i.deviceId] ?? null,
    'deviceManager.listAll': Object.values(DEVICES),
    'deviceManager.getDeviceAggregate': (i: { deviceId: number }) => aggregateFor(i.deviceId),
    'deviceManager.getBindings': (i: { deviceId: number }) => ({
      deviceId: i.deviceId,
      entries: (BINDINGS[i.deviceId] ?? []).map((b) => ({ ...b })),
    }),
    'deviceManager.getWireableFields': (i: { deviceId: number }) =>
      WIREABLE[i.deviceId] ?? { caps: [] },
    'deviceManager.listBindableCapsForDeviceType': [],
    'deviceManager.getChildren': (i: { parentDeviceId: number }) =>
      Object.values(DEVICES).filter((d) => d.parentDeviceId === i.parentDeviceId),
    'deviceManager.listSiteZones': [],
    'deviceState.getCapSlice': (i: { deviceId: number; capName: string }) =>
      SLICES[`${i.deviceId}/${i.capName}`] ?? null,
    'coreBlocks.getCustomization': (input: { stableId?: string }) =>
      input.stableId === 'appliance-501'
        ? { state: 'loaded', view: FILTER_VIEW }
        : { state: 'loaded', view: null },
    'deviceState.getSnapshot': (input: { deviceId: number }) => {
      if (input.deviceId === 510) return { 'numeric-sensor': { value: 40 } }
      if (input.deviceId === 512) return { battery: { level: 82 } }
      return null
    },
    'deviceManager.listDeviceIdsByCaps': (input: { capNames: readonly string[] }) => {
      const cap = input.capNames[0]
      if (cap === undefined) return []
      const ids: number[] = []
      for (const [deviceId, entries] of Object.entries(BINDINGS)) {
        if (entries.some((row) => row.capName === cap)) ids.push(Number(deviceId))
      }
      return ids
    },
    'coreBlocks.listComposableCaps': (i: { deviceType: string }) => ({
      caps:
        i.deviceType === 'dishwasher'
          ? [{ cap: 'battery' }, { cap: 'consumables' }, { cap: 'running-state' }]
          : i.deviceType === 'vacuum'
            ? [{ cap: 'running-state' }]
            : i.deviceType === 'sensor'
              ? [{ cap: 'battery' }]
              : [],
    }),
    'deviceExtension.listSlots': [],
    'deviceExtension.listCandidates': { candidates: [] },
    'capabilities.getCapability': {
      name: 'composer',
      mode: 'singleton',
      providers: ['composer'],
      activeProvider: 'composer',
      disabledProviders: [],
    },
    'notificationRules.listDeviceMutes': { mutedDeviceIds: [] },
    'integrations.list': [],
    'auth.listLoginMethods': [],
  },
})
