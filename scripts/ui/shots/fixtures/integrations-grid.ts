/**
 * Integrations list (`/integrations`) in the card grid: two invented
 * integrations so the grid card's icon column, status and device count
 * are on screen. The page remembers the grid in localStorage; the shot
 * clicks the Grid segment (`--step click:[data-testid=integrations-view-grid]`).
 */
import { defineFixtures } from './_define'
import { NOW } from './_time'

const integration = (
  id: string,
  addonId: string,
  name: string,
  enabled: boolean,
  processState: string,
) => ({
  id,
  addonId,
  name,
  enabled,
  info: {},
  createdAt: NOW - 30 * 86_400_000,
  updatedAt: NOW - 86_400_000,
  processState,
})

const device = (id: number, name: string, addonId: string, integrationId: string) => ({
  id,
  stableId: `dev-${id}`,
  addonId,
  integrationId,
  type: 'camera',
  name,
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: true,
  config: {},
  secretConfigPaths: [],
  metadata: {},
})

const availableType = (addonId: string, name: string) => ({
  addonId,
  name,
  description: '',
  iconUrl: null,
  color: '',
  instanceMode: 'multi',
  mode: 'standalone',
  discoveryMode: 'manual',
  kind: 'device-provider',
  brokerKind: null,
  supportsLocationImport: false,
})

const INTEGRATIONS = [
  integration('int-reolink', 'provider-reolink', 'Reolink', true, 'running'),
  integration('int-onvif', 'provider-onvif', 'ONVIF', false, 'stopped'),
  integration('int-ha', 'provider-homeassistant', 'Home Assistant', true, 'running'),
  integration('int-wyze', 'provider-wyze', 'Casa', true, 'running'),
  integration('int-wyze2', 'provider-wyze', 'Garage', true, 'running'),
  integration('int-bosch', 'bosch-home-connect', 'Casa', true, 'running'),
  integration('int-shc', 'bosch-shc', 'Casa', true, 'stopped'),
  integration('int-blocks', 'core-blocks', 'Blocks', true, 'running'),
  integration('int-grids', 'camera-grid', 'Camera grids', true, 'running'),
]

/** One `addons.list` row: the package the addon ships in decides Providers vs System. */
const installedAddon = (id: string, name: string, packageName: string) => ({
  manifest: {
    id,
    name,
    version: '1.2.3',
    packageName,
    packageVersion: '1.2.3',
    capabilities: [],
  },
  source: 'installed',
  installSource: 'npm',
  process: { pid: 4100, mode: 'forked', state: 'running' },
  hasBackup: false,
  health: null,
})

const ADDONS = [
  installedAddon('provider-reolink', 'Reolink', '@camstack/addon-provider-reolink'),
  installedAddon('provider-onvif', 'ONVIF', '@camstack/addon-provider-onvif'),
  installedAddon(
    'provider-homeassistant',
    'Home Assistant',
    '@camstack/addon-provider-homeassistant',
  ),
  installedAddon('provider-wyze', 'Wyze', '@camstack/addon-provider-wyze'),
  installedAddon('bosch-home-connect', 'Bosch Home Connect', '@camstack/addon-bosch-home-connect'),
  installedAddon('bosch-shc', 'Bosch Smart Home Controller', '@camstack/addon-bosch-shc'),
  installedAddon('core-blocks', 'Core Blocks', '@camstack/system'),
  installedAddon('camera-grid', 'Camera Grid', '@camstack/system'),
]

export default defineFixtures({
  area: 'integrations-grid',
  description: 'Integrations page grid: Reolink running with two cameras, ONVIF disabled',
  handlers: {
    'integrations.list': INTEGRATIONS,
    'integrations.get': (input: { id?: string }) =>
      INTEGRATIONS.find((i) => i.id === input.id) ?? null,
    'addons.list': ADDONS,
    'integrations.getAvailableTypes': [
      availableType('provider-reolink', 'Reolink'),
      availableType('provider-onvif', 'ONVIF'),
      availableType('provider-homeassistant', 'Home Assistant'),
      availableType('provider-wyze', 'Wyze'),
      availableType('bosch-home-connect', 'Bosch Home Connect'),
      availableType('bosch-shc', 'Bosch Smart Home Controller'),
      availableType('core-blocks', 'Core Blocks'),
      availableType('camera-grid', 'Camera Grid'),
    ],
    'deviceManager.listAll': [
      device(101, 'Front door', 'provider-reolink', 'int-reolink'),
      device(102, 'Driveway', 'provider-reolink', 'int-reolink'),
      device(103, 'Living room', 'provider-wyze', 'int-wyze'),
      device(104, 'Kitchen', 'provider-wyze', 'int-wyze'),
      device(105, 'Garage door', 'provider-wyze', 'int-wyze2'),
      device(106, 'Driveway composite', 'composer', 'int-blocks'),
    ],
  },
})
