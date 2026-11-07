/**
 * Connectivity > Exporters with the Home Assistant exporter selected: actions
 * AND notification targets are supported, so the type filter carries both.
 * Names are invented.
 */
import { defineFixtures } from './_define'
import { notificationInstanceHandlers } from './_notification-instances'

export default defineFixtures({
  area: 'device-export-ha-multi',
  description: 'Exporters section: Home Assistant export with two brokers, one disabled',
  handlers: {
    'addons.list': [
      {
        manifest: {
          id: 'homeassistant-export',
          name: 'Home Assistant Export',
          packageDisplayName: 'Home Assistant Export',
          capabilities: ['device-export'],
        },
        process: { state: 'running' },
      },
    ],
    'deviceManager.listAll': [
      {
        id: 1,
        stableId: 'reolink:cam1',
        addonId: 'provider-reolink',
        type: 'camera',
        name: 'Garden cam',
        online: true,
        disabled: false,
        parentDeviceId: null,
      },
    ],
    'deviceExport.getStatus': { linkState: 'linked', exposedDeviceCount: 1 },
    'deviceExport.listSupportedDeviceKinds': ['camera'],
    'deviceExport.listInstances': [
      { instanceId: 'ha_002', name: 'Cabin', enabled: false },
      { instanceId: 'ha_001', name: 'Home', enabled: true },
    ],
    'deviceExport.listExposedDevices': [{ deviceId: '1', exposedAs: 'Garden cam' }],
    'deviceExport.listSupportedEntityKinds': ['device', 'action', 'notifier'],
    'deviceExport.listExposedEntities': [
      { entity: { kind: 'notifier', targetId: 'tg:1' }, exposedAs: 'Phone' },
    ],
    'actions.list': [{ id: 'internal:a', name: 'Open gate' }],
    ...notificationInstanceHandlers([
      { id: 'tg:1', name: 'Phone', kind: 'push', addonId: 'notifier-x', enabled: true, config: {} },
      {
        id: 'tg:2',
        name: 'Family chat',
        kind: 'chat',
        addonId: 'notifier-y',
        enabled: true,
        config: {},
      },
    ]),
  },
})
