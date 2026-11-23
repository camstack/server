/**
 * The `tags` cap (D1089). A tag is a RECORD with an opaque id; a core block, a
 * scheduler, a template, an action, a device and a notification rule carry the
 * id, and the name, colour, icon and description live on the record only. So
 * `updateTag` — a rename included — is ONE write to ONE record, and no owner
 * has to be reachable. `deleteTag` keeps the one fan-out that remains: it
 * clears the id from every owner, and refuses while an owner cannot be read.
 *
 * `list`, `setStyle`, `rename` and `remove` are the old name-based surface, now
 * thin shims over the entity methods (kept for one release).
 *
 * Owners are reached through {@link TagOwnerPort}s: the local stores directly,
 * the devices and notification rules through their caps over `ctx.api` — never
 * a second copy. A names-only owner (a notification rule, until its own
 * migration lands) still carries text; the service keeps its names in step.
 */
import {
  DEFAULT_TAG_ICON,
  defaultTagColorId,
  type IScopedLogger,
  type ITagsProvider,
  removeFromTags,
  renameInTags,
  type RecordKindHandle,
  type TagBody,
  type TagEntry,
  type TagListCounts,
  TagNameSchema,
  type TagPatch,
  type TagRecord,
  type TagUsageCounts,
  tagKey,
  userError,
} from '@camstack/types'
import {
  EntityNameTakenError,
  EntityNotFoundError,
  NamedEntityStore,
} from '../../records/named-entity-store.js'
import { TagRowBodySchema } from './record-kinds.js'

/** One record that may carry tags. `id` is the owner's own id, as text. */
export interface TagOwnerRecord {
  readonly id: string
  /** The tag names kept on the record (D1089: kept beside the ids for one release). */
  readonly tags: readonly string[]
  /** The tag ids the record carries; empty before its owner migrated. */
  readonly tagIds: readonly string[]
}

/** How the service reads and rewrites the tags of one owner kind. */
export interface TagOwnerPort {
  /** `ids`: the owner stores tag ids. `names`: it still stores text only. */
  readonly storage: 'ids' | 'names'
  list(): Promise<readonly TagOwnerRecord[]>
  setTagIds(id: string, tagIds: string[]): Promise<void>
  setTags(id: string, tags: string[]): Promise<void>
}

export type TagOwnerKind = keyof TagUsageCounts

export type TagOwnerPorts = Readonly<Record<TagOwnerKind, TagOwnerPort>>

const OWNER_KINDS: readonly TagOwnerKind[] = [
  'coreBlocks',
  'schedulers',
  'templates',
  'actions',
  'devices',
  'notificationRules',
]

type MutableCounts = { -readonly [K in TagOwnerKind]: number }

const zeroCounts = (): MutableCounts => ({
  coreBlocks: 0,
  schedulers: 0,
  templates: 0,
  actions: 0,
  devices: 0,
  notificationRules: 0,
})

/** The list counts: an owner that could not be read is `null`, never `0` (D393). */
function withUnknown(counts: MutableCounts, unreachable: ReadonlySet<TagOwnerKind>): TagListCounts {
  return {
    coreBlocks: unreachable.has('coreBlocks') ? null : counts.coreBlocks,
    schedulers: unreachable.has('schedulers') ? null : counts.schedulers,
    templates: unreachable.has('templates') ? null : counts.templates,
    actions: unreachable.has('actions') ? null : counts.actions,
    devices: unreachable.has('devices') ? null : counts.devices,
    notificationRules: unreachable.has('notificationRules') ? null : counts.notificationRules,
  }
}

/**
 * A delete refused because one owner kind could not be read. Nothing was
 * written; `owner` names which one, so the operator knows what to bring back.
 */
export class TagOwnerUnreachableError extends Error {
  override readonly name = 'TagOwnerUnreachableError'
  constructor(
    readonly owner: TagOwnerKind,
    tag: string,
    cause: unknown,
  ) {
    super(
      `[tags] "${tag}" was not changed anywhere: the ${owner} owner could not be read (${cause instanceof Error ? cause.message : String(cause)}); nothing was written — retry once it is back`,
      { cause },
    )
  }
}

export interface TagsServiceDeps {
  readonly owners: TagOwnerPorts
  /** Record id = the tag id (D1089). */
  readonly tags: RecordKindHandle<TagBody>
  readonly logger: IScopedLogger
}

function requireName(value: string, what: string): string {
  const parsed = TagNameSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(
      `[tags] ${what} is not a valid tag name: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    )
  }
  return parsed.data
}

/** A patch field: absent keeps the current value, `null` clears it, a value replaces it. */
function applied<T>(patch: T | null | undefined, current: T | undefined): T | undefined {
  if (patch === undefined) return current
  return patch === null ? undefined : patch
}

/** Does `record` carry the tag? By id; a record not migrated yet by its kept name. */
function carries(record: TagOwnerRecord, tag: { id: string; name: string }): boolean {
  if (record.tagIds.includes(tag.id)) return true
  if (record.tagIds.length > 0) return false
  return record.tags.some((name) => tagKey(name) === tagKey(tag.name))
}

export class TagsService implements ITagsProvider {
  private readonly store: NamedEntityStore<TagBody>
  private loaded: Promise<void> | null = null

  constructor(private readonly deps: TagsServiceDeps) {
    this.store = new NamedEntityStore<TagBody>('tag', deps.tags, (body) =>
      TagRowBodySchema.parse(body),
    )
  }

  /** Read the records once; every method awaits it. */
  private ready(): Promise<void> {
    this.loaded ??= this.store.load()
    return this.loaded
  }

  // ── The entity methods ─────────────────────────────────────────────────

  readonly ensureTag: ITagsProvider['ensureTag'] = async ({ name }) => {
    await this.ready()
    return this.store.ensure(requireName(name, 'a tag name'), {})
  }

  readonly listTags: ITagsProvider['listTags'] = async () => {
    await this.ready()
    return [...this.store.list()]
  }

  readonly updateTag: ITagsProvider['updateTag'] = async ({ id, patch }) => {
    await this.ready()
    try {
      return await this.store.update(id, (current) => this.patched(current, patch))
    } catch (err) {
      if (err instanceof EntityNotFoundError) {
        throw userError('system.tag-not-found', undefined, `[tags] tag not found: ${id}`)
      }
      if (err instanceof EntityNameTakenError) {
        throw userError('system.tag-name-taken', undefined, `[tags] ${err.message}`)
      }
      throw err
    }
  }

  readonly deleteTag: ITagsProvider['deleteTag'] = async ({ id }) => {
    await this.ready()
    const tag = this.store.get(id)
    if (tag === null) return { updated: { ...zeroCounts() } }
    const updated = await this.clearFromOwners(tag, null)
    await this.store.delete(id)
    this.deps.logger.info('tag deleted', { meta: { id, name: tag.name, updated } })
    return { updated }
  }

  // ── The shims (kept one release) ───────────────────────────────────────

  readonly list: ITagsProvider['list'] = async () => {
    await this.ready()
    // Read every owner first; one that cannot be read degrades to `null` (D393)
    // instead of taking the whole list — and every tag picker — down with it.
    const unreachable = new Set<TagOwnerKind>()
    const read: { kind: TagOwnerKind; records: readonly TagOwnerRecord[] }[] = []
    for (const kind of OWNER_KINDS) {
      try {
        read.push({ kind, records: await this.deps.owners[kind].list() })
      } catch (err) {
        unreachable.add(kind)
        this.deps.logger.warn('tag owner could not be read — its count is unknown on this list', {
          meta: { owner: kind, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    const entries = new Map<
      string,
      { name: string; styled: boolean; counts: MutableCounts; record: TagRecord | null }
    >()
    for (const tag of this.store.list()) {
      entries.set(tag.id, { name: tag.name, styled: true, counts: zeroCounts(), record: tag })
    }
    const byKey = new Map<string, string>([...entries].map(([id, e]) => [tagKey(e.name), id]))
    for (const { kind, records } of read) {
      for (const record of records) {
        const seen = new Set<string>()
        const touch = (entryId: string, name: string, record0: TagRecord | null): void => {
          if (seen.has(entryId)) return
          seen.add(entryId)
          const entry = entries.get(entryId) ?? {
            name,
            styled: false,
            counts: zeroCounts(),
            record: record0,
          }
          entry.counts[kind] += 1
          entries.set(entryId, entry)
        }
        for (const id of record.tagIds) {
          const known = this.store.get(id)
          if (known !== null) touch(id, known.name, known)
        }
        if (record.tagIds.length === 0) {
          for (const name of record.tags) {
            const key = tagKey(name)
            if (key.length === 0) continue
            const existing = byKey.get(key)
            if (existing === undefined) byKey.set(key, `name:${key}`)
            touch(existing ?? `name:${key}`, name.trim(), null)
          }
        }
      }
    }
    const out: TagEntry[] = []
    for (const entry of entries.values()) {
      out.push({
        name: entry.name,
        color: entry.record?.colour ?? defaultTagColorId(entry.name),
        icon: entry.record?.icon ?? DEFAULT_TAG_ICON,
        styled: entry.record?.colour !== undefined || entry.record?.icon !== undefined,
        counts: withUnknown(entry.counts, unreachable),
      })
    }
    return out.toSorted((a, b) => a.name.localeCompare(b.name))
  }

  readonly setStyle: ITagsProvider['setStyle'] = async ({ name, color, icon }) => {
    const tag = await this.ensureTag({ name })
    await this.updateTag({ id: tag.id, patch: { colour: color, icon } })
  }

  readonly rename: ITagsProvider['rename'] = async ({ from, to }) => {
    await this.ready()
    const source = requireName(from, 'the tag to rename')
    const target = requireName(to, 'the new tag name')
    const sourceTag = this.store.findByName(source)
    if (sourceTag === null) {
      // No record: a name still only on names-only owners. Move the names.
      const updated = await this.renameNamesOnly(source, target)
      this.deps.logger.info('tag renamed (names only)', { meta: { from: source, to: target } })
      return { updated }
    }
    const targetTag = this.store.findByName(target)
    if (targetTag === null || targetTag.id === sourceTag.id) {
      // The plain rename — and a case-only one: ONE record, no owner touched.
      await this.updateTag({ id: sourceTag.id, patch: { name: target } })
      const updated = await this.countCarrying(sourceTag, target)
      this.deps.logger.info('tag renamed', { meta: { from: source, to: target } })
      return { updated }
    }
    // A MERGE: every owner moves to the target; the target keeps its style.
    const updated = await this.clearFromOwners(sourceTag, targetTag)
    await this.store.delete(sourceTag.id)
    this.deps.logger.info('tags merged', { meta: { from: source, to: target, updated } })
    return { updated }
  }

  readonly remove: ITagsProvider['remove'] = async ({ name }) => {
    await this.ready()
    const target = requireName(name, 'the tag to remove')
    const tag = this.store.findByName(target)
    if (tag === null) {
      return { updated: await this.removeNamesOnly(target) }
    }
    const { updated } = await this.deleteTag({ id: tag.id })
    return { updated }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private patched(current: TagBody, patch: TagPatch): TagBody {
    const next: TagBody = { name: patch.name ?? current.name }
    const colour = applied(patch.colour, current.colour)
    const icon = applied(patch.icon, current.icon)
    const description = applied(patch.description, current.description)
    const order = applied(patch.order, current.order)
    if (colour !== undefined) next.colour = colour
    if (icon !== undefined) next.icon = icon
    if (description !== undefined) next.description = description
    if (order !== undefined) next.order = order
    return next
  }

  /**
   * Remove `tag` from every owner record that carries it, or — with `into` —
   * replace it with that tag. Every owner is READ first: one that cannot be
   * read refuses the whole call before anything is written.
   */
  private async clearFromOwners(
    tag: { id: string; name: string },
    into: { id: string; name: string } | null,
  ): Promise<TagUsageCounts> {
    const plan: { kind: TagOwnerKind; record: TagOwnerRecord }[] = []
    for (const kind of OWNER_KINDS) {
      let records: readonly TagOwnerRecord[]
      try {
        records = await this.deps.owners[kind].list()
      } catch (err) {
        throw new TagOwnerUnreachableError(kind, tag.name, err)
      }
      for (const record of records) if (carries(record, tag)) plan.push({ kind, record })
    }
    const updated = zeroCounts()
    const failed: string[] = []
    for (const { kind, record } of plan) {
      try {
        await this.rewriteRecord(kind, record, tag, into)
        updated[kind] += 1
      } catch (err) {
        failed.push(`${kind}:${record.id}`)
        const deviceId = kind === 'devices' ? Number(record.id) : undefined
        this.deps.logger.error(
          'tag rewrite failed for one record — the rest were still attempted',
          {
            ...(deviceId === undefined || !Number.isFinite(deviceId) ? {} : { tags: { deviceId } }),
            meta: {
              tag: tag.name,
              kind,
              recordId: record.id,
              error: err instanceof Error ? err.message : String(err),
            },
          },
        )
      }
    }
    if (failed.length > 0) {
      throw new Error(
        `[tags] "${tag.name}" was not cleared on ${failed.length} record(s) (${failed.slice(0, 5).join(', ')}); the tag was left alone — repeat the call`,
      )
    }
    return updated
  }

  private async rewriteRecord(
    kind: TagOwnerKind,
    record: TagOwnerRecord,
    tag: { id: string; name: string },
    into: { id: string; name: string } | null,
  ): Promise<void> {
    const port = this.deps.owners[kind]
    const names =
      into === null
        ? removeFromTags(record.tags, tag.name)
        : renameInTags(record.tags, tag.name, into.name)
    if (port.storage === 'names') {
      if (names !== null) await port.setTags(record.id, names)
      return
    }
    const withoutTag = record.tagIds.filter((id) => id !== tag.id)
    const ids =
      into === null || withoutTag.includes(into.id) ? withoutTag : [...withoutTag, into.id]
    await port.setTagIds(record.id, record.tagIds.length === 0 && into !== null ? [into.id] : ids)
    if (names !== null) await port.setTags(record.id, names)
  }

  /** How many records carry `tag` (by id or kept name) — the shim's `updated`; an unreadable owner counts 0. */
  private async countCarrying(
    tag: { id: string; name: string },
    newName: string,
  ): Promise<TagUsageCounts> {
    const counts = zeroCounts()
    for (const kind of OWNER_KINDS) {
      try {
        for (const record of await this.deps.owners[kind].list()) {
          if (carries(record, tag) || carries(record, { id: tag.id, name: newName }))
            counts[kind] += 1
        }
      } catch {
        // An owner that cannot be read cannot have been written; the rename itself needed none.
      }
    }
    return counts
  }

  /** Names-only tags: a name on owners that have no record for it (a pre-migration state). */
  private async renameNamesOnly(from: string, to: string): Promise<TagUsageCounts> {
    const updated = zeroCounts()
    for (const kind of OWNER_KINDS) {
      for (const record of await this.deps.owners[kind].list()) {
        const next = renameInTags(record.tags, from, to)
        if (next === null) continue
        await this.deps.owners[kind].setTags(record.id, next)
        updated[kind] += 1
      }
    }
    return updated
  }

  private async removeNamesOnly(name: string): Promise<TagUsageCounts> {
    const updated = zeroCounts()
    for (const kind of OWNER_KINDS) {
      for (const record of await this.deps.owners[kind].list()) {
        const next = removeFromTags(record.tags, name)
        if (next === null) continue
        await this.deps.owners[kind].setTags(record.id, next)
        updated[kind] += 1
      }
    }
    return updated
  }
}
