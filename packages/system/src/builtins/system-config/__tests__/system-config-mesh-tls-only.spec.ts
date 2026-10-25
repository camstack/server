import {
  type AddonContext,
  createSecretsAccess,
  type KeychainResolveResult,
  type KeychainTransport,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyAgentUiUnlockTicket } from '../../../kernel/moleculer/agent-ui-unlock.js'
import {
  clearProcessMeshCa,
  getProcessMeshCaState,
} from '../../../kernel/moleculer/mesh-mtls/index.js'
import { generateMeshCa } from '../../../kernel/moleculer/mesh-mtls/mesh-ca.js'
import { systemConfigMeshActions } from '../mesh-actions.js'
import { SYSTEM_CONFIG_CLUSTER_SECTION_ID, SystemConfigAddon } from '../system-config.addon.js'

function memoryKeychain() {
  const values = new Map<string, { value: string; version: number }>()
  const transport = (owner: string): KeychainTransport => ({
    put: async ({ ref, value }) => {
      if (!ref.startsWith(`secret://${owner}/`)) throw new Error('forbidden')
      const version = (values.get(ref)?.version ?? 0) + 1
      values.set(ref, { value, version })
      return { ref, version }
    },
    resolve: async ({ refs }) => {
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        const hit = values.get(ref)
        out[ref] = hit === undefined ? { kind: 'missing' } : { kind: 'value', ...hit }
      }
      return out
    },
    delete: async ({ refs }) => {
      let deleted = 0
      for (const ref of refs) if (values.delete(ref)) deleted++
      return { deleted }
    },
    getState: async () => ({ state: 'ready' }),
  })
  return createSecretsAccess({
    owner: 'system-config',
    transport: transport('system-config'),
    transportForOwner: transport,
  })
}

function harness(initialCluster: Record<string, unknown> = {}) {
  const sections = new Map<string, Record<string, unknown>>([
    ['cluster', initialCluster],
    ['server', { host: '192.168.10.9', port: 4443 }],
  ])
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  const ctx = {
    id: 'system-config',
    logger,
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    secrets: memoryKeychain(),
    settings: {
      getSection: async (name: string) => ({ ...sections.get(name) }),
      setSection: async (name: string, patch: Record<string, unknown>) => {
        sections.set(name, { ...sections.get(name), ...patch })
      },
      readAddonStore: async () => ({}),
      writeAddonStore: async () => undefined,
    },
  } as unknown as AddonContext
  return { ctx, sections, logger }
}

afterEach(() => {
  clearProcessMeshCa()
})

describe('system-config — TLS-only mesh (D826)', () => {
  it('cluster schema has no meshClearPort or agent dashboard origins field', async () => {
    const h = harness()
    const addon = new SystemConfigAddon()
    await addon.initialize(h.ctx)
    const form = await addon.getGlobalSettings()
    const cluster = form.sections.find((s) => s.id === SYSTEM_CONFIG_CLUSTER_SECTION_ID)
    expect(cluster).toBeDefined()
    const keys = cluster!.fields.map((f) => f.key)
    expect(keys).not.toContain('meshClearPort')
    expect(keys).not.toContain('agentDashboardOrigins')
    expect(keys).not.toContain('mintJoinTokenAction')
    expect(keys).not.toContain('meshAuthStatus')
  })

  it('ignores a retired meshClearPort patch with a warning', async () => {
    const h = harness()
    const addon = new SystemConfigAddon()
    await addon.initialize(h.ctx)
    await addon.updateGlobalSettings({ meshClearPort: 'off' })
    expect(h.sections.get('cluster')?.['meshClearPort']).toBeUndefined()
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/meshClearPort is retired/))
  })

  it('offers no join-token action: an agent joins only by being paired (D857)', async () => {
    const h = harness()
    const addon = new SystemConfigAddon()
    const init = await addon.initialize(h.ctx)
    const handlers = init === undefined ? {} : (init.actionHandlers ?? {})
    expect(Object.keys(handlers)).not.toContain('mintJoinToken')
    expect(Object.keys(systemConfigMeshActions)).not.toContain('mintJoinToken')
  })

  it('has no cluster secret: initialising stores nothing, the keychain is untouched', async () => {
    const h = harness()
    const addon = new SystemConfigAddon()
    await addon.initialize(h.ctx)
    const cluster = h.sections.get('cluster') ?? {}
    expect(cluster['clusterSecret']).toBeUndefined()
    expect(cluster['meshAuth']).toBeUndefined()
    const form = await addon.getGlobalSettings()
    const clusterForm = form.sections.find((s) => s.id === SYSTEM_CONFIG_CLUSTER_SECTION_ID)
    expect(clusterForm?.fields.map((f) => f.key)).not.toContain('clusterSecret')
  })

  it('ignores a retired clusterSecret / meshAuth patch with a warning', async () => {
    const h = harness()
    const addon = new SystemConfigAddon()
    await addon.initialize(h.ctx)
    await addon.updateGlobalSettings({ clusterSecret: 'x', meshAuth: 'transition' })
    expect(h.sections.get('cluster')?.['clusterSecret']).toBeUndefined()
    expect(h.sections.get('cluster')?.['meshAuth']).toBeUndefined()
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/clusterSecret is retired/))
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/meshAuth is retired/))
  })

  it('mints the agent-ui unlock ticket with the mesh CA key (ES256), verifiable by the pinned CA', async () => {
    const h = harness()
    const addon = new SystemConfigAddon()
    await addon.initialize(h.ctx)
    // The keeper owns the CA slot once the addon is up: the ticket is signed by THAT CA.
    const state = getProcessMeshCaState()
    if (state.state !== 'ready') throw new Error('the mesh CA is not ready')
    const minted = await addon['mintAgentUiUnlock']({ nodeId: 'agent-a' })
    expect(
      verifyAgentUiUnlockTicket(state.ca.certPem, minted.ticket, {
        expectedNodeId: 'agent-a',
      }),
    ).not.toBeNull()
    const other = await generateMeshCa()
    expect(
      verifyAgentUiUnlockTicket(other.certPem, minted.ticket, { expectedNodeId: 'agent-a' }),
    ).toBeNull()
  })
})
