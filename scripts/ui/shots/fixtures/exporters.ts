/**
 * Connectivity -> Exporters as one instances table (`/system/integrations?tab=exporters`):
 * the HA export and the HomeKit bridge keep records (rows), Alexa and Google are still fixed
 * rows. The Devices column opens the exported devices in a dialog. Invented data.
 */
import { defineFixtures } from './_define'

const FORM = {
  sections: [
    {
      id: 'target',
      title: 'Target',
      columns: 2,
      fields: [{ type: 'text', key: 'label', label: 'Label', default: '' }],
    },
  ],
}

const INSTANCES: Readonly<Record<string, readonly unknown[]>> = {
  'homeassistant-export': [
    {
      id: 'hae_001',
      name: 'Home',
      configured: true,
      formValues: { label: 'Home' },
      status: { state: 'ok', label: 'Linked' },
    },
    { id: 'hae_002', name: 'Cabin', configured: false, formValues: { label: 'Cabin' } },
  ],
  'export-hap': [
    {
      id: 'export-hap',
      name: 'Camstack bridge',
      configured: true,
      formValues: { label: 'Bridge' },
    },
  ],
}

export default defineFixtures({
  area: 'exporters',
  description: 'Exporters as instance rows and fixed rows, with the Devices column and dialog',
  handlers: {
    'addons.listCapabilityProviders': (i: { capName: string }) => {
      if (i.capName === 'device-export') {
        return ['export-alexa', 'export-google', 'export-hap', 'homeassistant-export'].map(
          (addonId) => ({ addonId, capName: i.capName, isActive: true }),
        )
      }
      if (i.capName === 'integration-instances') {
        return ['homeassistant-export', 'export-hap'].map((addonId) => ({
          addonId,
          capName: i.capName,
          isActive: true,
        }))
      }
      return []
    },
    'integrationInstances.describe': (i: { addonId: string }) => ({
      instanceMode: 'multiple',
      kind: i.addonId === 'export-hap' ? 'bridge' : 'target',
      canTest: false,
    }),
    'integrationInstances.instanceFormSchema': FORM,
    'integrationInstances.listInstances': (i: { addonId: string }) => INSTANCES[i.addonId] ?? [],
    'deviceExport.getStatus': (i: { addonId: string; instanceId?: string }) => ({
      linkState: 'linked',
      exposedDeviceCount: i.instanceId === 'hae_001' ? 16 : i.addonId === 'export-alexa' ? 3 : 1,
      ...(i.addonId === 'export-hap'
        ? {
            setup: {
              note: 'Scan with the Home app',
              fields: [{ label: 'Setup code', value: '123-45-678' }],
            },
          }
        : {}),
    }),
    'deviceExport.listInstances': (i: { addonId: string }) =>
      (INSTANCES[i.addonId] ?? [{ id: i.addonId, name: i.addonId }]).map((r) => ({
        instanceId: (r as { id: string }).id,
        name: (r as { name: string }).name,
        enabled: true,
      })),
    'deviceExport.listSupportedDeviceKinds': ['camera'],
    'deviceExport.listSupportedEntityKinds': ['device'],
    'deviceExport.listExposedEntities': [],
    'notificationOutput.listTargets': [],
    'deviceExport.listExposedDevices': [
      { deviceId: '1', exposedAs: 'Garden cam' },
      { deviceId: '2', exposedAs: 'Porch cam' },
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
      {
        id: 2,
        stableId: 'reolink:cam2',
        addonId: 'provider-reolink',
        type: 'camera',
        name: 'Porch cam',
        online: true,
        disabled: false,
        parentDeviceId: null,
      },
    ],
  },
})
