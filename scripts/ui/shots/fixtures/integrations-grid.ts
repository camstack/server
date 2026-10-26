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

export default defineFixtures({
  area: 'integrations-grid',
  description: 'Integrations page grid: Reolink running with two cameras, ONVIF disabled',
  handlers: {
    'integrations.list': [
      integration('int-reolink', 'provider-reolink', 'Reolink', true, 'running'),
      integration('int-onvif', 'provider-onvif', 'ONVIF', false, 'stopped'),
      integration('int-ha', 'provider-homeassistant', 'Home Assistant', true, 'running'),
    ],
    'deviceManager.listAll': [
      device(101, 'Front door', 'provider-reolink', 'int-reolink'),
      device(102, 'Driveway', 'provider-reolink', 'int-reolink'),
    ],
  },
})
