/**
 * Tests for `dispatchCustomAction` — the LIVE dispatch behind `api.addons.custom`
 * (the generic addon custom-action dispatcher). This is the exact function the
 * `buildAddonsProvider(...).custom` cap-provider handler delegates to, so these
 * assertions guard the real code path (not a parallel dead router).
 *
 * Verifies:
 *   - dispatch to a registered action returns the addon's value
 *   - input is round-tripped through the action's Zod schema
 *   - unknown (addonId, action) → NOT_FOUND
 *   - per-action `auth: 'admin'` is enforced (non-admin user rejected, admin allowed)
 *   - unauthenticated caller against a non-public action → UNAUTHORIZED
 *   - addon output that violates its own schema → parse error (crash-early)
 *   - caller-forwarding (Task A2): `caller: 'required'` receives the principal;
 *     opted-out actions keep the legacy single-argument behavior
 *
 * The OUTER cap mount (`addons.custom`) is declared `protected`, so
 * unauthenticated callers are rejected before dispatch runs. That mount-level
 * gate is covered by the generic cap-router auth matrix, not here — this file
 * exercises the per-action dispatch logic.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { customAction, defineCustomActions } from '@camstack/types'
import type { CustomActionCaller } from '@camstack/types'
import { CustomActionRegistry } from '@camstack/system'
import { dispatchCustomAction } from '../cap-providers.js'
import { makeCtx } from '../../../__tests__/cap-routers/harness.js'

const catalog = defineCustomActions({
  ping: customAction(z.void(), z.literal('pong')),
  echo: customAction(z.object({ msg: z.string() }), z.object({ msg: z.string() })),
  adminOnly: customAction(z.void(), z.literal('ok'), { kind: 'mutation', auth: 'admin' }),
  open: customAction(z.void(), z.literal('open'), { auth: 'public' }),
  badOutput: customAction(z.void(), z.literal('expected')),
})

function buildRegistry(): CustomActionRegistry {
  const registry = new CustomActionRegistry()
  registry.registerAddon('benchmark', catalog, async (action, input) => {
    switch (action) {
      case 'ping':
        return 'pong'
      case 'echo':
        return { msg: (input as { msg: string }).msg }
      case 'adminOnly':
        return 'ok'
      case 'open':
        return 'open'
      case 'badOutput':
        return 'WRONG' // will fail output validation
      default:
        throw new Error(`unknown action ${action}`)
    }
  })
  return registry
}

describe('dispatchCustomAction (api.addons.custom live path)', () => {
  let registry: CustomActionRegistry

  beforeEach(() => {
    registry = buildRegistry()
  })

  it('dispatches a void/literal action and returns the addon value', async () => {
    const result = await dispatchCustomAction(registry, makeCtx('admin'), {
      addonId: 'benchmark',
      action: 'ping',
      input: undefined,
    })
    expect(result).toBe('pong')
  })

  it('round-trips structured input through the action schema', async () => {
    const result = await dispatchCustomAction(registry, makeCtx('admin'), {
      addonId: 'benchmark',
      action: 'echo',
      input: { msg: 'hi' },
    })
    expect(result).toEqual({ msg: 'hi' })
  })

  it('rejects unknown (addonId, action) with NOT_FOUND', async () => {
    await expect(
      dispatchCustomAction(registry, makeCtx('admin'), {
        addonId: 'benchmark',
        action: 'missing',
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await expect(
      dispatchCustomAction(registry, makeCtx('admin'), {
        addonId: 'unknown-addon',
        action: 'ping',
        input: undefined,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects unauthenticated callers against a non-public action with UNAUTHORIZED', async () => {
    await expect(
      dispatchCustomAction(registry, makeCtx('anonymous'), {
        addonId: 'benchmark',
        action: 'ping',
        input: undefined,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('enforces per-action auth: admin-only action rejects a non-admin user', async () => {
    await expect(
      dispatchCustomAction(registry, makeCtx('user'), {
        addonId: 'benchmark',
        action: 'adminOnly',
        input: undefined,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('enforces per-action auth: admin-only action allows admin', async () => {
    const result = await dispatchCustomAction(registry, makeCtx('admin'), {
      addonId: 'benchmark',
      action: 'adminOnly',
      input: undefined,
    })
    expect(result).toBe('ok')
  })

  it('rejects bad input against the action schema', async () => {
    await expect(
      dispatchCustomAction(registry, makeCtx('admin'), {
        addonId: 'benchmark',
        action: 'echo',
        input: { msg: 123 },
      }),
    ).rejects.toBeInstanceOf(Error)
  })

  it('rejects bad addon output against the action schema (crash-early)', async () => {
    await expect(
      dispatchCustomAction(registry, makeCtx('admin'), {
        addonId: 'benchmark',
        action: 'badOutput',
        input: undefined,
      }),
    ).rejects.toBeInstanceOf(Error)
  })

  it('permits a public action without an authenticated caller (mount gate is separate)', async () => {
    const result = await dispatchCustomAction(registry, makeCtx('anonymous'), {
      addonId: 'benchmark',
      action: 'open',
      input: undefined,
    })
    expect(result).toBe('open')
  })

  it('TRPCError carries a descriptive message for unknown actions', async () => {
    try {
      await dispatchCustomAction(registry, makeCtx('admin'), {
        addonId: 'benchmark',
        action: 'missing',
        input: {},
      })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError)
      expect((err as TRPCError).message).toMatch(/no custom action 'missing'/)
    }
  })

  // ── The addonId is the MANIFEST id, never the npm package name ────────
  //
  // `addons.custom` keys on `camstack.addons[].id`. A caller who reaches for
  // the package name (`@camstack/addon-post-analysis` instead of
  // `pipeline-analytics`) gets a NOT_FOUND that is indistinguishable from "the
  // addon is broken / the action never registered" — that exact ambiguity cost
  // a session on 2026-08-08, spent hunting a require-cache fix that was
  // working. The message must say WHICH ids exist so the next caller reads the
  // answer instead of diagnosing it.
  it('names the addons that DO have custom actions when the addonId is unknown', async () => {
    try {
      await dispatchCustomAction(registry, makeCtx('admin'), {
        addonId: '@camstack/addon-benchmark',
        action: 'ping',
        input: undefined,
      })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError)
      const message = (err as TRPCError).message
      expect(message).toMatch(/no addon '@camstack\/addon-benchmark'/)
      expect(message).toMatch(/benchmark/)
      expect(message).toMatch(/manifest addon id, not the npm package name/)
    }
  })

  it('names the addon’s own actions when the action is unknown', async () => {
    try {
      await dispatchCustomAction(registry, makeCtx('admin'), {
        addonId: 'benchmark',
        action: 'missing',
        input: {},
      })
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as TRPCError).message).toMatch(/known actions: .*\bping\b/)
    }
  })
})

// ── caller-forwarding (Task A2) ─────────────────────────────────────────
//
// A `caller:'required'` action receives the authenticated caller as an
// optional second handler argument. Actions that do NOT opt in keep the
// legacy single-argument behavior (caller arrives `undefined`).
const callerCatalog = defineCustomActions({
  whoami: customAction(z.object({}), z.object({ userId: z.string() }), {
    kind: 'mutation',
    auth: 'protected',
    caller: 'required',
  }),
  legacy: customAction(z.object({}), z.object({ sawCaller: z.boolean() }), {
    kind: 'mutation',
    auth: 'protected',
  }),
})

describe('dispatchCustomAction — caller-forwarding', () => {
  it('forwards the authenticated caller to a caller:required action', async () => {
    const seen: Array<CustomActionCaller | undefined> = []
    const registry = new CustomActionRegistry()
    registry.registerAddon('nc', callerCatalog, async (action, _input, caller) => {
      if (action === 'whoami') {
        seen.push(caller)
        return { userId: caller?.userId ?? 'NONE' }
      }
      return { sawCaller: caller !== undefined }
    })
    const res = await dispatchCustomAction(registry, makeCtx('user', { id: 'u1' }), {
      addonId: 'nc',
      action: 'whoami',
      input: {},
    })
    expect(res).toEqual({ userId: 'u1' })
    expect(seen[0]).toEqual({ userId: 'u1', isAdmin: false })
  })

  it('forwards isAdmin=true for an admin caller', async () => {
    const seen: Array<CustomActionCaller | undefined> = []
    const registry = new CustomActionRegistry()
    registry.registerAddon('nc', callerCatalog, async (action, _input, caller) => {
      if (action === 'whoami') {
        seen.push(caller)
        return { userId: caller?.userId ?? 'NONE' }
      }
      return { sawCaller: caller !== undefined }
    })
    await dispatchCustomAction(registry, makeCtx('admin', { id: 'admin-1' }), {
      addonId: 'nc',
      action: 'whoami',
      input: {},
    })
    expect(seen[0]).toEqual({ userId: 'admin-1', isAdmin: true })
  })

  it('does NOT forward a caller to an action that did not opt in', async () => {
    const seen: Array<CustomActionCaller | undefined> = []
    const registry = new CustomActionRegistry()
    registry.registerAddon('nc', callerCatalog, async (action, _input, caller) => {
      seen.push(caller)
      if (action === 'whoami') return { userId: caller?.userId ?? 'NONE' }
      return { sawCaller: caller !== undefined }
    })
    const res = await dispatchCustomAction(registry, makeCtx('user', { id: 'u1' }), {
      addonId: 'nc',
      action: 'legacy',
      input: {},
    })
    expect(res).toEqual({ sawCaller: false })
    expect(seen[0]).toBeUndefined()
  })
})
