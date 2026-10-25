/**
 * Validator rules for the Range / Mode extras (D869): capabilityResources,
 * configuration and semantics, as Amazon states them.
 */
import { describe, expect, it } from 'vitest'
import { buildGenericDeviceEndpoint } from '../endpoints/generic-device.js'
import type { AlexaCapability, AlexaEndpoint } from '../endpoints/types.js'
import { validateAlexaEndpoint } from '../endpoints/validate-endpoint.js'

function blind(): AlexaEndpoint {
  const e = buildGenericDeviceEndpoint({
    deviceId: 9,
    stableId: 's',
    name: 'Tapparella',
    type: 'cover',
    capNames: ['cover'],
    role: 'cover-blind',
    features: ['cover-positionable'],
  })
  if (e === null) throw new Error('fixture did not build')
  return e
}

function withRange(patch: (c: AlexaCapability) => AlexaCapability): AlexaEndpoint {
  const e = blind()
  return {
    ...e,
    capabilities: e.capabilities.map((c) =>
      c.interface === 'Alexa.RangeController' ? patch(c) : c,
    ),
  }
}

const rules = (e: AlexaEndpoint): string =>
  validateAlexaEndpoint(e)
    .map((v) => v.rule)
    .join(' | ')

describe('RangeController / ModeController rules', () => {
  it('the shapes this addon builds are valid', () => {
    expect(validateAlexaEndpoint(blind())).toEqual([])
  })

  it('a RangeController without a supported range or with precision 0', () => {
    expect(rules(withRange((c) => ({ ...c, configuration: {} })))).toMatch(/supportedRange/)
    expect(
      rules(
        withRange((c) => ({
          ...c,
          configuration: { supportedRange: { minimumValue: 0, maximumValue: 100, precision: 0 } },
        })),
      ),
    ).toMatch(/supportedRange/)
  })

  it('a unit that is not an Alexa.Unit value', () => {
    expect(
      rules(
        withRange((c) => ({
          ...c,
          configuration: { ...c.configuration, unitOfMeasure: 'percent' },
        })),
      ),
    ).toMatch(/unitOfMeasure/)
  })

  it('a friendly name that is neither a global asset nor a localized text', () => {
    expect(
      rules(
        withRange((c) => ({
          ...c,
          capabilityResources: {
            friendlyNames: [{ '@type': 'asset', value: { assetId: 'Opening' } }],
          },
        })),
      ),
    ).toMatch(/not an Alexa global asset/)
    expect(
      rules(
        withRange((c) => ({
          ...c,
          capabilityResources: {
            friendlyNames: [{ '@type': 'text', value: { text: 'Tilt', locale: 'english' } }],
          },
        })),
      ),
    ).toMatch(/language-COUNTRY/)
  })

  it('properties must be exactly rangeValue', () => {
    expect(
      rules(
        withRange((c) => ({
          ...c,
          properties: {
            supported: [{ name: 'mode' }],
            proactivelyReported: true,
            retrievable: true,
          },
        })),
      ),
    ).toMatch(/exactly \[rangeValue\]/)
  })

  it('semantics: an unknown action, a twice-mapped action, a bad directive, a value out of range', () => {
    const mapping = (actions: string[], name: string, payload: Record<string, unknown>) => ({
      '@type': 'ActionsToDirective' as const,
      actions,
      directive: { name, payload },
    })
    const withActions = (actionMappings: AlexaCapability['semantics']) =>
      rules(withRange((c) => ({ ...c, semantics: actionMappings })))
    expect(
      withActions({
        actionMappings: [mapping(['Alexa.Actions.Fly'], 'SetRangeValue', { rangeValue: 1 })],
      }),
    ).toMatch(/not a documented Alexa action/)
    expect(
      withActions({
        actionMappings: [
          mapping(['Alexa.Actions.Open'], 'SetRangeValue', { rangeValue: 100 }),
          mapping(['Alexa.Actions.Open'], 'SetRangeValue', { rangeValue: 90 }),
        ],
      }),
    ).toMatch(/mapped twice/)
    expect(
      withActions({ actionMappings: [mapping(['Alexa.Actions.Open'], 'SetMode', { mode: 'x' })] }),
    ).toMatch(/not valid for Alexa.RangeController/)
    expect(
      withActions({
        actionMappings: [mapping(['Alexa.Actions.Open'], 'SetRangeValue', { rangeValue: 250 })],
      }),
    ).toMatch(/inside supportedRange/)
    expect(
      withActions({
        actionMappings: [
          mapping(['Alexa.Actions.Lower'], 'AdjustRangeValue', { rangeValueDelta: -10 }),
        ],
      }),
    ).toMatch(/rangeValueDeltaDefault/)
  })

  it('semantics: a state mapped outside the range, or an unknown state', () => {
    expect(
      rules(
        withRange((c) => ({
          ...c,
          semantics: {
            stateMappings: [
              {
                '@type': 'StatesToRange',
                states: ['Alexa.States.Open'],
                range: { minimumValue: 1, maximumValue: 200 },
              },
            ],
          },
        })),
      ),
    ).toMatch(/StatesToRange range must sit inside supportedRange/)
    expect(
      rules(
        withRange((c) => ({
          ...c,
          semantics: {
            stateMappings: [{ '@type': 'StatesToValue', states: ['Alexa.States.Ajar'], value: 0 }],
          },
        })),
      ),
    ).toMatch(/not a documented Alexa state/)
  })

  it('a ModeController needs ordered, named modes and a semantic mode it declares', () => {
    const e = buildGenericDeviceEndpoint({
      deviceId: 9,
      stableId: 's',
      name: 'x',
      type: 'cover',
      capNames: ['cover'],
      role: 'cover-blind',
      features: [],
    })
    if (e === null) throw new Error('fixture did not build')
    const patch = (fn: (c: AlexaCapability) => AlexaCapability): string =>
      rules({
        ...e,
        capabilities: e.capabilities.map((c) =>
          c.interface === 'Alexa.ModeController' ? fn(c) : c,
        ),
      })
    expect(validateAlexaEndpoint(e)).toEqual([])
    expect(
      patch((c) => ({
        ...c,
        configuration: { supportedModes: c.configuration?.['supportedModes'] },
      })),
    ).toMatch(/ordered must be a boolean/)
    expect(
      patch((c) => ({
        ...c,
        configuration: {
          ordered: false,
          supportedModes: [{ value: 'State.Open' }, { value: 'State.Closed' }],
        },
      })),
    ).toMatch(/modeResources.friendlyNames is required/)
    expect(
      patch((c) => ({
        ...c,
        semantics: {
          actionMappings: [
            {
              '@type': 'ActionsToDirective',
              actions: ['Alexa.Actions.Open'],
              directive: { name: 'SetMode', payload: { mode: 'State.Ajar' } },
            },
          ],
        },
      })),
    ).toMatch(/mode must be one of supportedModes/)
  })

  it('the blind display categories are Amazon values', () => {
    expect(rules({ ...blind(), displayCategories: ['INTERIOR_BLIND', 'EXTERIOR_BLIND'] })).toBe('')
    expect(rules({ ...blind(), displayCategories: ['BLIND'] as never })).toMatch(
      /not an Amazon value/,
    )
  })
})
