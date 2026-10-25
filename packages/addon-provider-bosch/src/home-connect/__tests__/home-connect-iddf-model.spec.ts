import { describe, expect, it } from 'vitest'
import { HomeConnectDescriptionStore } from '../home-connect-description-store.js'
import {
  entityIndexFromDescription,
  isCurrentDescription,
  parseHomeConnectIddfXml,
  programsFromDescription,
} from '../home-connect-device-description.js'
import { enrichHomeConnectConnection } from '../home-connect-iddf-fetch.js'
import { buildDeflateZip } from '../home-connect-iddf.js'
import { parseXml } from '../home-connect-xml.js'
import {
  DISHWASHER_DEVICE_DESCRIPTION_XML,
  DISHWASHER_FEATURE_MAPPING_XML,
  DISHWASHER_IDDF_FILES,
  FX,
} from './dishwasher-iddf-fixture.js'

function compact() {
  return parseHomeConnectIddfXml({
    deviceDescriptionXml: DISHWASHER_DEVICE_DESCRIPTION_XML,
    featureMappingXml: DISHWASHER_FEATURE_MAPPING_XML,
    haId: 'BOSCH-DW-1',
  })
}

describe('parseXml', () => {
  it('keeps nesting, attributes (either quote), self-closing tags, entities and CDATA', () => {
    const root = parseXml(
      `<?xml version="1.0"?><!-- c --><a x='1' y="a&amp;b"><b/><c>t&lt;<![CDATA[<raw>]]></c></a>`,
    )
    expect(root?.name).toBe('a')
    expect(root?.attrs).toEqual({ x: '1', y: 'a&b' })
    expect(root?.children.map((c) => c.name)).toEqual(['b', 'c'])
    expect(root?.children[1]?.text).toBe('t<<raw>')
  })
})

describe('IDDF -> description model', () => {
  it('records the kind, access and constraints of every entity the IDDF lists', () => {
    const index = entityIndexFromDescription(JSON.parse(JSON.stringify(compact())))
    expect(index.get(FX.operationState)).toMatchObject({
      name: 'BSH.Common.Status.OperationState',
      kind: 'status',
      access: 'read',
      valueType: 'enum',
    })
    expect(index.get(FX.operationState)?.enumeration?.[8]).toBe('Aborting')
    expect(index.get(FX.startInRelative)).toMatchObject({
      kind: 'option',
      access: 'readWrite',
      min: 0,
      max: 86340,
      stepSize: 60,
      valueType: 'number',
    })
    expect(index.get(FX.programFinished)).toMatchObject({
      kind: 'event',
      handling: 'acknowledge',
      level: 'info',
    })
    expect(index.get(FX.pauseCmd)?.kind).toBe('command')
    expect(index.get(FX.abortCmd)?.available).toBe(false)
    expect(index.get(FX.childLock)).toMatchObject({ kind: 'setting', access: 'readWrite' })
  })

  it('does not drop entities the feature mapping does not name', () => {
    const index = entityIndexFromDescription(JSON.parse(JSON.stringify(compact())))
    expect(index.get(FX.unmappedStatus)?.name).toBe('Unmapped.0999')
    expect(index.get(FX.unmappedStatus)?.kind).toBe('status')
    expect(index.get(FX.unmappedSetting)?.kind).toBe('setting')
  })

  it('lists the programs with their feature name, availability and option refs', () => {
    const programs = programsFromDescription(JSON.parse(JSON.stringify(compact())))
    expect(programs.map((p) => p.uid)).toEqual([
      'Dishcare.Dishwasher.Program.Eco50',
      'Dishcare.Dishwasher.Program.Auto2',
      'Dishcare.Dishwasher.Program.Quick45',
    ])
    expect(programs.map((p) => p.name)).toEqual(['Eco50', 'Auto2', 'Quick45'])
    expect(programs.map((p) => p.available)).toEqual([true, true, false])
    const eco = programs[0]
    expect(eco?.options?.map((o) => o.key)).toEqual([
      'BSH.Common.Option.StartInRelative',
      'Dishcare.Dishwasher.Option.ExtraDry',
      'Dishcare.Dishwasher.Option.HalfLoad',
      'Dishcare.Dishwasher.Option.IntensivZone',
    ])
    expect(eco?.options?.[3]).toMatchObject({
      access: 'read',
      available: false,
      defaultValue: true,
    })
  })

  it('finds the active / selected program entities by kind, not by a name that differs per spelling', () => {
    const store = new HomeConnectDescriptionStore(JSON.parse(JSON.stringify(compact())))
    expect(store.entityOfKind('activeProgram')).toMatchObject({
      uid: FX.activeProgram,
      name: 'BSH.Common.Root.ActiveProgram',
    })
    expect(store.entityOfKind('selectedProgram')?.uid).toBe(FX.selectedProgram)
  })

  it('applies a live description change over the stored constraints', () => {
    const store = new HomeConnectDescriptionStore(JSON.parse(JSON.stringify(compact())))
    const touched = store.applyChanges([{ uid: FX.startInRelative, max: 3600, available: false }])
    expect(touched).toEqual(['BSH.Common.Option.StartInRelative'])
    expect(store.entity(FX.startInRelative)).toMatchObject({ max: 3600, available: false, min: 0 })
    // a uid the stored description does not list changes nothing
    expect(store.applyChanges([{ uid: 0x7777, available: false }])).toEqual([])
  })

  it('reports a store built from nothing as missing, and a parsed IDDF as complete', () => {
    expect(new HomeConnectDescriptionStore(undefined).state).toBe('missing')
    expect(new HomeConnectDescriptionStore(JSON.parse(JSON.stringify(compact()))).state).toBe(
      'complete',
    )
  })
})

describe('isCurrentDescription', () => {
  it('is false for a description stored before kinds were recorded', () => {
    const legacy = {
      info: { deviceID: 'X', deviceType: 'Dishwasher', model: 'M' },
      program: [],
      entities: { '552': { uid: 552, name: 'BSH.Common.Status.OperationState' } },
    }
    expect(isCurrentDescription(legacy)).toBe(false)
    expect(isCurrentDescription(JSON.parse(JSON.stringify(compact())))).toBe(true)
  })
})

describe('enrichHomeConnectConnection', () => {
  const baseRow = {
    haId: 'BOSCH-DW-1',
    name: 'Kitchen',
    type: 'Dishwasher',
    host: 'BOSCH-Dishwasher-BOSCH-DW-1',
    psk: 'k',
    mode: 'TLS' as const,
  }

  it('never substitutes another model: a failed IDDF fetch leaves the appliance without entities and lists it as missing', async () => {
    const result = await enrichHomeConnectConnection(
      { token: 'access', appliances: [baseRow] },
      async () => ({ status: 503, headers: { get: () => null }, text: async () => '' }),
    )
    expect(result.changed).toBe(false)
    expect(result.missing).toEqual(['BOSCH-DW-1'])
    expect(result.connection.appliances?.[0]?.deviceDescription).toBeUndefined()
  })

  it('replaces an outdated stored description with the freshly fetched IDDF', async () => {
    const zip = buildDeflateZip(DISHWASHER_IDDF_FILES)
    const legacy = {
      info: { deviceID: 'BOSCH-DW-1', deviceType: 'Dishwasher', model: 'M' },
      program: [],
      entities: { '552': { uid: 552, name: 'BSH.Common.Status.OperationState' } },
    }
    const result = await enrichHomeConnectConnection(
      { token: 'access', appliances: [{ ...baseRow, deviceDescription: legacy }] },
      async () => ({
        status: 200,
        headers: { get: () => null },
        text: async () => '',
        arrayBuffer: async () => Uint8Array.from(zip).buffer,
      }),
    )
    expect(result.changed).toBe(true)
    expect(result.missing).toEqual([])
    const stored = result.connection.appliances?.[0]?.deviceDescription
    expect(isCurrentDescription(stored)).toBe(true)
    expect(entityIndexFromDescription(stored).get(FX.operationState)?.name).toBe(
      'BSH.Common.Status.OperationState',
    )
  })
})
