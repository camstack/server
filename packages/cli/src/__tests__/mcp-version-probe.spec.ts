import { describe, expect, it } from 'vitest'
import { MutationGate, type ConnectOutcome, type HubClient } from '@camstack/develop'
import type { McpContext } from '../mcp/context.js'
import { probeVersions } from '../mcp/version-probe.js'

function ctx(hub: ConnectOutcome, cliLatest: string): McpContext {
  return {
    cliVersion: '1.0.0',
    hub: async () => hub,
    gate: new MutationGate({ allowMutations: true }),
    fetch: async () => new Response(JSON.stringify({ version: cliLatest })),
  }
}

function connected(client: HubClient): ConnectOutcome {
  return {
    ok: true,
    connection: {
      server: 'https://hub.example.test',
      token: 't',
      tier: 'admin',
      source: 'session',
      tls: {},
      client,
      adminHint: null,
      loginCommand: 'camstack login',
    },
  }
}

describe('probeVersions', () => {
  it('without a session checks only the CLI/MCP', async () => {
    const probe = await probeVersions(
      ctx({ ok: false, reason: 'no-session', message: 'm', action: 'a' }, '1.1.0'),
    )
    expect(probe.cli).toEqual({
      state: 'behind',
      installed: '1.0.0',
      latest: '1.1.0',
    })
    expect(probe.server.state).toBe('not-checked')
    expect(probe.addons.state).toBe('not-checked')
  })

  it('reads the hub server behind its latest and the first three addons', async () => {
    const calls: string[] = []
    const client: HubClient = {
      async call(_m, path) {
        calls.push(path)
        if (path === 'serverManagement.getServerPackageStatus') {
          return { runningVersion: '1.2.700', latestVersion: '1.2.714' }
        }
        return ['a', 'b', 'c', 'd'].map((name) => ({
          name,
          currentVersion: '1',
          latestVersion: '2',
          category: 'addon',
          isSystem: false,
        }))
      },
    }
    const probe = await probeVersions(ctx(connected(client), '1.0.0'))
    expect(probe.server).toEqual({
      state: 'behind',
      running: '1.2.700',
      latest: '1.2.714',
    })
    expect(probe.addons).toEqual({
      state: 'behind',
      count: 4,
      names: ['a', 'b', 'c'],
    })
    expect(probe.cli.state).toBe('current')
    expect(calls).not.toContain('nodes.topology')
  })

  it('a hub read that failed is a reason, not "up to date"', async () => {
    const client: HubClient = {
      async call() {
        throw new Error('hub down')
      },
    }
    const probe = await probeVersions(ctx(connected(client), '1.0.0'))
    expect(probe.server).toMatchObject({ state: 'unknown' })
    expect(JSON.stringify(probe)).toContain('hub down')
  })

  it('when every source answers nothing, no part is current', async () => {
    const client: HubClient = {
      async call() {
        return null
      },
    }
    const probe = await probeVersions({
      ...ctx(connected(client), '1.0.0'),
      fetch: async () => new Response('{}', { status: 500 }),
    })
    for (const part of [probe.server, probe.addons, probe.cli]) {
      expect(part.state).toBe('unknown')
      expect('reason' in part && part.reason.length > 0).toBe(true)
    }
  })
})
