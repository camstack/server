/**
 * ONE mapping decides what each UniFi device is proposed and adopted as (planning#587).
 * The host kinds (console, switch, access point) are the future `workload` / `host` devices
 * (#585); until that type exists they keep today's Container, so nothing regresses.
 */
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  classifyUnifiInfra,
  UNIFI_HOST_TARGET,
  unifiDeviceTarget,
  type UnifiCandidateKind,
  type UnifiInfraKind,
} from '../unifi-device-kind.js'

describe('classifyUnifiInfra', () => {
  it.each<[string, readonly string[], UnifiInfraKind]>([
    // A console reports switching and an access point too: the model wins.
    ['UDM-Pro', ['switching'], 'console'],
    ['UDM-SE', ['switching'], 'console'],
    ['UDR', ['switching', 'accessPoint'], 'console'],
    ['UCG-Ultra', [], 'console'],
    ['UCG-Max', ['switching'], 'console'],
    ['UXG-Lite', [], 'console'],
    ['UCK-G2-Plus', [], 'console'],
    ['USG-3P', [], 'console'],
    ['UDW', ['switching'], 'console'],
    // The Integration API's `features` list decides the rest.
    ['USW-Lite-8-PoE', ['switching'], 'switch'],
    ['USW-Flex-Mini', ['switching'], 'switch'],
    ['U6-Pro', ['accessPoint'], 'access-point'],
    ['U7-Pro', ['accessPoint'], 'access-point'],
    // A wall AP with switch ports is an access point.
    ['U6-IW', ['switching', 'accessPoint'], 'access-point'],
    // No features reported: the model prefix.
    ['USW-24', [], 'switch'],
    ['UAP-AC-Lite', [], 'access-point'],
    ['U6-LR', [], 'access-point'],
    // Anything else (a bridge, a sensor, an unknown model).
    ['UBB', [], 'other'],
    ['', [], 'other'],
  ])('%s with features %j is a %s', (model, features, kind) => {
    expect(classifyUnifiInfra({ model, features })).toBe(kind)
  })
})

describe('unifiDeviceTarget — the one type/role table', () => {
  it.each<[UnifiCandidateKind, DeviceType, string | null]>([
    ['controller', DeviceType.Gateway, null],
    // #585 flips these three to workload / host (UNIFI_HOST_TARGET).
    ['console', DeviceType.Container, null],
    ['switch', DeviceType.Container, null],
    ['access-point', DeviceType.Container, null],
    ['other', DeviceType.Container, null],
    ['client', DeviceType.Presence, null],
  ])('%s → %s (role %s)', (kind, type, role) => {
    expect(unifiDeviceTarget(kind)).toEqual({ type, role })
  })

  it('every host kind follows UNIFI_HOST_TARGET, so #585 is a one-line flip', () => {
    for (const kind of ['console', 'switch', 'access-point'] as const) {
      expect(unifiDeviceTarget(kind)).toBe(UNIFI_HOST_TARGET)
    }
    expect(unifiDeviceTarget('other')).not.toBe(UNIFI_HOST_TARGET)
  })
})
