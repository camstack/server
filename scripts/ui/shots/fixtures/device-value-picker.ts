/**
 * `deviceManager.search` for the device → value picker preview: temperature
 * sensors in three rooms, one weather station with four values, a Z-Wave
 * plug. Invented.
 */
import { defineFixtures } from './_define'

interface Value {
  readonly cap: string
  readonly path: string
  readonly label: string
  readonly reading: string | null
}
const temp = (reading: string): Value => ({
  cap: 'temperature-sensor',
  path: 'temperature',
  label: 'Temperature',
  reading,
})

function dev(
  id: number,
  name: string,
  type: string,
  location: string,
  integrationId: string,
  integrationLabel: string,
  values: readonly Value[],
  online = true,
) {
  return {
    id,
    name,
    type,
    location,
    integrationId,
    integrationLabel,
    online,
    disabled: false,
    compatible: true,
    values,
  }
}

const FLEET = [
  dev(1, 'Kitchen', 'climate_sensor', 'Ground floor', 'hue', 'Hue', [temp('22.3 °C')]),
  dev(3, 'Bathroom', 'climate_sensor', 'Ground floor', 'hue', 'Hue', [temp('23.1 °C')]),
  dev(4, 'Garage', 'climate_sensor', 'Ground floor', 'zwave', 'Z-Wave', [temp('9.8 °C')]),
  dev(5, 'Bedroom', 'climate_sensor', 'First floor', 'hue', 'Hue', [temp('19.4 °C')]),
  dev(6, 'Freezer', 'plug', 'Ground floor', 'zwave', 'Z-Wave', [temp('-18.2 °C')], false),
  dev(7, 'Study', 'climate_sensor', 'First floor', 'hue', 'Hue', [temp('20.6 °C')]),
  dev(2, 'Weather station', 'weather_station', 'Garden', 'mqtt', 'MQTT', [
    temp('14.0 °C'),
    { cap: 'temperature-sensor', path: 'humidity', label: 'Humidity', reading: '62 %' },
    { cap: 'temperature-sensor', path: 'dewPoint', label: 'Dew point', reading: '7.1 °C' },
    { cap: 'temperature-sensor', path: 'feelsLike', label: 'Feels like', reading: '12.5 °C' },
  ]),
]

function count<T>(items: readonly T[], key: (i: T) => string): Map<string, number> {
  const out = new Map<string, number>()
  for (const i of items) out.set(key(i), (out.get(key(i)) ?? 0) + 1)
  return out
}

export default defineFixtures({
  area: 'device-value-picker',
  description: 'deviceManager.search over a small invented fleet of temperature sources',
  handlers: {
    'deviceManager.search': (input: { ids?: number[]; text?: string }) => {
      if (input.ids !== undefined) {
        return {
          items: FLEET.filter((d) => input.ids?.includes(d.id)),
          nextCursor: null,
          total: input.ids.length,
          compatibleTotal: input.ids.length,
          fleetTotal: 64,
          hiddenIncompatible: 0,
          facets: { locations: [], integrations: [], types: [] },
          suggested: [],
          missingIds: input.ids.filter((id) => !FLEET.some((d) => d.id === id)),
        }
      }
      const text = (input.text ?? '').toLowerCase()
      const items = FLEET.filter((d) => d.name.toLowerCase().includes(text))
      return {
        items,
        nextCursor: null,
        total: items.length,
        compatibleTotal: items.length,
        fleetTotal: 64,
        hiddenIncompatible: 57,
        facets: {
          locations: [...count(FLEET, (d) => d.location)].map(([value, n]) => ({ value, count: n })),
          integrations: [...count(FLEET, (d) => d.integrationId)].map(([id, n]) => ({
            id,
            label: FLEET.find((d) => d.integrationId === id)?.integrationLabel ?? id,
            count: n,
          })),
          types: [...count(FLEET, (d) => d.type)].map(([value, n]) => ({ value, count: n })),
        },
        suggested: items.filter((d) => d.location === 'Ground floor' && d.id !== 1).slice(0, 2),
        missingIds: [],
      }
    },
  },
})
