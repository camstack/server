import { z } from 'zod'
import { COMPOSER_ADDON_ID, CompositionSchema } from '../composition/composition.js'
import {
  CompositionBlockStateSchema,
  CompositionRunStatusSchema,
} from '../composition/composition-report.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * composer — runs every DECLARATIVE composition (D659).
 *
 * Internal and admin-only: its one caller is `core-blocks`' supervisor, which
 * sends the WHOLE set of composition blocks on every converge (idempotent),
 * and reads their state for the API. Nothing else talks to it.
 */

/** The composer's runner id, `resolveRunnerId(decl, 'composer')`; pinned by `composer-manifest.spec.ts`. */
export const COMPOSER_RUNNER_ID = COMPOSER_ADDON_ID

export const ComposerBlockSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  enabled: z.boolean(),
  updatedAt: z.number(),
  composition: CompositionSchema,
})
export type ComposerBlock = z.infer<typeof ComposerBlockSchema>

/**
 * A stored composition row that no longer PARSES — a schema a release
 * tightened, a row written by a newer build. Sent by id so the composer keeps
 * its device as a placeholder and reports the block `failed` naming the parse
 * error. Leaving it out would read, twice, exactly like a delete (D49).
 */
export const ComposerUnreadableBlockSchema = z.object({
  id: z.string().min(1),
  /** The row's stored name column; null when even that is unreadable (the device keeps the name it has). */
  name: z.string().nullable(),
  /** The parse error, in the operator's words. */
  error: z.string(),
})
export type ComposerUnreadableBlock = z.infer<typeof ComposerUnreadableBlockSchema>

/** A confirmed release the hub did not accept. `deviceId` is the claim's device. */
export const UnreleasedClaimSchema = z.object({
  deviceId: z.number().int(),
  capName: z.string(),
  owner: z.string(),
  error: z.string(),
})
export type UnreleasedClaim = z.infer<typeof UnreleasedClaimSchema>

export const ComposerApplyInputSchema = z.object({
  /** The shared Blocks integration; null until `core-blocks` has reconciled it. */
  integrationId: z.string().nullable(),
  /** False when the `core_blocks` read failed: then nothing may be withdrawn (D49). */
  storeLoaded: z.boolean(),
  blocks: z.array(ComposerBlockSchema),
  /** Operator restarts: rebuild these runtimes and re-resolve their sources. Stores nothing (D62). */
  restartBlockIds: z.array(z.string()),
  /** Composition rows that exist but do not parse: held, never withdrawn, reported failed. */
  unreadableBlocks: z.array(ComposerUnreadableBlockSchema),
  /**
   * Operator-confirmed deletions. Their claims are released on this apply,
   * before any replacement block claims. A block that merely vanished from the
   * snapshot is not listed here and still waits for two applies (D49).
   */
  retiredBlockIds: z.array(z.string()).optional(),
})
export type ComposerApplyInput = z.infer<typeof ComposerApplyInputSchema>

export const ComposerBlockVerdictSchema = z.object({
  blockId: z.string(),
  status: CompositionRunStatusSchema,
  reason: z.string().optional(),
})
export type ComposerBlockVerdict = z.infer<typeof ComposerBlockVerdictSchema>

export const ComposerApplyResultSchema = z.object({
  blocks: z.array(ComposerBlockVerdictSchema),
  /**
   * False when the composer declared and withdrew NOTHING (store not loaded,
   * integration unknown, its own rows unread or read empty once). An empty
   * apply the caller owes is paid off only by one the composer acted on (D49).
   */
  acted: z.boolean(),
  /**
   * Confirmed releases this apply tried and the hub did not accept. Empty when
   * every one landed (or there was nothing to hand back). Absent on a result
   * that never got that far.
   */
  unreleasedClaims: z.array(UnreleasedClaimSchema).optional(),
})
export type ComposerApplyResult = z.infer<typeof ComposerApplyResultSchema>

export const composerCapability = {
  name: 'composer',
  scope: 'system',
  mode: 'singleton',
  internal: true,
  methods: {
    /**
     * Not `apply`: tRPC reserves `apply`, `call` and `then` as router keys, and
     * `router({})` throws on one — every cap router is built at boot.
     */
    applyBlocks: method(ComposerApplyInputSchema, ComposerApplyResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    getStates: method(
      z.object({ blockIds: z.array(z.string()) }),
      z.object({ states: z.array(CompositionBlockStateSchema) }),
      { auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IComposerProvider = InferProvider<typeof composerCapability>
