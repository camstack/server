import { describe, expect, it } from 'vitest'
import { DeviceType, resolveContainerPrimaryChild } from '@camstack/types'
import type { HmCustomEntity, HmDevice } from 'nodehomematic'
import { deriveHmEntitySpecs } from '../devices/hm-entity-spec.js'
import { hmPrimaryChildKeys, preferenceToStamp } from '../devices/hm-primary-child.js'
import {
  actuatorNameWrite,
  legacyActuatorName,
  multiActuatorChildName,
} from '../devices/hm-child-name.js'

const ADDR = '00315F298E5093'

function bs2(): HmDevice {
  return {
    address: ADDR,
    type: 'HmIP-BS2',
    name: null,
    channels: [
      { address: `${ADDR}:1`, index: 1, name: null, type: 'KEY_TRANSCEIVER', dataPoints: [] },
      { address: `${ADDR}:2`, index: 2, name: null, type: 'KEY_TRANSCEIVER', dataPoints: [] },
      {
        address: `${ADDR}:4`,
        index: 4,
        name: null,
        type: 'SWITCH_VIRTUAL_RECEIVER',
        dataPoints: [],
      },
      {
        address: `${ADDR}:8`,
        index: 8,
        name: null,
        type: 'SWITCH_VIRTUAL_RECEIVER',
        dataPoints: [],
      },
    ],
  }
}

/** Relays listed :8 first, so a tie-break on array order would not choose :4. */
function entities(): HmCustomEntity[] {
  return [
    { kind: 'switch', device: ADDR, channel: `${ADDR}:8`, isOn: false },
    { kind: 'switch', device: ADDR, channel: `${ADDR}:4`, isOn: false },
  ]
}

describe('multiActuatorChildName', () => {
  it('uses the CCU channel name when the facade has one', () => {
    expect(
      multiActuatorChildName({
        containerName: 'Pulsante bagno camerette',
        channelName: 'Luce bagno',
        channelIndex: '4',
      }),
    ).toBe('Luce bagno')
  })

  it('falls back to container plus channel index, never the address', () => {
    expect(
      multiActuatorChildName({
        containerName: 'Pulsante bagno camerette',
        channelName: null,
        channelIndex: '4',
      }),
    ).toBe('Pulsante bagno camerette ch4')
    expect(legacyActuatorName('Pulsante bagno camerette', `${ADDR}:4`)).toBe(
      `Pulsante bagno camerette ${ADDR}:4`,
    )
  })
})

describe('actuatorNameWrite', () => {
  const desired = 'Pulsante bagno camerette ch4'
  const legacy = legacyActuatorName('Pulsante bagno camerette', `${ADDR}:4`)
  const base = {
    desiredName: desired,
    legacyAutoName: legacy,
    fallbackAutoName: desired,
    stableId: `hm:1:${ADDR}-act-${ADDR}:4`,
  }

  it('replaces the generated address name even when registration stamped userNamed', () => {
    expect(actuatorNameWrite({ ...base, currentName: legacy, userNamed: true })).toEqual({
      kind: 'rename',
      name: desired,
      stampUserNamed: true,
    })
  })

  it('leaves a name the operator chose', () => {
    expect(actuatorNameWrite({ ...base, currentName: 'Luce camerette', userNamed: true })).toEqual({
      kind: 'keep',
    })
  })

  it('leaves a legacy row whose name is not an auto form', () => {
    expect(
      actuatorNameWrite({ ...base, currentName: 'Luce camerette', userNamed: undefined }),
    ).toEqual({ kind: 'keep' })
  })

  it('replaces a system name that was not stamped user-named', () => {
    expect(actuatorNameWrite({ ...base, currentName: legacy, userNamed: false })).toEqual({
      kind: 'rename',
      name: desired,
      stampUserNamed: false,
    })
  })
})

describe('hmPrimaryChildKeys', () => {
  it('picks the first relay of a BS2 by preference, not by tie-break', () => {
    const specs = deriveHmEntitySpecs(bs2(), entities())
    const keys = hmPrimaryChildKeys(specs)
    expect(keys).toEqual([`act-${ADDR}:4`])
    const parent = 'hm:1:' + ADDR
    const children = [
      {
        id: 2,
        stableId: `${parent}-act-${ADDR}:8`,
        type: DeviceType.Switch,
        name: 'Pulsante bagno camerette',
      },
      {
        id: 3,
        stableId: `${parent}-act-${ADDR}:4`,
        type: DeviceType.Switch,
        name: 'Pulsante bagno camerette ch4',
      },
      {
        id: 1,
        stableId: `${parent}-events`,
        type: DeviceType.EventEmitter,
        name: 'Buttons',
      },
    ]
    const heuristic = resolveContainerPrimaryChild(
      children,
      null,
      'Pulsante bagno camerette',
      DeviceType.Container,
      undefined,
    )
    expect(heuristic?.stableId).toBe(`${parent}-act-${ADDR}:8`)
    const preferred = resolveContainerPrimaryChild(
      children,
      null,
      'Pulsante bagno camerette',
      DeviceType.Container,
      {
        parentStableId: parent,
        childKeys: keys,
      },
    )
    expect(preferred?.stableId).toBe(`${parent}-act-${ADDR}:4`)
  })

  it('stands a key-only device for its event-emitter', () => {
    const device: HmDevice = {
      address: ADDR,
      type: 'HmIP-WRC2',
      name: null,
      channels: [
        { address: `${ADDR}:1`, index: 1, name: null, type: 'KEY_TRANSCEIVER', dataPoints: [] },
        { address: `${ADDR}:2`, index: 2, name: null, type: 'KEY_TRANSCEIVER', dataPoints: [] },
      ],
    }
    expect(hmPrimaryChildKeys(deriveHmEntitySpecs(device, []))).toEqual(['events'])
  })

  it('does not overwrite a preference the container already has', () => {
    expect(preferenceToStamp(['events'], [`act-${ADDR}:4`])).toBeNull()
    expect(preferenceToStamp(undefined, [`act-${ADDR}:4`])).toEqual([`act-${ADDR}:4`])
    expect(preferenceToStamp(undefined, [])).toBeNull()
  })
})
