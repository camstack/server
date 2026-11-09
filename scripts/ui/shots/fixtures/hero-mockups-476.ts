/**
 * Planning#476 mockups (heat pump + energy system): the device catalogue the Customize
 * picker reads (`deviceManager.listAll`). Invented, deterministic; the real hero parts
 * are composed in `harness/hero-476-preview.tsx`.
 */
import { defineFixtures } from './_define'

const device = (
  id: number,
  name: string,
  type: string,
  features: readonly string[],
  extra: Readonly<Record<string, unknown>> = {},
) => ({ id, name, type, features, online: true, location: null, ...extra })

export default defineFixtures({
  area: 'hero-476',
  description: 'Device catalogue for the heat-pump link picker of the energy-system mockup',
  handlers: {
    'deviceManager.listAll': [
      device(2300, 'Bosch Compress CS5800iAW', 'container', []),
      device(2301, 'Pompa di calore', 'heater', ['heat-pump'], { parentDeviceId: 2300 }),
      device(2302, 'Circuito 1', 'thermostat', ['climate-control'], { parentDeviceId: 2300 }),
      device(2310, 'Pompa di calore piscina', 'heater', ['heat-pump'], { location: 'Giardino' }),
      device(2320, 'Boiler elettrico', 'water_heater', ['water-heater']),
      device(2330, 'Wallbox garage', 'switch', ['switch', 'power-meter']),
    ],
  },
})
