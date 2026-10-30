import { describe, expect, it } from 'vitest'
import { readRemoteAccess, remoteAccessSet } from '../mcp/configure-network.js'
import { withWrites } from './configure-gate-ctx.js'
import { fakeHub } from './ops-fake-hub.js'

const TOKEN_VALUE = 'cf-super-secret-token-value'

const tunnel = {
  sections: [
    {
      id: 'main',
      fields: [
        { type: 'select', key: 'mode', label: 'Mode', value: 'quick' },
        {
          type: 'text',
          key: 'customHostname',
          label: 'Hostname',
          value: 'cam.example.test',
        },
        { type: 'number', key: 'localPort', label: 'Port', value: 4443 },
        {
          type: 'password',
          key: 'customApiToken',
          label: 'API token',
          value: { $secret: TOKEN_VALUE },
        },
      ],
    },
  ],
}

const reads = {
  'networkAccess.getStatus': {
    connected: true,
    endpoint: { url: 'https://cam.example.test', stable: true },
  },
  'localNetwork.getAddresses': {
    roles: {
      publicEndpoint: { resolved: 'https://cam.example.test' },
      appConnections: { resolved: ['http://192.168.1.9:4443'] },
    },
  },
  'addonSettings.getGlobalSettings': (i: { addonId: string }): unknown =>
    i.addonId === 'cloudflare-tunnel' ? tunnel : null,
  'addonSettings.updateGlobalSettings': { success: true },
}

describe('configure_remote_access', () => {
  it('reports plain fields and only whether a secret is configured, never its value', async () => {
    const { ctx, calls } = fakeHub(reads)
    const out = await readRemoteAccess(ctx)
    const body = JSON.stringify(out)
    expect(body).not.toContain(TOKEN_VALUE)
    expect(body).toContain('"configured":true')
    expect(out).toMatchObject({ publicEndpoint: 'https://cam.example.test' })
    expect(body).toContain('cam.example.test')
    expect(calls.some((c) => c.path.startsWith('turnProvider'))).toBe(false)
  })
})

describe('configure_remote_access_set', () => {
  it('changes a plain field after a preview', async () => {
    const { ctx, calls } = fakeHub(reads)
    const w = withWrites(ctx)
    const args = {
      addonId: 'cloudflare-tunnel' as const,
      patch: { localPort: 8443 },
    }
    const preview = await remoteAccessSet(w, args, undefined)
    if (preview.status !== 'dry-run') throw new Error(JSON.stringify(preview))
    expect(calls.some((c) => c.path === 'addonSettings.updateGlobalSettings')).toBe(false)
    await remoteAccessSet(w, args, preview.confirm_token)
    expect(calls.find((c) => c.path === 'addonSettings.updateGlobalSettings')?.input).toEqual({
      addonId: 'cloudflare-tunnel',
      patch: { localPort: 8443 },
    })
  })

  it('refuses a secret with secret-required and an admin-UI link, writing nothing', async () => {
    const { ctx, calls } = fakeHub(reads)
    const out = await remoteAccessSet(
      withWrites(ctx),
      {
        addonId: 'cloudflare-tunnel',
        patch: { customApiToken: 'hunter2-should-not-travel' },
      },
      undefined,
    )
    const body = JSON.stringify(out)
    expect(body).toMatch(/secret-required/)
    expect(body).toContain('http://192.168.1.9:4443/system/remote-access')
    expect(body).not.toContain('hunter2')
    expect(calls.some((c) => c.path === 'addonSettings.updateGlobalSettings')).toBe(false)
  })

  it('refuses an unknown key and a wrong type', async () => {
    const { ctx } = fakeHub(reads)
    const w = withWrites(ctx)
    const text = async (patch: Record<string, string | number>): Promise<string> =>
      JSON.stringify(await remoteAccessSet(w, { addonId: 'cloudflare-tunnel', patch }, undefined))
    expect(await text({ nope: 'x' })).toMatch(/no such setting/)
    expect(await text({ localPort: 'high' })).toMatch(/a number is expected/)
  })
})
