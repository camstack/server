/**
 * Connectivity > Exporters with a HomeKit exporter selected: the device export
 * table (devices, plus the actions and notification targets the exporter
 * supports). Names are invented.
 */
import { defineFixtures } from './_define'

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
    'deviceManager.listAll': [camera(1, 'Garden cam'), camera(2, 'Gate cam')],
    'deviceExport.getStatus': { linkState: 'linked', exposedDeviceCount: 1 },
    'deviceExport.listSupportedDeviceKinds': ['camera'],
    'deviceExport.listExposedDevices': [{ deviceId: '1', exposedAs: 'Garden cam' }],
    'deviceExport.listSupportedEntityKinds': ['device', 'action'],
    'deviceExport.listExposedEntities': [
      { entity: { kind: 'action', actionId: 'internal:a' }, exposedAs: 'Open gate' },
    ],
    'actions.list': [
      { id: 'internal:a', name: 'Open gate' },
      { id: 'internal:b', name: 'Arm night mode' },
    ],
    'notificationOutput.listTargets': [
      { id: 'tg:1', name: 'Phone', kind: 'push', addonId: 'notifier-x', enabled: true, config: {} },
    ],
  },
})
