/**
 * Spec for the codegen'd `integration-instances` router: the additive P2 fields pass through the
 * router's input and output validation, and createInstance accepts a call without an id.
 */
import { describe, it, expect, vi } from 'vitest'
import type { IIntegrationInstancesProvider } from '@camstack/types'
import { makeCtx, invokeProcedure, buildCapRouterForTest } from './harness.js'

function makeProvider(): IIntegrationInstancesProvider {
  return {
    describe: vi.fn(async () => ({
      role: 'services' as const,
      instanceMode: 'multiple' as const,
      kind: 'target',
      canTest: true,
      allowRestoreId: true,
      kinds: [
        { id: 'a', label: 'A', functionCap: 'broker', signIn: { basePath: '/addon/x/sign-in' } },
      ],
    })),
    instanceFormSchema: vi.fn(async () => ({ sections: [] })),
    listInstances: vi.fn(async () => [
      {
        id: 'i1',
        name: 'One',
        configured: true,
        enabled: true,
        formValues: {},
        kind: 'a',
        status: { state: 'ok' as const, label: 'Signed in' },
        lastCheckedAt: 42,
      },
    ]),
    getInstance: vi.fn(async () => null),
    createInstance: vi.fn(async () => ({ id: 'minted-1' })),
    updateInstance: vi.fn(async () => ({ ok: true as const })),
    setInstanceEnabled: vi.fn(async () => ({ ok: true as const })),
    deleteInstance: vi.fn(async () => ({ ok: true as const })),
  }
}

describe('integration-instances cap router', () => {
  it('describe and listInstances carry the new optional fields through', async () => {
    const router = buildCapRouterForTest('integration-instances', makeProvider)
    const d = await invokeProcedure(router, 'describe', makeCtx('admin'), { addonId: 'x' })
    expect(d.ok && d.value).toMatchObject({ allowRestoreId: true, kinds: [{ id: 'a' }] })
    const l = await invokeProcedure(router, 'listInstances', makeCtx('admin'), { addonId: 'x' })
    expect(l.ok && l.value).toMatchObject([
      { kind: 'a', status: { label: 'Signed in' }, lastCheckedAt: 42 },
    ])
  })

  it('createInstance accepts no id (the provider mints it) and forwards the kind', async () => {
    const provider = makeProvider()
    const router = buildCapRouterForTest('integration-instances', () => provider)
    const r = await invokeProcedure(router, 'createInstance', makeCtx('admin'), {
      addonId: 'x',
      name: 'One',
      kind: 'a',
    })
    expect(r.ok && r.value).toEqual({ id: 'minted-1' })
    expect(provider.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'One', kind: 'a' }),
    )
  })

  it('every method stays admin-only', async () => {
    const router = buildCapRouterForTest('integration-instances', makeProvider)
    for (const [path, input] of [
      ['describe', { addonId: 'x' }],
      ['createInstance', { addonId: 'x', name: 'n' }],
    ] as const) {
      const r = await invokeProcedure(router, path, makeCtx('user'), input)
      expect(r.ok).toBe(false)
    }
  })
})
