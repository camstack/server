import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it, vi } from 'vitest'
import {
  SettableRemoteAddonSchema,
  TUNNEL_INSTANCE_NOTE,
  readRemoteAccess,
  registerNetworkTools,
  remoteAccessSet,
} from '../mcp/configure-network.js'
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
  // Only the tunnel's `network-access` per-node form answers; a call for any other
  // (addon, cap, scope) is a wrong call and fails the read.
  'addonSettings.getScopedSettings': (i: {
    addonId: string
    cap: string
    scope: string
  }): unknown => {
    if (i.addonId === 'cloudflare-tunnel' && i.cap === 'network-access' && i.scope === 'node')
      return tunnel
    throw new Error(`no scoped form for ${i.addonId}/${i.cap}/${i.scope}`)
  },
  'addonSettings.updateScopedSettings': { success: true },
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
    expect(calls.some((c) => c.path === 'addonSettings.getGlobalSettings')).toBe(false)
    // the TURN addons keep instances, not settings: no scoped read is made for them
    expect(calls.filter((c) => c.path === 'addonSettings.getScopedSettings')).toHaveLength(1)
    expect(out).toMatchObject({
      addons: [
        { addonId: 'cloudflare-tunnel', state: 'read' },
        { addonId: 'cloudflare-turn', state: 'no-settings' },
        { addonId: 'static-turn', state: 'no-settings' },
      ],
    })
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
    expect(calls.some((c) => c.path === 'addonSettings.updateScopedSettings')).toBe(false)
    await remoteAccessSet(w, args, preview.confirm_token)
    expect(calls.find((c) => c.path === 'addonSettings.updateScopedSettings')?.input).toEqual({
      addonId: 'cloudflare-tunnel',
      cap: 'network-access',
      scope: 'node',
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
    expect(calls.some((c) => c.path === 'addonSettings.updateScopedSettings')).toBe(false)
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

describe('configure_remote_access_set scope', () => {
  it('accepts only the tunnel, and names the TURN admin page for the others', () => {
    expect(SettableRemoteAddonSchema.safeParse('cloudflare-tunnel').success).toBe(true)
    for (const id of ['cloudflare-turn', 'static-turn']) {
      const r = SettableRemoteAddonSchema.safeParse(id)
      expect(r.success).toBe(false)
      expect(JSON.stringify(r.error?.issues)).toContain('/system/turn')
      expect(JSON.stringify(r.error?.issues)).toContain('integration-instance')
    }
  })

  it('points a tunnel instance key at the admin UI, in the problem and in the preview', async () => {
    const { ctx } = fakeHub(reads)
    const w = withWrites(ctx)
    const bad = await remoteAccessSet(
      w,
      { addonId: 'cloudflare-tunnel', patch: { customHostname: 'x.example.test' } },
      undefined,
    )
    expect(JSON.stringify(bad)).toContain('/system/remote-access')
    const ok = await remoteAccessSet(
      w,
      { addonId: 'cloudflare-tunnel', patch: { localPort: 8443 } },
      undefined,
    )
    expect(JSON.stringify(ok)).toContain(TUNNEL_INSTANCE_NOTE.slice(0, 40))
  })

  it('describes only what can be set', () => {
    const server = new McpServer({ name: 'probe', version: '0.0.0' })
    const spy = vi.spyOn(server, 'tool')
    registerNetworkTools(server, fakeHub(reads).ctx)
    const described = spy.mock.calls.map((c) => String(c[1]))
    const all = described.join('\n')
    expect(all).not.toMatch(/account id|mode, host, port/)
    expect(all).toContain('localPortMode')
    expect(all).toContain('/system/remote-access')
  })
})
