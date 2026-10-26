/**
 * The ten devices from the operator's hub (2026-10-26), both locales.
 * A wrong short noun ("Sensore di movimento" beside a container already
 * called "Sensore movimento") fails here.
 */
import { describe, expect, it } from 'vitest'
import { deviceNameNouns } from '../device-name-nouns'
import { type DeviceNameFields, type DeviceNameForm, formatDeviceName } from '../format-device-name'

interface NameCase {
  readonly id: number
  readonly compact: string
  readonly full: string
  readonly nested: string
}

function row(partial: DeviceNameFields): DeviceNameFields {
  return partial
}

const motionParent = row({
  id: 3297,
  name: 'Sensore movimento veranda',
  type: 'container',
  stableId: 'p3297',
  parentDeviceId: null,
})
const motion = row({
  id: 3299,
  name: 'Motion',
  type: 'sensor',
  role: 'motion-sensor',
  parentDeviceId: 3297,
  stableId: 'm3299',
  location: 'Veranda',
})
const battery = row({
  id: 3298,
  name: 'Battery',
  type: 'sensor',
  role: 'battery-sensor',
  parentDeviceId: 3297,
  stableId: 'b3298',
})
const illumination = row({
  id: 3300,
  name: 'Illumination',
  type: 'sensor',
  role: 'ambient-light-sensor',
  parentDeviceId: 3297,
  stableId: 'i3300',
})
const update = row({
  id: 3301,
  name: 'Update',
  type: 'update',
  parentDeviceId: 3297,
  stableId: 'u3301',
})
const motionFamily = [motion, battery, illumination, update]

const robot = row({
  id: 4384,
  name: 'Robot piano terra',
  type: 'container',
  stableId: 'r4384',
  parentDeviceId: null,
})
const vacuum = row({
  id: 4385,
  name: 'Robot piano terra',
  type: 'vacuum',
  parentDeviceId: 4384,
  stableId: 'v4385',
})
const robotCamera = row({
  id: 4878,
  name: 'Robot piano terra Camera',
  type: 'camera',
  parentDeviceId: 4384,
  stableId: 'c4878',
})
const robotSwitch = row({
  id: 4879,
  name: 'Robot piano terra ch1',
  type: 'switch',
  parentDeviceId: 4384,
  stableId: 's4879',
})
const robotFamily = [vacuum, robotCamera, robotSwitch]

const switchParent = row({
  id: 3395,
  name: 'Switch luci terrazza terra',
  type: 'container',
  stableId: 'p3395',
  parentDeviceId: null,
})
const terraceLights = row({
  id: 3396,
  name: 'Luci terrazza terra',
  type: 'switch',
  parentDeviceId: 3395,
  stableId: 'c3396',
})

const windowParent = row({
  id: 3239,
  name: 'Sensore contatto finestra veranda',
  type: 'container',
  stableId: 'w3239',
  parentDeviceId: null,
})
const temperature = row({
  id: 3241,
  name: 'Temperatura',
  type: 'sensor',
  role: 'temperature-sensor',
  parentDeviceId: 3239,
  stableId: 't3241',
})
const contact = row({
  id: 3243,
  name: 'Sensore contatto finestra veranda',
  type: 'sensor',
  role: 'contact-sensor',
  parentDeviceId: 3239,
  stableId: 'c3243',
})
const windowBattery = row({
  id: 3242,
  name: 'Batteria',
  type: 'sensor',
  role: 'battery-sensor',
  parentDeviceId: 3239,
  stableId: 'b3242',
})
const lastSeen = row({
  id: 3244,
  name: 'Last seen',
  type: 'sensor',
  role: 'datetime-sensor',
  parentDeviceId: 3239,
  stableId: 'l3244',
})
const identify = row({
  id: 3245,
  name: 'Identifica',
  type: 'button',
  parentDeviceId: 3239,
  stableId: 'i3245',
})
const windowFamily = [temperature, contact, windowBattery, lastSeen, identify]

const porchCamera = row({
  id: 584,
  name: 'Videocamera veranda',
  type: 'camera',
  stableId: 'cam584',
  parentDeviceId: null,
})
const siren = row({
  id: 585,
  name: 'Videocamera veranda Siren',
  type: 'siren',
  parentDeviceId: 584,
  stableId: 'sir585',
})

const climateParent = row({
  id: 554,
  name: 'Climatizzatore camera Daniel',
  type: 'container',
  stableId: 'ac554',
  parentDeviceId: null,
  primaryChildEntityId: 'climate555',
})
const climate = row({
  id: 555,
  name: 'Climatizzatore camera Daniel',
  type: 'climate',
  parentDeviceId: 554,
  stableId: 'climate555',
})
const climateLight = row({
  id: 556,
  name: 'Light',
  type: 'light',
  parentDeviceId: 554,
  stableId: 'l556',
})
const climateFamily = [climate, climateLight]

const gateway = row({
  id: 289,
  name: 'Ecowitt Gateway',
  type: 'container',
  stableId: 'e289',
  parentDeviceId: null,
})
const gatewayChild = row({
  id: 290,
  name: 'Ecowitt Gateway — gateway',
  type: 'container',
  parentDeviceId: 289,
  stableId: 'g290',
})
const weather = row({
  id: 291,
  name: 'Ecowitt Gateway — outdoor',
  type: 'weather',
  parentDeviceId: 289,
  stableId: 'w291',
})
const gatewayFamily = [gatewayChild, weather]

interface Bound {
  readonly device: DeviceNameFields
  readonly parent: DeviceNameFields | null
  readonly siblings: readonly DeviceNameFields[]
}

function bind(
  device: DeviceNameFields,
  parent: DeviceNameFields | null,
  siblings: readonly DeviceNameFields[],
): Bound {
  return { device, parent, siblings }
}

const IT: Record<number, NameCase> = {
  3299: {
    id: 3299,
    compact: 'Sensore movimento veranda',
    full: 'Sensore movimento veranda · Movimento',
    nested: 'Movimento',
  },
  3298: {
    id: 3298,
    compact: 'Sensore movimento veranda · Batteria',
    full: 'Sensore movimento veranda · Batteria',
    nested: 'Batteria',
  },
  4878: {
    id: 4878,
    compact: 'Robot piano terra · Telecamera',
    full: 'Robot piano terra · Telecamera',
    nested: 'Telecamera',
  },
  4385: {
    id: 4385,
    compact: 'Robot piano terra',
    full: 'Robot piano terra',
    nested: 'Aspirapolvere',
  },
  3396: {
    id: 3396,
    compact: 'Switch luci terrazza terra',
    full: 'Switch luci terrazza terra · Luci terrazza terra',
    nested: 'Luci terrazza terra',
  },
  3241: {
    id: 3241,
    compact: 'Sensore contatto finestra veranda · Temperatura',
    full: 'Sensore contatto finestra veranda · Temperatura',
    nested: 'Temperatura',
  },
  3243: {
    id: 3243,
    compact: 'Sensore contatto finestra veranda',
    full: 'Sensore contatto finestra veranda',
    nested: 'Contatto',
  },
  585: {
    id: 585,
    compact: 'Videocamera veranda · Sirena',
    full: 'Videocamera veranda · Sirena',
    nested: 'Sirena',
  },
  555: {
    id: 555,
    compact: 'Climatizzatore camera Daniel',
    full: 'Climatizzatore camera Daniel',
    nested: 'Condizionatore',
  },
  290: {
    id: 290,
    compact: 'Ecowitt Gateway · gateway',
    full: 'Ecowitt Gateway · gateway',
    nested: 'gateway',
  },
}

const EN: Record<number, NameCase> = {
  3299: {
    id: 3299,
    compact: 'Sensore movimento veranda',
    full: 'Sensore movimento veranda · Motion',
    nested: 'Motion',
  },
  3298: {
    id: 3298,
    compact: 'Sensore movimento veranda · Battery',
    full: 'Sensore movimento veranda · Battery',
    nested: 'Battery',
  },
  4878: {
    id: 4878,
    compact: 'Robot piano terra · Camera',
    full: 'Robot piano terra · Camera',
    nested: 'Camera',
  },
  4385: {
    id: 4385,
    compact: 'Robot piano terra',
    full: 'Robot piano terra',
    nested: 'Vacuum',
  },
  3396: IT[3396]!,
  3241: {
    id: 3241,
    compact: 'Sensore contatto finestra veranda · Temperature',
    full: 'Sensore contatto finestra veranda · Temperature',
    nested: 'Temperature',
  },
  3243: {
    id: 3243,
    compact: 'Sensore contatto finestra veranda',
    full: 'Sensore contatto finestra veranda',
    nested: 'Contact',
  },
  585: {
    id: 585,
    compact: 'Videocamera veranda · Siren',
    full: 'Videocamera veranda · Siren',
    nested: 'Siren',
  },
  555: {
    id: 555,
    compact: 'Climatizzatore camera Daniel',
    full: 'Climatizzatore camera Daniel',
    nested: 'Climate',
  },
  290: IT[290]!,
}

const BOUNDS: readonly Bound[] = [
  bind(motion, motionParent, motionFamily),
  bind(battery, motionParent, motionFamily),
  bind(robotCamera, robot, robotFamily),
  bind(vacuum, robot, robotFamily),
  bind(terraceLights, switchParent, [terraceLights]),
  bind(temperature, windowParent, windowFamily),
  bind(contact, windowParent, windowFamily),
  bind(siren, porchCamera, [siren]),
  bind(climate, climateParent, climateFamily),
  bind(gatewayChild, gateway, gatewayFamily),
]

function label(bound: Bound, form: DeviceNameForm, locale: 'en' | 'it'): string {
  return formatDeviceName(
    bound.device,
    form,
    { parent: bound.parent, siblings: bound.siblings },
    deviceNameNouns(locale),
  )
}

describe('formatDeviceName — hub examples', () => {
  for (const locale of ['it', 'en'] as const) {
    const expected = locale === 'it' ? IT : EN
    describe(locale, () => {
      for (const bound of BOUNDS) {
        const want = expected[bound.device.id]
        if (want === undefined) throw new Error(`missing expected for ${bound.device.id}`)
        it(`${bound.device.id} ${bound.device.name}`, () => {
          expect(label(bound, 'compact', locale)).toBe(want.compact)
          expect(label(bound, 'full', locale)).toBe(want.full)
          expect(label(bound, 'nested', locale)).toBe(want.nested)
        })
      }
    })
  }

  it('with-location on the motion sensor appends the room', () => {
    expect(label(BOUNDS[0]!, 'with-location', 'it')).toBe('Sensore movimento veranda · Veranda')
  })

  it('a top-level camera keeps its stored name in every form', () => {
    const nouns = deviceNameNouns('it')
    const context = { parent: null, siblings: [] }
    for (const form of ['compact', 'full', 'nested', 'with-location'] as const) {
      expect(formatDeviceName(porchCamera, form, context, nouns)).toBe('Videocamera veranda')
    }
  })

  it('an operator caption wins over the stock noun', () => {
    const captioned = { ...motion, display: { label: 'Sala' } }
    const nouns = deviceNameNouns('it')
    expect(
      formatDeviceName(
        captioned,
        'nested',
        { parent: motionParent, siblings: motionFamily },
        nouns,
      ),
    ).toBe('Sala')
    expect(
      formatDeviceName(captioned, 'full', { parent: motionParent, siblings: motionFamily }, nouns),
    ).toBe('Sensore movimento veranda · Sala')
  })

  it('userNamed keeps a stock word as the noun', () => {
    const named = { ...motion, userNamed: true }
    expect(
      formatDeviceName(
        named,
        'nested',
        { parent: motionParent, siblings: motionFamily },
        deviceNameNouns('it'),
      ),
    ).toBe('Motion')
  })
})
