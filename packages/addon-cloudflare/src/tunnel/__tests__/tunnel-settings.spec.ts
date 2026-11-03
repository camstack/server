/** What the tunnel runs on: the record's body plus this node's origin, with the old keys as fallback. */
import { describe, expect, it } from 'vitest'
import { CLOUDFLARE_TUNNEL_DEFAULT_BODY } from '../tunnel-record-kinds.js'
import {
  DEFAULT_NODE_ORIGIN,
  legacySettingsOf,
  nodeOriginOf,
  settingsOf,
} from '../tunnel-settings.js'

describe('nodeOriginOf', () => {
  it('reads the node row, which wins over the bare row of the old layout', () => {
    const origin = nodeOriginOf(
      {
        'localHost@hub': '10.0.0.5',
        localHost: '192.168.1.1',
        'localPortMode@hub': 'custom',
        'localPort@hub': 8443,
      },
      'hub',
    )
    expect(origin).toMatchObject({
      localHost: '10.0.0.5',
      localPortMode: 'custom',
      localPort: 8443,
    })
  })

  it('falls back to the bare row while no node row exists', () => {
    expect(nodeOriginOf({ localHost: '192.168.1.1' }, 'hub').localHost).toBe('192.168.1.1')
  })

  it('takes the default for a mistyped value and for an empty store', () => {
    expect(nodeOriginOf({ 'localPort@hub': '4443', 'localHost@hub': 7 }, 'hub')).toEqual(
      DEFAULT_NODE_ORIGIN,
    )
    expect(nodeOriginOf({}, 'hub')).toEqual(DEFAULT_NODE_ORIGIN)
  })

  it('reads the Vite dev port as automatic and says so', () => {
    const origin = nodeOriginOf({ 'localPort@hub': 3001, 'localPortMode@hub': 'custom' }, 'hub')
    expect(origin.localPort).toBe(0)
    expect(origin.staleDevPort).toBe(true)
  })

  it('does not read another node row', () => {
    expect(nodeOriginOf({ 'localHost@agent-2': '10.9.9.9' }, 'hub').localHost).toBe('')
  })
})

describe('settingsOf / legacySettingsOf', () => {
  it('joins the record body and the origin', () => {
    const settings = settingsOf(
      {
        name: 'x',
        ...CLOUDFLARE_TUNNEL_DEFAULT_BODY,
        mode: 'custom',
        customTunnelToken: 'jwt',
      },
      { ...DEFAULT_NODE_ORIGIN, localHost: '10.0.0.5' },
    )
    expect(settings).toMatchObject({
      mode: 'custom',
      customTunnelToken: 'jwt',
      localHost: '10.0.0.5',
    })
  })

  it('serves the old keys while no record exists', () => {
    const settings = legacySettingsOf(
      {
        mode: 'custom',
        customHostname: 'cam.example.com',
        customTunnelToken: 'jwt',
        'localPort@hub': 9000,
      },
      'hub',
    )
    expect(settings).toMatchObject({
      mode: 'custom',
      customHostname: 'cam.example.com',
      customTunnelToken: 'jwt',
      localPort: 9000,
    })
  })
})
