/**
 * The `tags` cap (D1054). A tag lives on the record it labels — a core block, a
 * scheduler, a template, an action, a device, a notification rule — and only
 * its STYLE (colour token, icon) is registered here. This service is the one place that knows every owner
 * kind, so `rename` and `remove` are ONE server operation that rewrites all of
 * them; the browser never drives that sequence (a closed tab would split the
 * fleet across two spellings).
 *
 * Owners are reached through {@link TagOwnerPort}s: the local stores directly,
 * the devices and notification rules through their caps over `ctx.api` — never
 * a second copy. An owner that cannot be read degrades `list` (its count is
 * `null`) and refuses `rename` / `remove` before any write.
 * Tags compare trimmed and case-insensitively (`sameTag`).
 */
import {
  DEFAULT_TAG_ICON,
  defaultTagColorId,
  type IScopedLogger,
  type ITagsProvider,
  type RecordKindHandle,
  type TagEntry,
  type TagListCounts,
  type TagUsageCounts,
  removeFromTags,
  renameInTags,
  TAGS_PER_RECORD_MAX,
  TagNameSchema,
  tagKey,
} from '@camstack/types'
import type { TagStyleRowBody } from './record-kinds.js'

/** One record that may carry tags. `id` is the owner's own id, as text. */
export interface TagOwnerRecord {
  readonly id: string
  readonly tags: readonly string[]
}

/** How the service reads and rewrites the tags of one owner kind. */
export interface TagOwnerPort {
  list(): Promise<readonly TagOwnerRecord[]>
  setTags(id: string, tags: string[]): Promise<void>
}

export type TagOwnerKind = keyof TagUsageCounts

export type TagOwnerPorts = Readonly<Record<TagOwnerKind, TagOwnerPort>>

/** The order owners are read and rewritten in; also the order a first spelling is picked. */
const OWNER_KINDS: readonly TagOwnerKind[] = [
  'coreBlocks',
  'schedulers',
  'templates',
  'actions',
  'devices',
  'notificationRules',
]

type MutableCounts = { -readonly [K in TagOwnerKind]: number }

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
 * A rename or remove refused because one owner kind could not be read. Nothing
 * was written; `owner` names which one, so the operator knows what to bring back.
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
  /** Row id = `tagKey(name)`. */
  readonly styles: RecordKindHandle<TagStyleRowBody>
  readonly logger: IScopedLogger
}

const NO_UPDATES: TagUsageCounts = {
  coreBlocks: 0,
  schedulers: 0,
  templates: 0,
  actions: 0,
  devices: 0,
  notificationRules: 0,
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

export class TagsService implements ITagsProvider {
  constructor(private readonly deps: TagsServiceDeps) {}

  private async readStyles(): Promise<TagStyleRowBody[]> {
    const out: TagStyleRowBody[] = []
    let cursor: string | undefined
    do {
      const page = await this.deps.styles.query(cursor === undefined ? {} : { cursor })
      for (const row of page.records) out.push(row.data)
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    return out
  }

  readonly list: ITagsProvider['list'] = async () => {
    const styles = new Map((await this.readStyles()).map((s) => [tagKey(s.name), s]))
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
    const zero = (): MutableCounts => ({ ...NO_UPDATES })
    const entries = new Map<string, { name: string; counts: MutableCounts }>()
    for (const style of styles.values()) {
      entries.set(tagKey(style.name), { name: style.name, counts: zero() })
    }
    for (const { kind, records } of read) {
      for (const record of records) {
        // A record counts once per tag, whatever spellings it carries.
        const seen = new Set<string>()
        for (const tag of record.tags) {
          const key = tagKey(tag)
          if (key.length === 0 || seen.has(key)) continue
          seen.add(key)
          const entry = entries.get(key) ?? { name: tag.trim(), counts: zero() }
          entry.counts[kind] += 1
          entries.set(key, entry)
        }
      }
    }
    const out: TagEntry[] = []
    for (const [key, entry] of entries) {
      const style = styles.get(key)
      out.push({
        name: entry.name,
        color: style?.color ?? defaultTagColorId(entry.name),
        icon: style?.icon ?? DEFAULT_TAG_ICON,
        styled: style !== undefined,
        counts: withUnknown(entry.counts, unreachable),
      })
    }
    return out.toSorted((a, b) => a.name.localeCompare(b.name))
  }

  readonly setStyle: ITagsProvider['setStyle'] = async ({ name, color, icon }) => {
    const trimmed = requireName(name, 'a tag name')
    await this.deps.styles.put({ id: tagKey(trimmed), data: { name: trimmed, color, icon } })
  }

  readonly rename: ITagsProvider['rename'] = async ({ from, to }) => {
    const source = requireName(from, 'the tag to rename')
    const target = requireName(to, 'the new tag name')
    const updated = await this.rewrite(source, (tags) => renameInTags(tags, source, target))
    await this.moveStyle(source, target)
    this.deps.logger.info('tag renamed', { meta: { from: source, to: target, updated } })
    return { updated }
  }

  readonly remove: ITagsProvider['remove'] = async ({ name }) => {
    const target = requireName(name, 'the tag to remove')
    const updated = await this.rewrite(target, (tags) => removeFromTags(tags, target))
    await this.deps.styles.delete(tagKey(target))
    this.deps.logger.info('tag removed', { meta: { name: target, updated } })
    return { updated }
  }

  /**
   * Apply `change` to every record carrying `tag`, on every owner kind. A record
   * that fails is logged and the rest are still attempted; the call then throws,
   * and the style is NOT touched — the tag still names the failed records, so the
   * operator repeats the same call (every step is idempotent).
   */
  private async rewrite(
    tag: string,
    change: (tags: readonly string[]) => string[] | null,
  ): Promise<TagUsageCounts> {
    const updated = { ...NO_UPDATES }
    const failed: string[] = []
    // Plan every write first: a record pushed past the cap refuses the whole call
    // before anything is written, so the fleet never ends up half renamed.
    const plan: { kind: TagOwnerKind; id: string; next: string[] }[] = []
    for (const kind of OWNER_KINDS) {
      for (const record of await this.readOwnerOrRefuse(kind, tag)) {
        const next = change(record.tags)
        if (next === null) continue
        if (next.length > TAGS_PER_RECORD_MAX) {
          throw new Error(
            `[tags] "${tag}" cannot be applied: ${kind}:${record.id} would carry ${next.length} tags (max ${TAGS_PER_RECORD_MAX}); nothing was written`,
          )
        }
        plan.push({ kind, id: record.id, next })
      }
    }
    for (const { kind, id, next } of plan) {
      try {
        await this.deps.owners[kind].setTags(id, next)
        updated[kind] += 1
      } catch (err) {
        failed.push(`${kind}:${id}`)
        const deviceId = kind === 'devices' ? Number(id) : undefined
        this.deps.logger.error(
          'tag rewrite failed for one record — the rest were still attempted',
          {
            ...(deviceId === undefined || !Number.isFinite(deviceId) ? {} : { tags: { deviceId } }),
            meta: {
              tag,
              kind,
              recordId: id,
              error: err instanceof Error ? err.message : String(err),
            },
          },
        )
      }
    }
    if (failed.length > 0) {
      throw new Error(
        `[tags] "${tag}" was not rewritten on ${failed.length} record(s) (${failed.slice(0, 5).join(', ')}); the style was left alone — repeat the call`,
      )
    }
    return updated
  }

  /**
   * An owner's records for a rewrite. One that cannot be read refuses the whole
   * call BEFORE anything is written: a rename applied to only some owners would
   * leave the fleet split across two spellings.
   */
  private async readOwnerOrRefuse(
    kind: TagOwnerKind,
    tag: string,
  ): Promise<readonly TagOwnerRecord[]> {
    try {
      return await this.deps.owners[kind].list()
    } catch (err) {
      throw new TagOwnerUnreachableError(kind, tag, err)
    }
  }

  /** The style follows the tag; a merge onto a styled target keeps the TARGET's style. */
  private async moveStyle(from: string, to: string): Promise<void> {
    const fromKey = tagKey(from)
    const toKey = tagKey(to)
    const fromStyle = await this.deps.styles.get(fromKey)
    if (fromKey === toKey) {
      // Only the spelling changed: the style keeps its colour and icon.
      if (fromStyle !== null)
        await this.deps.styles.put({ id: toKey, data: { ...fromStyle.data, name: to } })
      return
    }
    if (fromStyle === null) return
    const toStyle = await this.deps.styles.get(toKey)
    if (toStyle === null) {
      await this.deps.styles.put({ id: toKey, data: { ...fromStyle.data, name: to } })
    }
    await this.deps.styles.delete(fromKey)
  }
}
