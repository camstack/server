import type { DiscoveryHit } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ONVIF_DISCOVERY_MODES, onvifCamerasFromHits } from '../onvif-discovery.js'

function wsd(host: string, over: Partial<NonNullable<DiscoveryHit['wsd']>> = {}): DiscoveryHit {
  return {
    host,
    modeIndex: 0,
    port: 3702,
    wsd: {
      xaddrs: [`http://${host}:8080/onvif/device_service`],
      types: ['dn:NetworkVideoTransmitter'],
      scopes: ['onvif://www.onvif.org/name/Front%20Door', 'onvif://www.onvif.org/hardware/CAM-1'],
      ...over,
    },
  }
}

describe('ONVIF discovery classification', () => {
  it('declares one ws-discovery mode for video transmitters', () => {
    expect(ONVIF_DISCOVERY_MODES).toEqual([
      { kind: 'ws-discovery', types: ['dn:NetworkVideoTransmitter'] },
    ])
  })

  it('turns a WS-Discovery hit into a camera with port, name and model', () => {
    const [cam] = onvifCamerasFromHits([wsd('192.0.2.10')])
    expect(cam).toMatchObject({
      host: '192.0.2.10',
      port: 8080,
      name: 'Front Door',
      model: 'CAM-1',
    })
  })

  it('defaults the port to 80 when the xaddr names none', () => {
    const [cam] = onvifCamerasFromHits([
      wsd('192.0.2.11', { xaddrs: ['http://192.0.2.11/onvif/device_service'] }),
    ])
    expect(cam?.port).toBe(80)
  })

  it('rejects a responder that is not a video transmitter and hits without a wsd answer', () => {
    const other = wsd('192.0.2.12', { types: ['dn:Device'] })
    const plain: DiscoveryHit = { host: '192.0.2.13', port: 3702, modeIndex: 0 }
    expect(onvifCamerasFromHits([other, plain])).toEqual([])
  })

  it('keeps one camera per host', () => {
    expect(onvifCamerasFromHits([wsd('192.0.2.10'), wsd('192.0.2.10')])).toHaveLength(1)
  })
})
