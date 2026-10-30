import { DeviceType, deviceAdminLinkCapability, rebootCapability } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type AdoptableCover,
  buildRademacherCandidates,
  coverNativeId,
  gatewayNativeId,
  resolveNativeId,
} from '../rademacher-discovery.js'

const INT = 'int-1'

function cover(did: string, name: string, online = true): AdoptableCover {
  return { did, name, model: 'RolloTron', online, supportsPosition: true, supportsTilt: false }
}

describe('Rademacher adoption candidates', () => {
  const covers = [cover('7', 'Salotto'), cover('9', '', false)]

  it('offers one Gateway and one Cover per shutter, with integration-namespaced ids', () => {
    const out = buildRademacherCandidates({
      integrationId: INT,
      integrationName: 'Casa',
      online: true,
      hubModel: 'HomePilot',
      covers,
      adopted: new Map(),
    })
    expect(out.map((c) => [c.childNativeId, c.type])).toEqual([
      ['int-1:gateway', DeviceType.Gateway],
      ['int-1:cover:7', DeviceType.Cover],
      ['int-1:cover:9', DeviceType.Cover],
    ])
    // Products are siblings of the gateway, never its children.
    expect(out.every((c) => (c.children ?? []).length === 0)).toBe(true)
    expect(out[2]?.name).toBe('Casa — Cover 9')
    expect(out[2]?.status).toBe('offline')
  })

  it('advertises on the gateway only what the hub supports', () => {
    const gateway = buildRademacherCandidates({
      integrationId: INT,
      integrationName: 'Casa',
      online: false,
      hubModel: null,
      covers: [],
      adopted: new Map(),
    })[0]
    expect(gateway?.capabilities).toEqual([deviceAdminLinkCapability.name])
    expect(gateway?.capabilities).not.toContain(rebootCapability.name)
    expect(gateway?.status).toBe('offline')
    expect(gateway?.metadata).toEqual({ manufacturer: 'Rademacher', model: 'HomePilot' })
  })

  it('marks what is already adopted, by native id', () => {
    const out = buildRademacherCandidates({
      integrationId: INT,
      integrationName: 'Casa',
      online: true,
      hubModel: 'Start2Smart',
      covers,
      adopted: new Map([
        [gatewayNativeId(INT), 40],
        [coverNativeId(INT, '7'), 41],
      ]),
    })
    expect(out.map((c) => c.adoptedDeviceId)).toEqual([40, 41, null])
    expect(out[0]?.metadata.model).toBe('Start2Smart')
  })

  it('two integrations never share a native id', () => {
    expect(coverNativeId('a', '7')).not.toBe(coverNativeId('b', '7'))
    expect(resolveNativeId('a', covers, coverNativeId('b', '7'))).toBeNull()
  })

  it('resolves the gateway and a cover, and refuses an unknown id', () => {
    expect(resolveNativeId(INT, covers, gatewayNativeId(INT))).toEqual({ kind: 'gateway' })
    const resolved = resolveNativeId(INT, covers, coverNativeId(INT, '9'))
    expect(resolved?.kind === 'cover' ? resolved.cover.did : null).toBe('9')
    expect(resolveNativeId(INT, covers, 'int-1:cover:404')).toBeNull()
    expect(resolveNativeId(INT, covers, '9')).toBeNull()
  })
})
