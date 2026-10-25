/**
 * Unit tests for the `notifiers` NC target-bridge actions.
 *
 * These drive the pure handler map (`makeNcTargetHandlers`) over a fake target
 * provider matching the `notification-output` cap surface. They assert the
 * server-side ownership + fail-closed contract (spec §5 / C1/C2):
 *  - every `caller:'required'` action rejects an absent caller (UDS skew),
 *  - `nc.listMyTargets` returns ONLY the caller's targets,
 *  - `ownerUserId` is stamped from the caller and can never be set/overridden
 *    from the client payload,
 *  - delete/test/setEnabled operate only on caller-owned targets,
 *  - a client-suggested id that collides with ANOTHER user's target is minted
 *    fresh (never clobbers or edits a foreign row),
 *  - the target-level `enabled` flag is preserved through an upsert.
 *
 * Secret redaction + merge is the provider's concern (`secrets.ts`, covered by
 * `provider.spec.ts`); these tests verify the handlers DELEGATE to it (they pass
 * the stamped target straight to `provider.upsertTarget` and return whatever it
 * hands back).
 */
import type { IScopedLogger, SendResult, Target, TargetKind } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeNcTargetHandlers, type NcTargetProvider } from '../nc-target-actions.js'

// ── Fake provider (the `notification-output` cap subset the bridge wraps) ────

interface FakeCtx {
  readonly targets: Map<string, Target>
  readonly handlers: ReturnType<typeof makeNcTargetHandlers>
  readonly upsertCalls: Target[]
  readonly enabledCalls: Array<{ targetId: string; enabled: boolean }>
  readonly testedIds: string[]
}

const noopLogger: IScopedLogger = {
  info() {},
  warn() {},
  debug() {},
  error() {},
  child: () => noopLogger,
  withTags: () => noopLogger,
}

function makeCtx(): FakeCtx {
  const targets = new Map<string, Target>()
  const upsertCalls: Target[] = []
  const enabledCalls: Array<{ targetId: string; enabled: boolean }> = []
  const testedIds: string[] = []
  const provider: NcTargetProvider = {
    listTargets: async () => [...targets.values()],
    listTargetKinds: async (): Promise<TargetKind[]> => [
      {
        kind: 'ntfy',
        label: 'ntfy',
        icon: '',
        addonId: 'notifiers',
        configSchema: { sections: [] },
        supportsDiscovery: false,
        caps: {
          attachments: { mediaTypes: [], mode: 'url', max: 0 },
          actions: 0,
          levels: [],
          format: ['text'],
          clickUrl: false,
          sound: false,
          ttl: false,
          bodyMaxLen: 1000,
        },
      },
    ],
    upsertTarget: async ({ target }): Promise<Target> => {
      upsertCalls.push(target)
      targets.set(target.id, target)
      return target
    },
    deleteTarget: async ({ targetId }): Promise<void> => {
      targets.delete(targetId)
    },
    setTargetEnabled: async ({ targetId, enabled }): Promise<void> => {
      enabledCalls.push({ targetId, enabled })
      const t = targets.get(targetId)
      if (t) targets.set(targetId, { ...t, enabled })
    },
    testTarget: async ({ targetId }): Promise<SendResult> => {
      testedIds.push(targetId)
      return { success: true }
    },
  }
  return {
    targets,
    upsertCalls,
    enabledCalls,
    testedIds,
    handlers: makeNcTargetHandlers({ provider, logger: noopLogger }),
  }
}

function seed(targets: Map<string, Target>, id: string, ownerUserId: string | undefined): void {
  const config: Record<string, unknown> = ownerUserId === undefined ? {} : { ownerUserId }
  targets.set(id, { id, name: id, kind: 'ntfy', addonId: 'notifiers', enabled: true, config })
}

const U1 = { userId: 'u1', isAdmin: false } as const

function newTarget(overrides: Partial<Target> = {}): Target {
  return {
    id: 'ntfy-123',
    name: 'n',
    kind: 'ntfy',
    addonId: 'notifiers',
    enabled: true,
    config: {},
    ...overrides,
  }
}

// ── listMyTargets ───────────────────────────────────────────────────────────

describe('nc.listMyTargets', () => {
  it('returns only caller-owned targets', async () => {
    const { targets, handlers } = makeCtx()
    seed(targets, 'a', 'u1')
    seed(targets, 'b', undefined) // admin/global (legacy)
    seed(targets, 'c', 'u2') // another user
    const res = await handlers['nc.listMyTargets']({}, U1)
    expect(res.targets.map((t) => t.id)).toEqual(['a'])
  })

  it('fails closed when the caller is absent', async () => {
    const { handlers } = makeCtx()
    await expect(handlers['nc.listMyTargets']({}, undefined)).rejects.toThrow(/forbidden|caller/i)
  })
})

// ── listTargetKinds ─────────────────────────────────────────────────────────

describe('nc.listTargetKinds', () => {
  it('passes the provider catalog through (no caller required)', async () => {
    const { handlers } = makeCtx()
    const res = await handlers['nc.listTargetKinds']({}, undefined)
    expect(res.kinds.map((k) => k.kind)).toEqual(['ntfy'])
  })
})

// ── upsertMyTarget ──────────────────────────────────────────────────────────

describe('nc.upsertMyTarget', () => {
  it('stamps ownerUserId from the caller on create', async () => {
    const { handlers } = makeCtx()
    const res = await handlers['nc.upsertMyTarget']({ target: newTarget() }, U1)
    expect(res.target.config['ownerUserId']).toBe('u1')
  })

  it('strips a client-supplied ownerUserId and re-stamps the caller', async () => {
    const { handlers, upsertCalls } = makeCtx()
    await handlers['nc.upsertMyTarget'](
      { target: newTarget({ config: { ownerUserId: 'attacker', token: 't' } }) },
      U1,
    )
    expect(upsertCalls[0]?.config['ownerUserId']).toBe('u1')
    expect(upsertCalls[0]?.config['token']).toBe('t') // non-owner config preserved
  })

  it('edits a caller-owned target in place (keeps its id)', async () => {
    const { targets, handlers, upsertCalls } = makeCtx()
    seed(targets, 'ntfy-123', 'u1')
    await handlers['nc.upsertMyTarget'](
      { target: newTarget({ id: 'ntfy-123', name: 'renamed' }) },
      U1,
    )
    expect(upsertCalls[0]?.id).toBe('ntfy-123')
    expect(upsertCalls[0]?.name).toBe('renamed')
  })

  it('mints a fresh id when the suggested id collides with a foreign target', async () => {
    const { targets, handlers, upsertCalls } = makeCtx()
    seed(targets, 'ntfy-123', 'u2') // owned by someone else
    const res = await handlers['nc.upsertMyTarget']({ target: newTarget({ id: 'ntfy-123' }) }, U1)
    expect(res.target.id).not.toBe('ntfy-123')
    expect(upsertCalls[0]?.id).not.toBe('ntfy-123')
    // the foreign row is untouched
    expect(targets.get('ntfy-123')?.config['ownerUserId']).toBe('u2')
  })

  it('mints a fresh id when the suggested id is empty', async () => {
    const { handlers, upsertCalls } = makeCtx()
    await handlers['nc.upsertMyTarget']({ target: newTarget({ id: '' }) }, U1)
    expect((upsertCalls[0]?.id ?? '').length).toBeGreaterThan(0)
  })

  it('preserves the target-level enabled flag (kill-switch)', async () => {
    const { handlers, upsertCalls } = makeCtx()
    await handlers['nc.upsertMyTarget']({ target: newTarget({ enabled: false }) }, U1)
    expect(upsertCalls[0]?.enabled).toBe(false)
  })

  it('fails closed when the caller is absent', async () => {
    const { handlers } = makeCtx()
    await expect(handlers['nc.upsertMyTarget']({ target: newTarget() }, undefined)).rejects.toThrow(
      /forbidden|caller/i,
    )
  })
})

// ── deleteMyTarget ──────────────────────────────────────────────────────────

describe('nc.deleteMyTarget', () => {
  it('deletes a caller-owned target', async () => {
    const { targets, handlers } = makeCtx()
    seed(targets, 'a', 'u1')
    const res = await handlers['nc.deleteMyTarget']({ targetId: 'a' }, U1)
    expect(res).toEqual({ success: true })
    expect(targets.has('a')).toBe(false)
  })

  it('refuses a non-owned target', async () => {
    const { targets, handlers } = makeCtx()
    seed(targets, 'b', 'u2')
    await expect(handlers['nc.deleteMyTarget']({ targetId: 'b' }, U1)).rejects.toThrow(
      /forbidden|not owned/i,
    )
    expect(targets.has('b')).toBe(true)
  })

  it('refuses a legacy/global (unowned) target', async () => {
    const { targets, handlers } = makeCtx()
    seed(targets, 'g', undefined)
    await expect(handlers['nc.deleteMyTarget']({ targetId: 'g' }, U1)).rejects.toThrow(
      /forbidden|not owned/i,
    )
  })

  it('fails closed when the caller is absent', async () => {
    const { targets, handlers } = makeCtx()
    seed(targets, 'a', 'u1')
    await expect(handlers['nc.deleteMyTarget']({ targetId: 'a' }, undefined)).rejects.toThrow(
      /forbidden|caller/i,
    )
  })
})

// ── setMyTargetEnabled ──────────────────────────────────────────────────────

describe('nc.setMyTargetEnabled', () => {
  it('toggles a caller-owned target', async () => {
    const { targets, handlers, enabledCalls } = makeCtx()
    seed(targets, 'a', 'u1')
    const res = await handlers['nc.setMyTargetEnabled']({ targetId: 'a', enabled: false }, U1)
    expect(res).toEqual({ success: true })
    expect(enabledCalls).toEqual([{ targetId: 'a', enabled: false }])
  })

  it('refuses a non-owned target', async () => {
    const { targets, handlers } = makeCtx()
    seed(targets, 'b', 'u2')
    await expect(
      handlers['nc.setMyTargetEnabled']({ targetId: 'b', enabled: false }, U1),
    ).rejects.toThrow(/forbidden|not owned/i)
  })

  it('fails closed when the caller is absent', async () => {
    const { targets, handlers } = makeCtx()
    seed(targets, 'a', 'u1')
    await expect(
      handlers['nc.setMyTargetEnabled']({ targetId: 'a', enabled: false }, undefined),
    ).rejects.toThrow(/forbidden|caller/i)
  })
})

// ── testMyTarget ────────────────────────────────────────────────────────────

describe('nc.testMyTarget', () => {
  it('tests a caller-owned target', async () => {
    const { targets, handlers, testedIds } = makeCtx()
    seed(targets, 'a', 'u1')
    const res = await handlers['nc.testMyTarget']({ targetId: 'a' }, U1)
    expect(res.success).toBe(true)
    expect(testedIds).toEqual(['a'])
  })

  it('refuses a non-owned target', async () => {
    const { targets, handlers } = makeCtx()
    seed(targets, 'b', 'u2')
    await expect(handlers['nc.testMyTarget']({ targetId: 'b' }, U1)).rejects.toThrow(
      /forbidden|not owned/i,
    )
  })

  it('fails closed when the caller is absent', async () => {
    const { targets, handlers } = makeCtx()
    seed(targets, 'a', 'u1')
    await expect(handlers['nc.testMyTarget']({ targetId: 'a' }, undefined)).rejects.toThrow(
      /forbidden|caller/i,
    )
  })
})
