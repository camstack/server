/**
 * Connectivity > Exporters with a HomeKit exporter selected: the device export
 * table (devices, plus the actions and notification targets the exporter
 * supports). Names are invented.
 */
import { defineFixtures } from './_define'
import { notificationInstanceHandlers } from './_notification-instances'

const camera = (id: number, name: string) => ({
  id,
  stableId: `reolink:cam${id}`,
  addonId: 'provider-reolink',
  type: 'camera',
  name,
  online: true,
  disabled: false,
  parentDeviceId: null,
})

export default defineFixtures({
  area: 'device-export',
  description: 'Exporters section: the device export table with actions and notifiers',
  handlers: {
    'addons.list': [
      {
        manifest: {
          id: 'export-hap',
          name: 'HomeKit Export',
          packageDisplayName: 'HomeKit Export',
          capabilities: ['device-export'],
        },
        process: { state: 'running' },
      },
    ],
    'integrations.list': [
      { id: 'int_0001', addonId: 'provider-reolink', name: 'Reolink', enabled: true },
      { id: 'int_0002', addonId: 'provider-tuya', name: 'Tuya', enabled: true },
    ],
    'deviceManager.listAll': [
      { ...camera(1, 'Garden cam'), integrationId: 'int_0001' },
      { ...camera(2, 'Gate cam'), integrationId: 'int_0001', role: 'doorbell' },
      { ...camera(3, 'Hall cam'), addonId: 'provider-tuya', integrationId: 'int_0002' },
    ],
    'deviceExport.getStatus': { linkState: 'linked', exposedDeviceCount: 1 },
    'deviceExport.listSupportedDeviceKinds': ['camera'],
    'deviceExport.listInstances': [{ instanceId: 'export-hap', name: 'Instance', enabled: true }],
    'deviceExport.listExposedDevices': [{ deviceId: '1', exposedAs: 'Garden cam' }],
    'deviceExport.listSupportedEntityKinds': ['device', 'action'],
    'deviceExport.listExposedEntities': [
      { entity: { kind: 'action', actionId: 'internal:a' }, exposedAs: 'Open gate' },
    ],
    'actions.list': [
      { id: 'internal:a', name: 'Open gate' },
      { id: 'internal:b', name: 'Arm night mode' },
    ],
    ...notificationInstanceHandlers([
      { id: 'tg:1', name: 'Phone', kind: 'push', addonId: 'notifier-x', enabled: true, config: {} },
    ]),
  },
})
