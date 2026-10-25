/**
 * Durable storage for core blocks.
 *
 * A kernel table, not an addon's: a block is not owned by any addon — it is
 * user code the kernel runs. The name is bare for the same reason `users` and
 * `system-settings` are (the collection-namespacing guard scans
 * `packages/addon-*` only, and this is deliberately not one).
 *
 * The write path is the interesting part. **Source is never stored without
 * compiling it first.** A block that does not compile is not a broken row, it
 * is a fork failure the operator meets minutes later inside a log — so the
 * compile happens where they are still looking at the editor.
 */

import { randomUUID } from 'node:crypto'
import type {
  ComposerUnreadableBlock,
  CompositionBlockInput,
  CompositionBlockPatch,
  CoreBlock,
  CoreBlockInput,
  IScopedLogger,
  RecordKindHandle,
  RecordsAccess,
} from '@camstack/types'
import {
  CoreBlockSchema,
  coreBlockSourceKind,
  normalizeCoreBlockWrite,
  resolveCoreBlockEntry,
} from '@camstack/types'
import { coreBlocksRecordKinds, type CoreBlockRowBodySchema } from './record-kinds.js'
import type { z } from 'zod'

type CoreBlockRowBody = z.infer<typeof CoreBlockRowBodySchema>

/**
 * A composition block as the store keeps it: always NAMED. A customization's
 * client input carries no name — the API derives it before the store sees it (D663).
 */
export interface NamedCompositionInput extends CompositionBlockInput {
  readonly name: string
}

/**
 * @durable class=config owner=core-blocks
 *   write="`create` and `update` persist the operator's block after it compiles;
 *     `setStatus` rewrites what the runner reported (status, `lastChangedAt`,
 *     `lastError`) — so a running block is written on every state change"
 *   retention="`delete` only, when the operator removes a block. Nothing ages out,
 *     and a row whose JSON stops validating is left on disk rather than repaired.
 *     The real loss path is a `declareCollection` REBUILD — a legacy (id, data)
 *     shape, or a new PK/UNIQUE/NOT-NULL-without-default column — which drops the
 *     table and takes the operator's source code with it."
 */
import { CORE_BLOCKS_COLLECTION } from './record-kinds.js'

export { CORE_BLOCKS_COLLECTION } from './record-kinds.js'

export const CORE_BLOCKS_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'name', type: 'TEXT' as const, notNull: true },
  { name: 'enabled', type: 'BOOLEAN' as const, notNull: true },
  { name: 'placement', type: 'TEXT' as const, notNull: true },
  { name: 'updatedAt', type: 'INTEGER' as const, notNull: true },
  /** The FULL block, Zod-validated on read; the scalars above are indexed
   *  projections for the list view. */
  { name: 'block', type: 'JSON' as const, notNull: true },
] as const

export const CORE_BLOCKS_INDEXES = [
  { name: 'idx_core_blocks_enabled', columns: ['enabled'] as const },
] as const

/**
 * Rows one read asks for. A read that ANSWERS this many is not a loaded table:
 * rows past the limit would be absent, and an absent composition reads as a
 * deleted one (D49).
 */
export const CORE_BLOCKS_LOAD_LIMIT = 1_000

/**
 * What an unparseable row's `source.kind` says, or null when it cannot be told.
 * Absent means `code`, as it does for a readable row.
 */
function rawSourceKind(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  if (!('source' in raw) || raw.source === undefined) return 'code'
  const source = raw.source
  if (typeof source !== 'object' || source === null || !('kind' in source)) return null
  return typeof source.kind === 'string' ? source.kind : null
}

/** An unreadable row that may be a composition: one whose kind says so, or cannot be told. */
function mayBeComposition(raw: unknown): boolean {
  const kind = rawSourceKind(raw)
  return kind !== 'code' && kind !== 'recipe'
}

function parseErrorText(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string {
  return issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ')
}

export interface CoreBlockStoreDeps {
  readonly blocks: RecordKindHandle<CoreBlockRowBody>
  readonly logger: IScopedLogger
  readonly now?: () => number
  readonly newId?: () => string
}

export class CoreBlockStore {
  private readonly byId = new Map<string, CoreBlock>()
  /** Rows that exist but do not parse and may be compositions — held for the composer, never dropped (D49). */
  private unreadable: readonly ComposerUnreadableBlock[] = []
  private readonly blocks: RecordKindHandle<CoreBlockRowBody>
  private readonly logger: IScopedLogger
  private readonly now: () => number
  private readonly newId: () => string
  private loaded = false
  /** Consecutive failed reads — the warn is once per run of them, not once per retry. */
  private failedLoads = 0

  constructor(deps: CoreBlockStoreDeps) {
    this.blocks = deps.blocks
    this.logger = deps.logger
    this.now = deps.now ?? ((): number => Date.now())
    this.newId = deps.newId ?? ((): string => randomUUID())
  }

  static of(records: Pick<RecordsAccess, 'kind'>, logger: IScopedLogger): CoreBlockStore {
    return new CoreBlockStore({
      blocks: records.kind(coreBlocksRecordKinds.blocks),
      logger,
    })
  }

  /** True only after a `load()` that READ the table. The composer withdraws nothing otherwise (D49). */
  isLoaded(): boolean {
    return this.loaded
  }

  /** Stored composition rows that do not parse, by id — the composer holds their devices. */
  unreadableCompositions(): readonly ComposerUnreadableBlock[] {
    return this.unreadable
  }

  /**
   * Hydrate every block.
   *
   * A row whose JSON no longer validates is SKIPPED with a warning rather than
   * dropped or repaired: it is somebody's code, and the honest answer to "I
   * cannot read this" is to leave it on disk and say so. A skipped row that may
   * be a COMPOSITION is also kept in `unreadableCompositions()`: absent from the
   * composer's input it would read as deleted, and its device would go (D49).
   *
   * `source` is parsed here, and a build older than D659 strips `source` and
   * rewrites the row — rolling back below D659 erases compositions.
   */
  async load(): Promise<void> {
    try {
      const page = await this.blocks.query({ limit: CORE_BLOCKS_LOAD_LIMIT })
      const rows = page.records
      if (rows.length >= CORE_BLOCKS_LOAD_LIMIT) {
        throw new Error(
          `${CORE_BLOCKS_COLLECTION} answered ${rows.length} rows, the read limit — rows past it would read as deleted`,
        )
      }
      this.byId.clear()
      this.loaded = true
      if (this.failedLoads > 0) {
        this.logger.info('core blocks loaded after failed reads', {
          meta: { failedAttempts: this.failedLoads },
        })
        this.failedLoads = 0
      }
      let skipped = 0
      const unreadable: ComposerUnreadableBlock[] = []
      for (const row of rows) {
        const raw = row.data.block
        const parsed = CoreBlockSchema.safeParse(raw)
        if (!parsed.success) {
          skipped += 1
          if (mayBeComposition(raw)) {
            const name = row.data.name
            unreadable.push({
              id: row.id,
              name: typeof name === 'string' ? name : null,
              error: parseErrorText(parsed.error.issues),
            })
          }
          continue
        }
        this.byId.set(parsed.data.id, parsed.data)
      }
      this.unreadable = unreadable
      if (skipped > 0) {
        this.logger.warn('core blocks skipped as unreadable — left on disk, not repaired', {
          meta: { skipped, heldForComposer: unreadable.map((u) => u.id) },
        })
      }
    } catch (err) {
      // NOT an empty table: `isLoaded()` stays false, and the composer is told
      // so rather than handed zero blocks it would read as "all deleted" (D49).
      // The supervisor's converge retries it; one warn per run of failures.
      this.failedLoads += 1
      if (this.failedLoads === 1) {
        this.logger.warn('core block load failed — retried on every converge until it reads', {
          meta: { error: String(err) },
        })
      } else {
        this.logger.debug('core block load failed again', {
          meta: { error: String(err), failedAttempts: this.failedLoads },
        })
      }
    }
  }

  list(): readonly CoreBlock[] {
    return [...this.byId.values()].toSorted((a, b) => a.name.localeCompare(b.name))
  }

  get(blockId: string): CoreBlock | null {
    return this.byId.get(blockId) ?? null
  }

  /** Blocks that should be running here. The runner's input. */
  enabledFor(nodeId: string): readonly CoreBlock[] {
    return this.list().filter((b) => b.enabled && b.placement === nodeId)
  }

  async create(input: CoreBlockInput, createdBy: string): Promise<CoreBlock> {
    this.requireLoaded()
    const now = this.now()
    const normalized = normalizeCoreBlockWrite(input)
    const block: CoreBlock = CoreBlockSchema.parse({
      ...input,
      ...normalized,
      id: this.newId(),
      createdBy,
      createdAt: now,
      updatedAt: now,
      // Never `running` on creation: the runner reports that, and a store that
      // claimed it would be lying about a process nobody started yet.
      status: 'stopped',
      lastChangedAt: now,
    })
    await this.persist(block)
    this.byId.set(block.id, block)
    return block
  }

  /** Apply a partial patch. Immutable: returns the NEW block. */
  async update(blockId: string, patch: Partial<CoreBlockInput>): Promise<CoreBlock> {
    const existing = this.byId.get(blockId)
    if (!existing) throw new Error(`core block not found: ${blockId}`)
    const sourcePatch = this.normalizeSourcePatch(existing, patch)
    const nextCode = sourcePatch?.code ?? existing.code
    const nextFiles = sourcePatch !== null ? sourcePatch.files : existing.files
    const nextEntry = sourcePatch !== null ? sourcePatch.entry : existing.entry
    const codeChanged = nextCode !== existing.code
    const filesChanged =
      JSON.stringify(nextFiles ?? null) !== JSON.stringify(existing.files ?? null)
    const entryChanged = (nextEntry ?? undefined) !== (existing.entry ?? undefined)
    const fixed =
      codeChanged ||
      filesChanged ||
      entryChanged ||
      (patch.placement !== undefined && patch.placement !== existing.placement) ||
      (patch.integrationId !== undefined && patch.integrationId !== existing.integrationId)
    if (fixed && coreBlockSourceKind(existing) !== 'code') {
      // Moving a composition off the hub would drop it from the composer's set
      // and withdraw its device; moving it back would mint a new id.
      throw new Error(
        `core block "${existing.name}" is a composition — its code, placement and integration are fixed; edit it with updateComposition`,
      )
    }
    if (
      patch.name !== undefined &&
      patch.name !== existing.name &&
      coreBlockSourceKind(existing) !== 'code'
    ) {
      // A second writer of the name, without the `expectedUpdatedAt` check
      // `updateComposition` enforces. `enabled` stays here: it is the switch (D62).
      throw new Error(
        `core block "${existing.name}" is a composition — rename it with updateComposition, which checks expectedUpdatedAt`,
      )
    }
    const updated = CoreBlockSchema.parse({
      ...existing,
      ...patch,
      ...(sourcePatch !== null ? { code: nextCode, files: nextFiles, entry: nextEntry } : {}),
      id: existing.id,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: Math.max(this.now(), existing.updatedAt + 1),
    })
    await this.persist(updated)
    this.byId.set(updated.id, updated)
    return updated
  }

  /**
   * Store a composition block (D659): hub-placed, no code, never `running` on
   * creation — the composer's verdict, mirrored by the supervisor, says that.
   */
  async createComposition(input: NamedCompositionInput, createdBy: string): Promise<CoreBlock> {
    this.requireLoaded()
    const now = this.now()
    const block: CoreBlock = CoreBlockSchema.parse({
      name: input.name,
      enabled: input.enabled,
      placement: 'hub',
      code: '',
      source: { kind: 'composition', composition: input.composition },
      id: this.newId(),
      createdBy,
      createdAt: now,
      updatedAt: now,
      status: 'stopped',
      lastChangedAt: now,
    })
    await this.persist(block)
    this.byId.set(block.id, block)
    return block
  }

  /** Patch a composition block. Immutable: returns the NEW block. Refuses a code block by name. */
  async updateComposition(blockId: string, patch: CompositionBlockPatch): Promise<CoreBlock> {
    const existing = this.byId.get(blockId)
    if (!existing) throw new Error(`core block not found: ${blockId}`)
    if (coreBlockSourceKind(existing) !== 'composition') {
      throw new Error(`core block "${existing.name}" is a code block — edit it with update`)
    }
    const updated = CoreBlockSchema.parse({
      ...existing,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.composition === undefined
        ? {}
        : { source: { kind: 'composition', composition: patch.composition } }),
      // Strictly increasing: `updatedAt` is the version an update's
      // `expectedUpdatedAt` is checked against, so two saves in one
      // millisecond must not share one.
      updatedAt: Math.max(this.now(), existing.updatedAt + 1),
    })
    await this.persist(updated)
    this.byId.set(updated.id, updated)
    return updated
  }

  /**
   * Record what the runner did with this block.
   *
   * Separate from {@link update} on purpose: status is the RUNNER's to write
   * and the author's to read, and letting an edit set it would let the UI claim
   * a block is running because somebody renamed it.
   */
  async setStatus(blockId: string, status: CoreBlock['status'], error?: string): Promise<void> {
    const existing = this.byId.get(blockId)
    if (!existing) return
    const next: CoreBlock = {
      ...existing,
      status,
      lastChangedAt: this.now(),
      ...(error !== undefined ? { lastError: error } : {}),
    }
    // A block whose caller reports no error HAS no error. Keeping the previous
    // one would leave a block the operator has since fixed and stopped showing
    // the failure it recovered from — the same trap as a leftover doc comment
    // that describes the design instead of the code.
    if (error === undefined && next.lastError !== undefined) {
      delete (next as { lastError?: string }).lastError
    }
    await this.persist(next)
    this.byId.set(blockId, next)
  }

  /**
   * A write before the table has been read would be wiped from memory by the
   * load that follows (it clears and refills), so it is refused by name.
   */
  private requireLoaded(): void {
    if (!this.loaded) {
      throw new Error(
        'core_blocks has not loaded yet — nothing can be created until it has; retry shortly',
      )
    }
  }

  /** Idempotent delete — an unknown id is a no-op. */
  async delete(blockId: string): Promise<void> {
    this.byId.delete(blockId)
    this.unreadable = this.unreadable.filter((u) => u.id !== blockId)
    await this.blocks.delete(blockId)
  }

  private async persist(block: CoreBlock): Promise<void> {
    const body: CoreBlockRowBody = {
      name: block.name,
      enabled: block.enabled,
      placement: block.placement,
      updatedAt: block.updatedAt,
      block,
    }
    const parsed = coreBlocksRecordKinds.blocks.schema.safeParse(body)
    if (!parsed.success) return
    await this.blocks.put({ id: block.id, data: parsed.data })
  }

  /**
   * Resolve a source-affecting patch into the normalized `{ code, files?, entry? }`
   * that will be stored. `null` when the patch does not touch source.
   */
  private normalizeSourcePatch(
    existing: CoreBlock,
    patch: Partial<CoreBlockInput>,
  ): { code: string; files?: Record<string, string>; entry?: string } | null {
    if (patch.files !== undefined) {
      return normalizeCoreBlockWrite({
        code: patch.code,
        files: patch.files,
        entry: patch.entry ?? existing.entry,
      })
    }
    if (patch.code === undefined && patch.entry === undefined) return null
    if (existing.files !== undefined) {
      // A single-file edit against a multi-file block updates `files[entry]`
      // and keeps the rest of the project — never silently drops siblings.
      const entry = resolveCoreBlockEntry(patch.entry ?? existing.entry)
      const files = {
        ...existing.files,
        [entry]: patch.code ?? existing.files[entry] ?? existing.code,
      }
      return normalizeCoreBlockWrite({ files, entry })
    }
    return normalizeCoreBlockWrite({
      code: patch.code ?? existing.code,
      entry: patch.entry,
    })
  }
}
