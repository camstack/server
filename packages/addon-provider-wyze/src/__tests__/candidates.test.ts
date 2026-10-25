import { describe, expect, it } from 'vitest'
import type { WyzeCamera } from '@apocaliss92/wyze-bridge-js'
import { DeviceType } from '@camstack/types'
import { buildWyzeCandidates } from '../candidates.js'

function cam(partial: Partial<WyzeCamera>): WyzeCamera {
  return {
    mac: '80482C53405B',
    p2pId: 'UID123',
    enr: 'ENRKEY',
    ip: '192.168.10.41',
    nickname: 'Front',
    productModel: 'WYZE_CAKP2JFUS',
    productType: 'Camera',
    dtls: 1,
    firmwareVer: '4.36.14.3497',
    isOnline: true,
    ...partial,
  }
}

describe('buildWyzeCandidates', () => {
  it('maps an adoptable camera to a Camera candidate keyed by MAC', () => {
    const out = buildWyzeCandidates({ cameras: [cam({})], adopted: new Map() })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      childNativeId: '80482C53405B',
      name: 'Front',
      type: DeviceType.Camera,
      status: 'online',
      alreadyAdopted: false,
      adoptedDeviceId: null,
    })
    expect(out[0]?.metadata).toMatchObject({ model: 'WYZE_CAKP2JFUS', manufacturer: 'Wyze' })
  })

  it('marks already-adopted cameras via the MAC→deviceId map (case-insensitive)', () => {
    const adopted = new Map<string, number>([['80482C53405B', 42]])
    const out = buildWyzeCandidates({ cameras: [cam({})], adopted })
    expect(out[0]?.alreadyAdopted).toBe(true)
    expect(out[0]?.adoptedDeviceId).toBe(42)
  })

  it('omits cameras missing P2P parameters', () => {
    const out = buildWyzeCandidates({ cameras: [cam({ p2pId: '' })], adopted: new Map() })
    expect(out).toHaveLength(0)
  })

  it('reports offline status when the cloud reports the camera offline', () => {
    const out = buildWyzeCandidates({ cameras: [cam({ isOnline: false })], adopted: new Map() })
    expect(out[0]?.status).toBe('offline')
  })

  it('falls back to model then MAC for the name', () => {
    const noNick = buildWyzeCandidates({ cameras: [cam({ nickname: '' })], adopted: new Map() })
    expect(noNick[0]?.name).toBe('WYZE_CAKP2JFUS')
  })
})
