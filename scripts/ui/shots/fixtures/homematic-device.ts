/**
 * A Homematic CCU device's own page with the addon's device panel widget.
 * `--fixtures homematic-ccu,homematic-device --route "/devices/950"` — the
 * widget's custom actions answer from `homematic-ccu`.
 */
import { defineFixtures } from './_define'

const DEVICE = {
  id: 950,
  stableId: 'homematic:hm_1:00315F298E5093',
  addonId: 'provider-homematic',
  type: 'container',
  name: 'Bagno',
  location: 'Bagno',
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: false,
  config: { address: '00315F298E5093', integrationId: 'hm_1' },
  secretConfigPaths: [],
  metadata: {},
}

const PANEL_WIDGET = {
  tab: 'device-tab',
  label: 'Homematic device',
  kind: 'remote',
  remote: {
    remoteName: 'addon_provider_homematic_widgets',
    exposedModule: './widgets',
    componentKey: 'device-panel',
  },
  preAuth: false,
  stableId: 'device-panel',
  description: 'CCU values, diagnostics, manual actuation and MASTER configuration of one device.',
  icon: 'plug',
  bundle: 'widgets/remoteEntry.js',
  hosts: ['device-tab'],
  requires: { deviceContext: true, integrationContext: false },
  defaultSize: 'xl',
  allowedSizes: ['lg', 'xl'],
  defaultColumns: 12,
  defaultRows: 4,
  addonId: 'provider-homematic',
  bundleUrl: '/api/addon-widgets/provider-homematic/widgets/remoteEntry.js',
}

/** The section `HmContainerDevice.getSettingsUISchema()` returns (`hm-device-panel-section.ts`). */
const PANEL_SECTION = {
  id: 'homematic-device',
  title: 'Homematic',
  tab: 'general',
  order: 5,
  columns: 1,
  fields: [
    {
      type: 'widget',
      key: '_homematicDevicePanel',
      label: '',
      widgetId: 'provider-homematic/device-panel',
      widgetConfig: { integrationId: 'hm_1', address: '00315F298E5093' },
    },
  ],
}

export default defineFixtures({
  area: 'homematic-device',
  description: 'Homematic CCU device page with the device panel widget',
  handlers: {
    'deviceManager.listAll': [DEVICE],
    'deviceManager.getDevice': (input: { deviceId?: number }) =>
      input.deviceId === 950 ? DEVICE : null,
    'deviceManager.getDeviceAggregate': {
      settings: { tabs: [], sections: [PANEL_SECTION] },
      live: { sections: [] },
      deviceId: 950,
    },
    'deviceManager.getBindings': { deviceId: 950, entries: [] },
    'addonWidgets.listWidgets': [PANEL_WIDGET],
    'deviceManager.getChildren': [],
    'powerSource.getStatus': { linked: false },
  },
})
