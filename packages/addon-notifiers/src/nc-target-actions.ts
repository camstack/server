/**
 * nc-target-actions — the `notifiers` target-bridge action catalog.
 *
 * The Notification Center viewer NEVER adds a cap method: every target
 * read/write rides the generic `addons.custom` bridge (`{ addonId, action,
 * input }`) with a per-action `nc.*` name, and THIS module enforces the
 * per-action auth + ownership server-side (spec C1/C2). The addon id is
 * `'notifiers'`.
 *
 * Ownership model (spec §2 / §5 — server-derived, never client-trusted):
 *  - A PERSONAL target carries its owner INSIDE the open `config.ownerUserId`
 *    blob (train-free, additive — no `notification-output` schema change). This
 *    matches the A6 rule-bridge's target-ownership check verbatim
 *    (`target.config['ownerUserId']`).
 *  - `ownerUserId` absent = a legacy admin/global target (owned by no viewer
 *    user); the viewer never sees or mutates those through this bridge.
 *  - `nc.listMyTargets` returns ONLY the caller's own targets.
 *  - `nc.upsertMyTarget` STAMPS `config.ownerUserId` from the caller (stripping
 *    any client-supplied value) and, on edit, requires the existing row to be
 *    caller-owned. A client-suggested id that collides with a FOREIGN target is
 *    minted fresh so a viewer can never edit or clobber another user's row.
 *  - `nc.deleteMyTarget` / `nc.setMyTargetEnabled` / `nc.testMyTarget` operate
 *    ONLY on caller-owned targets.
 *
 * FAIL-CLOSED: an absent forwarded caller (UDS version-skew can still deliver
 * `undefined`) is rejected before any ownership decision — never treated as
 * admin/global.
 *
 * Secret redaction (on read) + secret merge (on write) is the underlying
 * `notification-output` provider's concern (`provider.ts` / `secrets.ts`): this
 * bridge wraps that provider, so `nc.listMyTargets` returns already-redacted
 * rows and `nc.upsertMyTarget` inherits the stored-secret merge (the viewer's
 * blank-seed round-trip). `config.ownerUserId` is NOT a password field, so it
 * survives redaction and remains the ownership key on read.
 */
import { z } from 'zod'
import {
  customAction,
  defineCustomActions,
  TargetKindSchema,
  TargetSchema,
  type CustomActionCaller,
  type INotificationOutputProvider,
  type IScopedLogger,
  type Target,
} from '@camstack/types'

/**
 * The action catalog — the tRPC contract Group B (the viewer client) consumes
 * against `addonId: 'notifiers'`. Every entry that depends on the caller
 * identity is declared `caller: 'required'` so the dispatcher forwards the
 * server-derived `{ userId, isAdmin }` as the handler's second argument.
 */
export const ncTargetActions = defineCustomActions({
  'nc.listMyTargets': customAction(z.object({}), z.object({ targets: z.array(TargetSchema) }), {
    caller: 'required',
  }),
  'nc.listTargetKinds': customAction(z.object({}), z.object({ kinds: z.array(TargetKindSchema) })),
  'nc.upsertMyTarget': customAction(
    z.object({ target: TargetSchema }),
    z.object({ target: TargetSchema }),
    { kind: 'mutation', caller: 'required' },
  ),
  'nc.deleteMyTarget': customAction(
    z.object({ targetId: z.string() }),
    z.object({ success: z.literal(true) }),
    { kind: 'mutation', caller: 'required' },
  ),
  'nc.setMyTargetEnabled': customAction(
    z.object({ targetId: z.string(), enabled: z.boolean() }),
    z.object({ success: z.literal(true) }),
    { kind: 'mutation', caller: 'required' },
  ),
  'nc.testMyTarget': customAction(
    z.object({ targetId: z.string() }),
    z.object({ success: z.boolean(), error: z.string().optional() }),
    { kind: 'mutation', caller: 'required' },
  ),
})

export type NcTargetActions = typeof ncTargetActions

/**
 * The typed handler map — one async handler per catalog entry, shaped exactly
 * like `AddonInitResult.actionHandlers` so it drops straight into the addon's
 * init result.
 */
export type NcTargetActionHandlers = {
  readonly [K in keyof NcTargetActions & string]: (
    input: z.infer<NcTargetActions[K]['input']>,
    caller?: CustomActionCaller,
  ) => Promise<z.infer<NcTargetActions[K]['output']>>
}

/**
 * The subset of the `notification-output` cap surface the bridge wraps. The
 * addon passes its already-built provider straight in — redaction + secret
 * merge stay in the provider, never re-implemented here.
 */
export type NcTargetProvider = Pick<
  INotificationOutputProvider,
  | 'listTargets'
  | 'listTargetKinds'
  | 'upsertTarget'
  | 'deleteTarget'
  | 'setTargetEnabled'
  | 'testTarget'
>

export interface NcTargetActionDeps {
  readonly provider: NcTargetProvider
  readonly logger: IScopedLogger
}

/** The open-blob ownership key — matches the A6 rule-bridge check verbatim. */
const OWNER_KEY = 'ownerUserId'

const ownerOf = (target: Target): unknown => target.config[OWNER_KEY]

/** Fail-closed caller resolution — an absent forwarded caller is NEVER admin. */
function requireCaller(caller: CustomActionCaller | undefined): CustomActionCaller {
  if (!caller || typeof caller.userId !== 'string' || caller.userId.length === 0) {
    throw new Error('forbidden: authenticated caller required')
  }
  return caller
}

/** Mint a fresh, collision-resistant target id (kind-prefixed for readability). */
function mintTargetId(kind: string): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${kind}-${Date.now()}-${rand}`
}

export function makeNcTargetHandlers(deps: NcTargetActionDeps): NcTargetActionHandlers {
  /** A caller-owned target — must exist AND carry the caller's ownerUserId. */
  const assertOwns = async (targetId: string, userId: string): Promise<Target> => {
    const target = (await deps.provider.listTargets({})).find((t) => t.id === targetId)
    if (!target || ownerOf(target) !== userId) {
      throw new Error(`forbidden: target not owned: ${targetId}`)
    }
    return target
  }

  return {
    'nc.listMyTargets': async (_input, caller) => {
      const c = requireCaller(caller)
      // The provider already redacts secrets; ownerUserId is not a secret so it
      // survives redaction and stays the ownership key here.
      const own = (await deps.provider.listTargets({})).filter((t) => ownerOf(t) === c.userId)
      return { targets: own }
    },

    'nc.listTargetKinds': async () => ({ kinds: await deps.provider.listTargetKinds({}) }),

    'nc.upsertMyTarget': async (input, caller) => {
      const c = requireCaller(caller)
      const all = await deps.provider.listTargets({})
      const suggestedId = input.target.id
      const existing = suggestedId.length > 0 ? all.find((t) => t.id === suggestedId) : undefined

      // Server mints/validates the id: reuse the suggestion only when it is a
      // caller-owned edit; a foreign collision or an empty id gets a fresh id so
      // a viewer can never edit or clobber another user's row.
      const id =
        existing !== undefined
          ? ownerOf(existing) === c.userId
            ? suggestedId
            : mintTargetId(input.target.kind)
          : suggestedId.length > 0
            ? suggestedId
            : mintTargetId(input.target.kind)

      // Stamp ownership from the caller, stripping any client-supplied owner.
      const stamped: Target = {
        ...input.target,
        id,
        config: { ...input.target.config, [OWNER_KEY]: c.userId },
      }
      // Delegate to the cap provider — it merges stored secrets the viewer left
      // as the redaction marker and returns the redacted row.
      const saved = await deps.provider.upsertTarget({ target: stamped })
      deps.logger.info('nc target upserted', { meta: { targetId: saved.id, owner: c.userId } })
      return { target: saved }
    },

    'nc.deleteMyTarget': async (input, caller) => {
      const c = requireCaller(caller)
      await assertOwns(input.targetId, c.userId)
      await deps.provider.deleteTarget({ targetId: input.targetId })
      deps.logger.info('nc target deleted', { meta: { targetId: input.targetId, owner: c.userId } })
      return { success: true }
    },

    'nc.setMyTargetEnabled': async (input, caller) => {
      const c = requireCaller(caller)
      await assertOwns(input.targetId, c.userId)
      await deps.provider.setTargetEnabled({ targetId: input.targetId, enabled: input.enabled })
      return { success: true }
    },

    'nc.testMyTarget': async (input, caller) => {
      const c = requireCaller(caller)
      await assertOwns(input.targetId, c.userId)
      const res = await deps.provider.testTarget({ targetId: input.targetId })
      return { success: res.success, ...(res.error !== undefined ? { error: res.error } : {}) }
    },
  }
}
