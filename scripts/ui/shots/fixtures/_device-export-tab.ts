/**
 * The device Export tab of camera 101 "Driveway", exposed to Alexa and to one HomeKit bridge
 * (D1049). `before`: the Alexa panel with its own hand-written "Alexa name" field and the HomeKit
 * panel with no name. `after`: one derived "Name on <instance>" field per exposing instance, as
 * `device-manager` adds it from the `device-export` cap. Load first, before `camera`. Invented data.
 */
import cameraArea from './camera'

const writer = (addonId: string) => ({
  writerCapName: 'device-export',
  writerAddonId: addonId,
  source: 'settings',
})

const nameField = (addonId: string, instanceId: string, platform: string, value: string) => ({
  type: 'text',
  key: `export-name:${addonId}:${instanceId}`,
  label: `Name on ${platform}`,
  description:
    'What this platform calls the device. Leave empty to use the device name. Renaming updates the same device there; it is never added again.',
  placeholder: 'Device name',
  value,
  ...writer(addonId),
})

const alexaSection = (named: 'legacy' | 'derived') => ({
  id: 'export-alexa',
  title: 'Alexa',
  tab: 'export',
  order: 10,
  fields: [
    ...(named === 'derived'
      ? [nameField('export-alexa', 'export-alexa', 'Alexa', 'Vialetto')]
      : []),
    {
      type: 'boolean',
      key: 'alexa:101:enabled',
      label: 'Expose to Alexa',
      value: true,
      ...writer('export-alexa'),
    },
    ...(named === 'legacy'
      ? [
          {
            type: 'text',
            key: 'alexa:101:alexaName',
            label: 'Alexa name',
            description:
              'What Alexa calls this device. Leave empty to use the device name. Letters, digits and spaces only (no punctuation), up to 256 characters. Renaming updates the same Alexa device; it does not create a duplicate.',
            value: 'Vialetto',
            ...writer('export-alexa'),
          },
        ]
      : []),
  ],
})

const hapSection = (named: 'legacy' | 'derived') => ({
  id: 'device-export-hap',
  title: 'HomeKit',
  tab: 'export',
  order: 20,
  fields: [
    ...(named === 'derived' ? [nameField('export-hap', 'export-hap', 'Home bridge', '')] : []),
    {
      type: 'boolean',
      key: 'hap:101:enabled',
      label: 'Expose to HomeKit',
      value: true,
      ...writer('export-hap'),
    },
  ],
})

type Aggregate = {
  settings: { sections: readonly unknown[] } & Record<string, unknown>
} & Record<string, unknown>

function isAggregate(value: unknown): value is Aggregate {
  if (value === null || typeof value !== 'object' || !('settings' in value)) return false
  const settings = value.settings
  return settings !== null && typeof settings === 'object' && 'sections' in settings
}

export function exportTabHandlers(named: 'legacy' | 'derived'): Record<string, unknown> {
  const base = cameraArea.handlers['deviceManager.getDeviceAggregate']
  return {
    'deviceManager.getDeviceAggregate': (input: { deviceId: number }) => {
      const answer: unknown = typeof base === 'function' ? base(input) : base
      if (!isAggregate(answer)) return answer
      return {
        ...answer,
        settings: {
          ...answer.settings,
          sections: [...answer.settings.sections, alexaSection(named), hapSection(named)],
        },
      }
    },
  }
}
