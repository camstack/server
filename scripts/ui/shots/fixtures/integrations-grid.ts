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
]

export default defineFixtures({
  area: 'integrations-grid',
  description: 'Integrations page grid: Reolink running with two cameras, ONVIF disabled',
  handlers: {
    'integrations.list': INTEGRATIONS,
    'integrations.get': (input: { id?: string }) =>
      INTEGRATIONS.find((i) => i.id === input.id) ?? null,
    'integrations.getAvailableTypes': [
      availableType('provider-reolink', 'Reolink'),
      availableType('provider-onvif', 'ONVIF'),
      availableType('provider-homeassistant', 'Home Assistant'),
      availableType('provider-wyze', 'Wyze'),
      availableType('bosch-home-connect', 'Bosch Home Connect'),
      availableType('bosch-shc', 'Bosch Smart Home Controller'),
    ],
    'deviceManager.listAll': [
      device(101, 'Front door', 'provider-reolink', 'int-reolink'),
      device(102, 'Driveway', 'provider-reolink', 'int-reolink'),
      device(103, 'Living room', 'provider-wyze', 'int-wyze'),
      device(104, 'Kitchen', 'provider-wyze', 'int-wyze'),
      device(105, 'Garage door', 'provider-wyze', 'int-wyze2'),
    ],
  },
})
