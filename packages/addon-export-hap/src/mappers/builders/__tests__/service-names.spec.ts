/**
 * The pure half of the service-naming fix.
 *
 * Two independent things go wrong with a HomeKit service label, and only one
 * of them was ever noticed:
 *
 *  1. It reaches only `Name`, which is read-only and cached by the controller
 *     at first enumeration, so no later value ever shows. That is
 *     `service-naming.spec.ts`.
 *  2. It is not a HAP-valid string, or it carries no reference to the device
 *     it belongs to. That is this file.
 *
 * `isHapServiceName` mirrors hap-nodejs' own `checkName` regex, so a label
 * this module returns can never trip the second warning family either.
 */
import { describe, expect, it } from 'vitest'

import {
  childServiceName,
  HAP_NAME_MAX_LENGTH,
  hapServiceName,
  isHapServiceName,
  privacyServiceName,
  ptzServiceName,
} from '../service-names.js'

describe('isHapServiceName', () => {
  it('accepts an ordinary operator name', () => {
    expect(isHapServiceName('Camera kitchen')).toBe(true)
    expect(isHapServiceName("Camera d'ingresso 2")).toBe(true)
  })

  it('rejects the shapes HAP-NodeJS warns about', () => {
    // The em-dash form a previous round shipped, and iOS discarded.
    expect(isHapServiceName('Camera kitchen — Sirena')).toBe(false)
    expect(isHapServiceName(' Sirena')).toBe(false)
    expect(isHapServiceName('Sirena ')).toBe(false)
    expect(isHapServiceName('Sirena!')).toBe(false)
    expect(isHapServiceName('X')).toBe(false)
    expect(isHapServiceName('')).toBe(false)
  })
})

describe('hapServiceName', () => {
  it('joins device-derived parts into one valid label', () => {
    expect(hapServiceName(['Camera kitchen', 'Privacy'], 'Privacy')).toBe('Camera kitchen Privacy')
  })

  it('drops empty and absent parts rather than emitting double spaces', () => {
    expect(hapServiceName(['Camera kitchen', null, '', undefined], 'Privacy')).toBe(
      'Camera kitchen',
    )
  })

  it('strips the characters HAP rejects instead of passing them through', () => {
    expect(hapServiceName(['Camera — kitchen', 'Privacy'], 'Privacy')).toBe(
      'Camera kitchen Privacy',
    )
  })

  it('never returns something HAP would reject', () => {
    for (const raw of ['—', '***', ' ', 'X']) {
      const name = hapServiceName([raw], 'Privacy')
      expect(isHapServiceName(name), `input ${JSON.stringify(raw)} -> ${name}`).toBe(true)
    }
  })

  it('falls back only when nothing device-derived survives', () => {
    expect(hapServiceName(['—'], 'Privacy')).toBe('Privacy')
  })

  it('truncates to the HAP length ceiling without ending on a separator', () => {
    const long = `${'Camera '.repeat(10)}kitchen`
    const name = hapServiceName([long, 'Privacy'], 'Privacy')
    expect(name.length).toBeLessThanOrEqual(HAP_NAME_MAX_LENGTH)
    expect(isHapServiceName(name)).toBe(true)
  })
})

describe('privacyServiceName', () => {
  it('is just the function, with no camera prefix', () => {
    // The switch is published on the camera's OWN accessory. Prefixing the
    // camera name put "Camera kitchen Privacy" inside a tile already
    // titled "Camera kitchen".
    expect(privacyServiceName()).toBe('Privacy')
  })
})

describe('childServiceName', () => {
  it("prefers the child's OWN operator-given name over the English role slug", () => {
    // The operator named this device in Italian. Title-casing `role` threw
    // that away and rendered every siren on the fleet as "Siren".
    expect(childServiceName('Camera kitchen', { name: 'Sirena', role: 'siren' })).toBe('Sirena')
  })

  it('strips the camera name a provider prefixed onto the child', () => {
    // Providers name children both ways; the published label must be one form.
    expect(
      childServiceName('Camera kitchen', {
        name: 'Camera kitchen Sirena',
        role: 'siren',
      }),
    ).toBe('Sirena')
  })

  it('leaves the camera name alone when it is not a PREFIX', () => {
    // Cutting from the middle of a string the operator typed would mangle it.
    expect(childServiceName('kitchen', { name: 'Sirena della kitchen', role: 'siren' })).toBe(
      'Sirena della kitchen',
    )
  })

  it('never strips a child down to nothing', () => {
    expect(childServiceName('Camera kitchen', { name: 'Camera kitchen', role: null })).toBe(
      'Camera kitchen',
    )
  })

  it('falls back to the role only when the child carries no usable name', () => {
    expect(childServiceName('Camera kitchen', { name: '', role: 'floodlight' })).toBe('Floodlight')
  })

  it('falls back to a generic word, NOT the camera name, when neither is usable', () => {
    // The camera name here would publish a service indistinguishable from the
    // accessory holding it — the exact defect this module keeps fixing.
    expect(childServiceName('Camera kitchen', { name: '', role: null })).toBe('Accessory')
  })
})

describe('ptzServiceName', () => {
  it('is the bare action, with no camera prefix', () => {
    expect(ptzServiceName('Preset front door')).toBe('Preset front door')
    expect(ptzServiceName('Autotrack')).toBe('Autotrack')
  })

  it('still sanitises an operator-typed preset name', () => {
    expect(ptzServiceName('Preset — front door')).toBe('Preset front door')
  })
})
