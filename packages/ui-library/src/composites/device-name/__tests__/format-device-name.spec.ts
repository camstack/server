/**
 * Ten device shapes, both locales.
 * A wrong short noun ("Sensore di movimento" beside a container already
 * called "Sensore movimento") fails here.
 */
import { describe, expect, it } from 'vitest'
import { deviceNameNouns } from '../device-name-nouns'
import {
  type DeviceNameFields,
  type DeviceNameForm,
  formatDeviceName,
  stripDeviceParentPrefix,
} from '../format-device-name'

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
  id: 201,
  name: 'Porch motion sensor',
  type: 'container',
  stableId: 'p201',
  parentDeviceId: null,
})
const motion = row({
  id: 202,
  name: 'Motion',
  type: 'sensor',
  role: 'motion-sensor',
  parentDeviceId: 201,
  stableId: 'm202',
  location: 'Porch',
})
const battery = row({
  id: 203,
  name: 'Battery',
  type: 'sensor',
  role: 'battery-sensor',
  parentDeviceId: 201,
  stableId: 'b203',
})
const illumination = row({
  id: 204,
  name: 'Illumination',
  type: 'sensor',
  role: 'ambient-light-sensor',
  parentDeviceId: 201,
  stableId: 'i204',
})
const update = row({
  id: 205,
  name: 'Update',
  type: 'update',
  parentDeviceId: 201,
  stableId: 'u205',
})
const motionFamily = [motion, battery, illumination, update]

const robot = row({
  id: 211,
  name: 'Garden robot',
  type: 'container',
  stableId: 'r211',
  parentDeviceId: null,
})
const vacuum = row({
  id: 212,
  name: 'Garden robot',
  type: 'vacuum',
  parentDeviceId: 211,
  stableId: 'v212',
})
const robotCamera = row({
  id: 213,
  name: 'Garden robot Camera',
  type: 'camera',
  parentDeviceId: 211,
  stableId: 'c213',
})
const robotSwitch = row({
  id: 214,
  name: 'Garden robot ch1',
  type: 'switch',
  parentDeviceId: 211,
  stableId: 's214',
})
const robotFamily = [vacuum, robotCamera, robotSwitch]

const switchParent = row({
  id: 221,
  name: 'Porch light switch',
  type: 'container',
  stableId: 'p221',
  parentDeviceId: null,
})
const terraceLights = row({
  id: 222,
  name: 'Porch lights',
  type: 'switch',
  parentDeviceId: 221,
  stableId: 'c222',
})

const windowParent = row({
  id: 231,
  name: 'Porch window contact',
  type: 'container',
  stableId: 'w231',
  parentDeviceId: null,
})
const temperature = row({
  id: 232,
  name: 'Temperatura',
  type: 'sensor',
  role: 'temperature-sensor',
  parentDeviceId: 231,
  stableId: 't232',
})
const contact = row({
  id: 233,
  name: 'Porch window contact',
  type: 'sensor',
  role: 'contact-sensor',
  parentDeviceId: 231,
  stableId: 'c233',
})
const windowBattery = row({
  id: 234,
  name: 'Batteria',
  type: 'sensor',
  role: 'battery-sensor',
  parentDeviceId: 231,
  stableId: 'b234',
})
const lastSeen = row({
  id: 235,
  name: 'Last seen',
  type: 'sensor',
  role: 'datetime-sensor',
  parentDeviceId: 231,
  stableId: 'l235',
})
const identify = row({
  id: 236,
  name: 'Identifica',
  type: 'button',
  parentDeviceId: 231,
  stableId: 'i236',
})
const windowFamily = [temperature, contact, windowBattery, lastSeen, identify]

const porchCamera = row({
  id: 101,
  name: 'Porch camera',
  type: 'camera',
  stableId: 'cam101',
  parentDeviceId: null,
})
const siren = row({
  id: 102,
  name: 'Porch camera Siren',
  type: 'siren',
  parentDeviceId: 101,
  stableId: 'sir102',
})

const climateParent = row({
  id: 241,
  name: 'Bedroom climate unit',
  type: 'container',
  stableId: 'ac241',
  parentDeviceId: null,
  primaryChildEntityId: 'climate242',
})
const climate = row({
  id: 242,
  name: 'Bedroom climate unit',
  type: 'climate',
  parentDeviceId: 241,
  stableId: 'climate242',
})
const climateLight = row({
  id: 243,
  name: 'Light',
  type: 'light',
  parentDeviceId: 241,
  stableId: 'l243',
})
const climateFamily = [climate, climateLight]

const gateway = row({
  id: 251,
  name: 'Weather station',
  type: 'container',
  stableId: 'e251',
  parentDeviceId: null,
})
const gatewayChild = row({
  id: 252,
  name: 'Weather station — gateway',
  type: 'container',
  parentDeviceId: 251,
  stableId: 'g252',
})
const weather = row({
  id: 253,
  name: 'Weather station — outdoor',
  type: 'weather',
  parentDeviceId: 251,
  stableId: 'w253',
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
  202: {
    id: 202,
    compact: 'Porch motion sensor',
    full: 'Porch motion sensor · Movimento',
    nested: 'Movimento',
  },
  203: {
    id: 203,
    compact: 'Porch motion sensor · Batteria',
    full: 'Porch motion sensor · Batteria',
    nested: 'Batteria',
  },
  213: {
    id: 213,
    compact: 'Garden robot · Telecamera',
    full: 'Garden robot · Telecamera',
    nested: 'Telecamera',
  },
  212: {
    id: 212,
    compact: 'Garden robot',
    full: 'Garden robot',
    nested: 'Aspirapolvere',
  },
  222: {
    id: 222,
    compact: 'Porch light switch',
    full: 'Porch light switch · Porch lights',
    nested: 'Porch lights',
  },
  232: {
    id: 232,
    compact: 'Porch window contact · Temperatura',
    full: 'Porch window contact · Temperatura',
    nested: 'Temperatura',
  },
  233: {
    id: 233,
    compact: 'Porch window contact',
    full: 'Porch window contact',
    nested: 'Contatto',
  },
  102: {
    id: 102,
    compact: 'Porch camera · Sirena',
    full: 'Porch camera · Sirena',
    nested: 'Sirena',
  },
  242: {
    id: 242,
    compact: 'Bedroom climate unit',
    full: 'Bedroom climate unit',
    nested: 'Condizionatore',
  },
  252: {
    id: 252,
    compact: 'Weather station · gateway',
    full: 'Weather station · gateway',
    nested: 'gateway',
  },
}

const EN: Record<number, NameCase> = {
  202: {
    id: 202,
    compact: 'Porch motion sensor',
    full: 'Porch motion sensor · Motion',
    nested: 'Motion',
  },
  203: {
    id: 203,
    compact: 'Porch motion sensor · Battery',
    full: 'Porch motion sensor · Battery',
    nested: 'Battery',
  },
  213: {
    id: 213,
    compact: 'Garden robot · Camera',
    full: 'Garden robot · Camera',
    nested: 'Camera',
  },
  212: {
    id: 212,
    compact: 'Garden robot',
    full: 'Garden robot',
    nested: 'Vacuum',
  },
  222: IT[222]!,
  232: {
    id: 232,
    compact: 'Porch window contact · Temperature',
    full: 'Porch window contact · Temperature',
    nested: 'Temperature',
  },
  233: {
    id: 233,
    compact: 'Porch window contact',
    full: 'Porch window contact',
    nested: 'Contact',
  },
  102: {
    id: 102,
    compact: 'Porch camera · Siren',
    full: 'Porch camera · Siren',
    nested: 'Siren',
  },
  242: {
    id: 242,
    compact: 'Bedroom climate unit',
    full: 'Bedroom climate unit',
    nested: 'Climate',
  },
  252: IT[252]!,
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
    expect(label(BOUNDS[0]!, 'with-location', 'it')).toBe('Porch motion sensor · Porch')
  })

  it('a top-level camera keeps its stored name in every form', () => {
    const nouns = deviceNameNouns('it')
    const context = { parent: null, siblings: [] }
    for (const form of ['compact', 'full', 'nested', 'with-location'] as const) {
      expect(formatDeviceName(porchCamera, form, context, nouns)).toBe('Porch camera')
    }
  })

  it('an operator caption wins over the stock noun', () => {
    const captioned = { ...motion, display: { label: 'Hall' } }
    const nouns = deviceNameNouns('it')
    expect(
      formatDeviceName(
        captioned,
        'nested',
        { parent: motionParent, siblings: motionFamily },
        nouns,
      ),
    ).toBe('Hall')
    expect(
      formatDeviceName(captioned, 'full', { parent: motionParent, siblings: motionFamily }, nouns),
    ).toBe('Porch motion sensor · Hall')
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

describe('stripDeviceParentPrefix separators', () => {
  it.each([
    ['Zigbee hub - Door contact', 'Door contact'],
    ['Zigbee hub: Door contact', 'Door contact'],
    ['Zigbee hub \u2014 Door contact', 'Door contact'],
    ['ZIGBEE HUB: Window contact', 'Window contact'],
    ['Zigbee hub Door contact', 'Door contact'],
  ])('%s -> %s', (name, expected) => {
    expect(stripDeviceParentPrefix(name, 'Zigbee hub')).toBe(expected)
  })

  it('leaves a name that is not prefixed by the parent', () => {
    expect(stripDeviceParentPrefix('Zigbee hubble', 'Zigbee hub')).toBe('Zigbee hubble')
  })
})
