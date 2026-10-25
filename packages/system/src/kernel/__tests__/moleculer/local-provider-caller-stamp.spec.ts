/**
 * Co-located `localProviderLink` must stamp `callerAddonId` for caps whose
 * provider reads it (records, keychain, …). `ctx.records` reaches the sqlite
 * provider through this short-circuit on agent/hub broker contexts; without
 * the stamp the provider refuses `records/no-caller`.
 */
import { observable } from '@trpc/server/observable'
import { describe, expect, it, vi } from 'vitest'
import type { LocalProviderResolver } from '../../moleculer/trpc-links.js'
import { localProviderLink } from '../../moleculer/trpc-links.js'

const CALLER = 'storage-orchestrator'

async function runLocalOp(
  resolver: LocalProviderResolver,
  path: string,
  input: unknown,
  callerAddonId: string,
): Promise<unknown> {
  const link = localProviderLink(resolver, {
    callerAddonId,
    providerAddonIdForCap: () => null,
    observer: () => {},
  })({})
  const next = vi.fn(() =>
    observable((observer) => {
      observer.error(new Error('fell through'))
      return () => {}
    }),
  )
  const op = {
    id: 1,
    type: 'mutation' as const,
    path,
    input,
    context: {},
    signal: null,
  }
  return new Promise((resolve, reject) => {
    link({ op, next }).subscribe({
      next: (envelope: unknown) => {
        const result = (envelope as { result?: { data?: unknown } }).result
        resolve(result?.data)
      },
      error: reject,
      complete: () => {},
    })
  })
}

describe('localProviderLink — caller stamp on co-located provider', () => {
  it('stamps callerAddonId on records.declareKinds for ctx.records', async () => {
    const declareKinds = vi.fn(async () => ({ kinds: {} }))
    const resolver: LocalProviderResolver = {
      getByName: (cap) => (cap === 'records' ? { declareKinds } : null),
    }
    await runLocalOp(
      resolver,
      'records.declareKinds',
      { kinds: { loc: { database: 'settings', class: 'config' } } },
      CALLER,
    )
    expect(declareKinds).toHaveBeenCalledOnce()
    expect(declareKinds).toHaveBeenCalledWith(expect.objectContaining({ callerAddonId: CALLER }))
  })

  it('overwrites a spoofed callerAddonId on the wire input', async () => {
    const declareKinds = vi.fn(async () => ({ kinds: {} }))
    const resolver: LocalProviderResolver = {
      getByName: (cap) => (cap === 'records' ? { declareKinds } : null),
    }
    await runLocalOp(
      resolver,
      'records.declareKinds',
      { kinds: {}, callerAddonId: 'other-addon' },
      CALLER,
    )
    expect(declareKinds).toHaveBeenCalledWith(expect.objectContaining({ callerAddonId: CALLER }))
  })
})
