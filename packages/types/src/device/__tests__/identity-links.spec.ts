/**
 * Identity links (D1063): the kind table, the id, and the provenance stamp a
 * contributed Customize feature carries.
 */
import { describe, expect, it } from 'vitest'
import { CompositionSchema } from '../../composition/composition.js'
import { DeviceRole } from '../device-type.js'
import { IDENTITY_LINK_KINDS, identityLinkId, identityLinkSidesRefusal } from '../identity-links.js'

const PORT = { addonId: 'provider-unifi', stableId: 'port-7' }
const CAMERA = { addonId: 'provider-hikvision', stableId: 'cam-1' }

describe('identity link kinds', () => {
  it('a poe-power link whose attaching side is not a PoE port is refused', () => {
    expect(identityLinkSidesRefusal('poe-power', 'switch-light')).toBe('attaching-side-role')
    expect(identityLinkSidesRefusal('poe-power', null)).toBe('attaching-side-role')
    expect(identityLinkSidesRefusal('poe-power', DeviceRole.PoePort)).toBeNull()
  })

  it('a same-device link accepts any sides', () => {
    expect(identityLinkSidesRefusal('same-device', null)).toBeNull()
  })

  it('poe-power contributes power-source to the fed device, sourced from the port switch', () => {
    expect(IDENTITY_LINK_KINDS['poe-power'].contributions).toEqual([
      {
        cap: 'power-source',
        targetId: 'switch',
        host: 'b',
        source: 'a',
        sourceCap: 'switch',
        sourceField: 'on',
      },
    ])
    expect(IDENTITY_LINK_KINDS['same-device'].contributions).toEqual([])
  })
})

describe('identityLinkId', () => {
  it('a symmetric kind names one row whatever the order', () => {
    expect(identityLinkId('same-device', PORT, CAMERA)).toBe(
      identityLinkId('same-device', CAMERA, PORT),
    )
  })

  it('a directional kind keeps the attaching side first', () => {
    expect(identityLinkId('poe-power', PORT, CAMERA)).toBe(
      'poe-power:provider-unifi/port-7|provider-hikvision/cam-1',
    )
  })
})

describe('contributedBy', () => {
  it('round-trips through CompositionSchema', () => {
    const parsed = CompositionSchema.parse({
      target: { kind: 'existing', device: CAMERA },
      features: [
        {
          kind: 'fields',
          cap: 'power-source',
          enabled: false,
          fields: {
            switchOn: {
              kind: 'from',
              source: { ...PORT },
              cap: 'switch',
              fieldPath: 'on',
            },
          },
          contributedBy: { linkId: 'poe-power:a|b' },
        },
      ],
    })
    const feature = parsed.features[0]
    expect(feature?.kind === 'fields' ? feature.contributedBy : undefined).toEqual({
      linkId: 'poe-power:a|b',
    })
  })
})
