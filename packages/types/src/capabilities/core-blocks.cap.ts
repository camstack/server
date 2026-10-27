import { z } from 'zod'
import { AutomationRecipeSchema, MAX_TRACE_KEEP } from '../automation/recipe.js'
import { AutomationRunTraceSchema, AutomationStateDocSchema } from '../automation/trace.js'
import { ComposableCapabilitiesSchema } from '../composition/composable-caps.js'
import { type Composition, CompositionSchema } from '../composition/composition.js'
import {
  CompositionBlockStateSchema,
  CompositionValidationSchema,
} from '../composition/composition-report.js'
import { DeviceType } from '../device/device-type.js'
import type { ConfigUISchema } from '../interfaces/config-ui.js'
import {
  SettingsPatchSchema,
  SettingsSchemaWithValuesSchema,
  SettingsUpdateResultSchema,
} from './addon-settings.cap.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import {
  RawSecretMigrationInputSchema,
  RawSecretMigrationReportSchema,
} from './raw-secret-migration.js'

/**
 * core-blocks — user-authored TypeScript, stored in the kernel and executed in
 * its own process.
 *
 * Spec: `docs/superpowers/specs/2026-08-04-core-blocks-and-synthetic-devices-design.md`.
 *
 * The first use is **owning devices without being a device provider**: a block
 * declares devices under a system or custom integration and drives their state,
 * with the same `ctx` an addon gets. Automations come later; nothing here
 * models a trigger.
 *
 * **Stated plainly, because it does not change by being true:** a block has an
 * addon's powers — devices, storage, the event bus, `ctx.api`. It is a plugin
 * with no review step. What makes that survivable is not a sandbox, it is
 * PROCESS ISOLATION: one process per block, supervised by `CrashSupervisor`,
 * so a block that throws or never returns is marked `failed` and visible
 * instead of taking the hub with it (D6). Every method here is admin-only, and
 * must stay so.
 */

/**
 * Prefix for a block's generated addon id AND its runner id — one addon, one
 * process, so the two are the same string (D2).
 *
 * It lives on the CONTRACT rather than beside the code that materialises the
 * package, because it is not an implementation detail: the operator surface
 * reads a block's logs by asking `logs.query` for `addonId = core-block-<id>`,
 * with no cap and no store of its own. Two copies of this string is one copy
 * too many — a drift would show as a logs pane that is simply always empty.
 */
export const CORE_BLOCK_ADDON_PREFIX = 'core-block-'

/**
 * The builtin's own addon id — and, because of that, the OWNER of the
 * integration every block's devices hang from.
 *
 * A block cannot own one. Every integration read is gated on the installed-addon
 * set (`addon-registry.service.ts` → `createFilteredRegistry`) and a block's
 * `core-block-<uuid>` is never in it, so its `getIntegrationByAddonId` answers
 * null forever while the write succeeds — one invisible, undeletable row per
 * start. `core-blocks` IS installed, so it reconciles one shared integration and
 * a block names it by id (`DeclaredDevicesSpec.integrationId`), minting nothing.
 *
 * Exported from the contract, next to the runner prefix and for the same reason:
 * a block reads it as
 * `ctx.api.integrations.getByAddonId.query({ addonId: CORE_BLOCKS_ADDON_ID })`,
 * so a second copy of the string is a block that silently declares into nowhere.
 */
export const CORE_BLOCKS_ADDON_ID = 'core-blocks'

/** The addon/runner id a block's process runs under. */
export function coreBlockAddonId(blockId: string): string {
  return `${CORE_BLOCK_ADDON_PREFIX}${blockId}`
}

/** The block id behind a generated addon/runner id, or null when the id belongs
 *  to something else. The inverse of {@link coreBlockAddonId}. */
export function coreBlockIdFromAddonId(addonId: string): string | null {
  if (!addonId.startsWith(CORE_BLOCK_ADDON_PREFIX)) return null
  const rest = addonId.slice(CORE_BLOCK_ADDON_PREFIX.length)
  return rest.length > 0 ? rest : null
}

/** Where a block runs. The operator chooses — a block driving a device on an
 *  agent is the reason placement is not fixed to the hub. */
export const CoreBlockPlacementSchema = z.union([
  z.literal('hub'),
  /** A specific node id. */
  z.string().min(1),
])
export type CoreBlockPlacement = z.infer<typeof CoreBlockPlacementSchema>

/** What a block's process is doing. Mirrors the addon runner's own lifecycle so
 *  a failing block reads the same way a failing addon does. `degraded` is a
 *  composition on an existing device with a field handed back to the native
 *  provider while its source is unavailable (S1b, D663); the error names it. */
export const CoreBlockStatusSchema = z.enum([
  'stopped',
  'starting',
  'running',
  'degraded',
  'incomplete',
  'failed',
])
export type CoreBlockStatus = z.infer<typeof CoreBlockStatusSchema>

/** Default entry path when a multi-file block omits `entry`. */
export const DEFAULT_CORE_BLOCK_ENTRY = 'main.ts'

/** path → TypeScript source for a multi-file block. */
export const CoreBlockFilesSchema = z.record(z.string().min(1).max(260), z.string().max(200_000))
export type CoreBlockFiles = z.infer<typeof CoreBlockFilesSchema>

/**
 * A block's settings form — the same ConfigUISchema addons declare.
 * Loose on the wire (field variants are polymorphic); typed for callers.
 */
const CoreBlockSettingsSchemaBridge = z.custom<ConfigUISchema>()

/**
 * Client-authored fields (plain object). Kept separate from the refined create
 * schema because Zod 4 refuses `.partial()` on schemas that carry refinements —
 * `update` needs a partial of these fields.
 */
export const CoreBlockInputFieldsSchema = z.object({
  name: z.string().min(1).max(120),
  /**
   * Single-file TypeScript source. Kept for backward compatibility: when
   * `files` is absent, this IS `files[entry]`. On write, if `files` is
   * provided, the server derives `code` from `files[entry]` so compile and
   * runtime paths that still read `code` keep working.
   */
  code: z.string().max(200_000).optional(),
  /** Multi-file project (path → source). Absent = legacy single-file `code`. */
  files: CoreBlockFilesSchema.optional(),
  /** Entry file inside `files`. Default {@link DEFAULT_CORE_BLOCK_ENTRY}. */
  entry: z.string().min(1).max(260).optional(),
  enabled: z.boolean(),
  placement: CoreBlockPlacementSchema,
  /**
   * Integration the block's devices hang from. Absent = the system integration
   * blocks share. A block may declare its own instead.
   */
  integrationId: z.string().optional(),
  /**
   * Cached settings form for this block. Prefer extracting `settingsSchema`
   * from the compiled entry after a successful load; the editor may also set
   * it. Absent ⇒ `getBlockSettings` returns null until one is known.
   */
  settingsSchema: CoreBlockSettingsSchemaBridge.optional(),
})

/** Client-authored fields for create — requires `code` or `files[entry]`. */
export const CoreBlockInputSchema = CoreBlockInputFieldsSchema.superRefine((val, ctx) => {
  const entry = val.entry ?? DEFAULT_CORE_BLOCK_ENTRY
  if (val.files !== undefined) {
    if (val.files[entry] === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `files must include the entry "${entry}"`,
        path: ['files'],
      })
    }
    return
  }
  if (val.code === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'code or files is required',
      path: ['code'],
    })
  }
})
export type CoreBlockInput = z.infer<typeof CoreBlockInputFieldsSchema>

/** Resolve the entry path a block uses (default `main.ts`). */
export function resolveCoreBlockEntry(entry: string | undefined): string {
  return entry !== undefined && entry.length > 0 ? entry : DEFAULT_CORE_BLOCK_ENTRY
}

/**
 * View a block as `{ files, entry }`. When `files` is absent, `code` is
 * treated as `files[entry]` — the migration rule for every pre-multi-file row.
 */
export function resolveCoreBlockFiles(block: {
  readonly code: string
  readonly files?: Readonly<Record<string, string>>
  readonly entry?: string
}): { files: Record<string, string>; entry: string } {
  const entry = resolveCoreBlockEntry(block.entry)
  if (block.files !== undefined) {
    return { files: { ...block.files }, entry }
  }
  return { files: { [entry]: block.code }, entry }
}

/**
 * Normalize a write so the stored row always has `code` (for paths that still
 * read it) derived from `files[entry]` when `files` is provided.
 */
export function normalizeCoreBlockWrite(input: Pick<CoreBlockInput, 'code' | 'files' | 'entry'>): {
  code: string
  files?: Record<string, string>
  entry?: string
} {
  if (input.files !== undefined) {
    const entry = resolveCoreBlockEntry(input.entry)
    const code = input.files[entry] ?? input.code ?? ''
    return { code, files: { ...input.files }, entry }
  }
  return {
    code: input.code ?? '',
    ...(input.entry !== undefined ? { entry: input.entry } : {}),
  }
}

/**
 * What a block IS (D659). Absent means `code` — every row stored before this
 * union keeps working unchanged.
 *  - `code`: the TypeScript in `code`, compiled and run in its own runner;
 *  - `recipe`: RESERVED (automations), stored shape only; refused at run by name;
 *  - `composition`: declarative, run by the shared `composer`; `code` is `''`.
 */
export const CoreBlockSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('code') }),
  z.object({ kind: z.literal('recipe'), recipe: AutomationRecipeSchema }),
  z.object({ kind: z.literal('composition'), composition: CompositionSchema }),
])
export type CoreBlockSource = z.infer<typeof CoreBlockSourceSchema>
export type CoreBlockSourceKind = CoreBlockSource['kind']

/**
 * The client-authored half of a composition block. No `code`, no placement (hub-only; Phase 7).
 *
 * `name`: REQUIRED for a `new` target — the block's name IS the device's name
 * (D659). ABSENT for an `existing` target — a customization has no name of its
 * own; the server derives one (`customizationBlockName`, D663) and refuses a
 * client-sent name by name.
 */
export const CompositionBlockInputSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean(),
  composition: CompositionSchema,
})
export type CompositionBlockInput = z.infer<typeof CompositionBlockInputSchema>
export type CompositionBlockPatch = Partial<CompositionBlockInput>

/** A stored block. `code` is always present after normalize (derived from files). */
export const CoreBlockSchema = z.object({
  name: z.string().min(1).max(120),
  /** Single-file source, or `files[entry]` when multi-file. Always set on disk. */
  code: z.string().max(200_000),
  files: CoreBlockFilesSchema.optional(),
  entry: z.string().min(1).max(260).optional(),
  enabled: z.boolean(),
  placement: CoreBlockPlacementSchema,
  integrationId: z.string().optional(),
  settingsSchema: CoreBlockSettingsSchemaBridge.optional(),
  id: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Server-stamped author. */
  createdBy: z.string(),
  status: CoreBlockStatusSchema,
  /**
   * Why the block is not running, when it is not. The operator's ONLY window
   * into a block that failed at load — a block that is silently absent is the
   * failure mode this whole feature has to avoid.
   */
  lastError: z.string().optional(),
  /** Ms epoch of the last state change. */
  lastChangedAt: z.number(),
  /** What the block is. Absent means `code` (D659). */
  source: CoreBlockSourceSchema.optional(),
})
export type CoreBlock = z.infer<typeof CoreBlockSchema>

export function coreBlockSourceKind(block: Pick<CoreBlock, 'source'>): CoreBlockSourceKind {
  return block.source?.kind ?? 'code'
}

export function coreBlockComposition(block: Pick<CoreBlock, 'source'>): Composition | null {
  return block.source?.kind === 'composition' ? block.source.composition : null
}

/** What the composer said, or that it could not be asked. Unknown never looks like absent (D315). */
export const CompositionStateReadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answered'), state: CompositionBlockStateSchema.nullable() }),
  z.object({ kind: z.literal('unreachable'), error: z.string() }),
])
export type CompositionStateRead = z.infer<typeof CompositionStateReadSchema>

/** A stored composition block and what the composer says about it. */
export const CompositionViewSchema = z.object({
  block: CoreBlockSchema,
  state: CompositionStateReadSchema,
})
export type CompositionView = z.infer<typeof CompositionViewSchema>

/**
 * A read of the stored compositions. `not-loaded` while the `core_blocks`
 * table has not been READ: an empty answer then would make "not yet known"
 * look like "none", and invite the operator to recreate what exists (D315).
 */
const CompositionsNotLoadedSchema = z.object({ state: z.literal('not-loaded'), reason: z.string() })

export const CompositionListReadSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('loaded'), views: z.array(CompositionViewSchema) }),
  CompositionsNotLoadedSchema,
])
export type CompositionListRead = z.infer<typeof CompositionListReadSchema>

export const CompositionGetReadSchema = z.discriminatedUnion('state', [
  /** `view` null: the table was read and holds no composition with this id. */
  z.object({ state: z.literal('loaded'), view: CompositionViewSchema.nullable() }),
  CompositionsNotLoadedSchema,
])
export type CompositionGetRead = z.infer<typeof CompositionGetReadSchema>

/** The customization of one existing device, found by its TARGET, or `not-loaded` (D315). */
export const CompositionCustomizationReadSchema = z.discriminatedUnion('state', [
  /** `view` null: the table was read and no composition customizes this device. */
  z.object({ state: z.literal('loaded'), view: CompositionViewSchema.nullable() }),
  CompositionsNotLoadedSchema,
])
export type CompositionCustomizationRead = z.infer<typeof CompositionCustomizationReadSchema>

/** What a compile attempt produced. */
export const CoreBlockCompileResultSchema = z.object({
  ok: z.boolean(),
  /** Present when `ok` is false — the first error, in the author's words. */
  error: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
})
export type CoreBlockCompileResult = z.infer<typeof CoreBlockCompileResultSchema>

/**
 * Compile input: legacy single-file `{ code }`, or a multi-file project.
 * When `files` is present, it wins over `code`.
 */
export const CoreBlockCompileInputSchema = z
  .object({
    code: z.string().optional(),
    files: CoreBlockFilesSchema.optional(),
    entry: z.string().min(1).max(260).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.files !== undefined) {
      const entry = val.entry ?? DEFAULT_CORE_BLOCK_ENTRY
      if (val.files[entry] === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `files must include the entry "${entry}"`,
          path: ['files'],
        })
      }
      return
    }
    if (val.code === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'code or files is required',
        path: ['code'],
      })
    }
  })
export type CoreBlockCompileInput = z.infer<typeof CoreBlockCompileInputSchema>

export const coreBlocksCapability = {
  name: 'core-blocks',
  scope: 'system',
  mode: 'singleton',
  methods: {
    list: method(z.object({}), z.object({ blocks: z.array(CoreBlockSchema) }), { auth: 'admin' }),
    get: method(
      z.object({ blockId: z.string() }),
      z.object({ block: CoreBlockSchema.nullable() }),
      {
        auth: 'admin',
      },
    ),
    /**
     * Create a block. The code is COMPILED first: storing source that does not
     * compile turns an editor error into a fork failure the operator meets
     * minutes later in a log.
     */
    create: method(
      z.object({ block: CoreBlockInputSchema }),
      z.object({ block: CoreBlockSchema }),
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),
    update: method(
      z.object({ blockId: z.string(), block: CoreBlockInputFieldsSchema.partial() }),
      z.object({ block: CoreBlockSchema }),
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),
    delete: method(z.object({ blockId: z.string() }), z.object({ success: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    setEnabled: method(
      z.object({ blockId: z.string(), enabled: z.boolean() }),
      z.object({ block: CoreBlockSchema }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Stop this block's runner and let the supervisor bring it back.
     *
     * **It stores nothing.** There is no "restart requested" flag and no second
     * lifecycle field: the supervisor already stops and respawns a runner when
     * the code hash changes, and this exposes that same path deliberately
     * (D62 — a switch writes the authority that already owned the function).
     * The next reconcile pass remains the authority, so a restart that lost a
     * race is corrected within one pass rather than leaving a stale flag behind.
     *
     * Refused for a DISABLED block: nothing would come back, and a button that
     * silently does nothing is worse than one that says why.
     */
    restart: method(z.object({ blockId: z.string() }), z.object({ block: CoreBlockSchema }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Type-check without saving — what the editor calls as the author types, so
     * the compiler's verdict is the same one the server will reach.
     * Accepts `{ code }` or `{ files, entry }` (multi-file project).
     */
    compile: method(CoreBlockCompileInputSchema, CoreBlockCompileResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Hydrated settings form for one block, or null until a `settingsSchema`
     * is known (extracted from the compiled entry's named export, or set on
     * the block). Values live in the block addon's `addon-settings` rows (D880);
     * a password field answers as a "set" view, never the value.
     */
    getBlockSettings: method(
      z.object({ blockId: z.string() }),
      SettingsSchemaWithValuesSchema.nullable(),
      { auth: 'admin' },
    ),
    /**
     * Patch persisted preference values for one block. The schema is not
     * rewritten here — only values. Scripts read the same rows via
     * `ctx.settings.readAddonStore()`. A field the schema declares `password` /
     * `secret: true` is stored in the keychain (owner = the block's addon id)
     * and the row holds a marker; a REDACTED or view value keeps the stored one.
     */
    updateBlockSettings: method(
      z.object({ blockId: z.string(), patch: SettingsPatchSchema }),
      SettingsUpdateResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * D880: move every plaintext password a block's `settingsSchema` declares
     * into the keychain and delete the legacy `core-blocks:settings` copy. Dry
     * run unless `apply`; idempotent; counts only. A secret is read back from
     * the keychain before its row is rewritten.
     */
    migrateRawSecrets: method(RawSecretMigrationInputSchema, RawSecretMigrationReportSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * The declaration files the editor type-checks against.
     *
     * Served rather than bundled: the graph is 3.4 MB across 344 files, and
     * bundling it would roughly double the admin remote. Served rather than
     * hand-stubbed: a block runs with the same `ctx` an addon gets, so a stub
     * would drift and the editor would confidently autocomplete methods that
     * do not exist.
     */
    getTypeDefs: method(
      z.object({}),
      z.object({
        libs: z.array(z.object({ filePath: z.string(), content: z.string() })),
      }),
      { auth: 'admin' },
    ),
    /**
     * Create a composition block (D659). VALIDATED first against the live
     * sources and every stored composition; a refusal names every problem by
     * path and reason (D391) and stores nothing.
     */
    createComposition: method(
      z.object({ block: CompositionBlockInputSchema }),
      z.object({ block: CoreBlockSchema }),
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),
    /**
     * Patch a composition block. A changed `composition` is validated exactly
     * as on create. `expectedUpdatedAt` is the `updatedAt` the caller READ: a
     * block changed since is refused by name, never silently overwritten.
     */
    updateComposition: method(
      z.object({
        blockId: z.string(),
        expectedUpdatedAt: z.number(),
        block: CompositionBlockInputSchema.partial(),
      }),
      z.object({ block: CoreBlockSchema }),
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),
    /** One composition and the composer's state for it, or `not-loaded` (D315). */
    getComposition: method(z.object({ blockId: z.string() }), CompositionGetReadSchema, {
      auth: 'admin',
    }),
    listCompositions: method(z.object({}), CompositionListReadSchema, { auth: 'admin' }),
    /**
     * The composition that customizes an existing device (D663), found by its
     * TARGET — never by the block's derived name. One per device at most.
     */
    getCustomization: method(
      z.object({ addonId: z.string().min(1), stableId: z.string().min(1) }),
      CompositionCustomizationReadSchema,
      { auth: 'admin' },
    ),
    /**
     * The capabilities a composition may BUILD on a device of `deviceType`
     * (a new device, or added to an existing one), with their fields — the
     * editor's feature list and the presets' availability (G2, D676). Built
     * from the validator's own blockers; a replace of a BOUND cap is not
     * listed here (the device's bindings say what it has).
     */
    listComposableCaps: method(
      z.object({ deviceType: z.enum(DeviceType) }),
      ComposableCapabilitiesSchema,
      { auth: 'admin' },
    ),
    /**
     * Validate without saving — the same verdict the save reaches. A mutation
     * for its body size; it writes nothing, so its access is `view`.
     */
    validateComposition: method(
      z.object({ composition: CompositionSchema, blockId: z.string().optional() }),
      CompositionValidationSchema,
      { kind: 'mutation', auth: 'admin', access: 'view' },
    ),
    /**
     * An automation block reports one run (or one coalesced skip) to the hub's
     * `runs` ledger. Only the block itself may: the transport stamps
     * `callerAddonId`, and anything but `core-block-<blockId>` is refused.
     * `keepTraces` bounds the ring; `runStartedAt` moves the cooldown stamp.
     */
    reportAutomationRun: method(
      z.object({
        blockId: z.string().min(1),
        trace: AutomationRunTraceSchema.optional(),
        runStartedAt: z.number().optional(),
        keepTraces: z.number().int().min(1).max(MAX_TRACE_KEEP).optional(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** The cooldown stamp and trace ring a block reads ONCE, at start. Owner-only. */
    getAutomationRunState: method(
      z.object({ blockId: z.string().min(1) }),
      AutomationStateDocSchema,
      { auth: 'admin' },
    ),
    /** An automation's run traces, newest last. The operator's read. */
    getTraces: method(
      z.object({ blockId: z.string().min(1) }),
      z.object({ traces: z.array(AutomationRunTraceSchema), lastError: z.string().nullable() }),
      { auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type ICoreBlocksProvider = InferProvider<typeof coreBlocksCapability>
