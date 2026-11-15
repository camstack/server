/**
 * The `tags` cap (D1054). A tag lives on the record it labels — a core block, a
 * scheduler, a template, an action, a device — and only its STYLE (colour token,
 * icon) is registered here. This service is the one place that knows every owner
 * kind, so `rename` and `remove` are ONE server operation that rewrites all of
 * them; the browser never drives that sequence (a closed tab would split the
 * fleet across two spellings).
 *
 * Owners are reached through {@link TagOwnerPort}s: the local stores directly,
 * the devices through the device manager over `ctx.api` — never a second copy.
 * Tags compare trimmed and case-insensitively (`sameTag`).
 */
import {
  DEFAULT_TAG_ICON,
  defaultTagColorId,
  type IScopedLogger,
  type ITagsProvider,
  type RecordKindHandle,
  type TagEntry,
  type TagUsageCounts,
  removeFromTags,
  renameInTags,
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
]

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
}

function requireName(value: string, what: string): string {
  const name = value.trim()
  if (name.length === 0) throw new Error(`[tags] ${what} must not be empty`)
  return name
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
    const entries = new Map<
      string,
      { name: string; counts: { -readonly [K in TagOwnerKind]: number } }
    >()
    for (const style of styles.values()) {
      entries.set(tagKey(style.name), {
        name: style.name,
        counts: { ...NO_UPDATES },
      })
    }
    for (const kind of OWNER_KINDS) {
      for (const record of await this.deps.owners[kind].list()) {
        // A record counts once per tag, whatever spellings it carries.
        const seen = new Set<string>()
        for (const tag of record.tags) {
          const key = tagKey(tag)
          if (key.length === 0 || seen.has(key)) continue
          seen.add(key)
          const entry = entries.get(key) ?? { name: tag.trim(), counts: { ...NO_UPDATES } }
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
        counts: entry.counts,
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
    for (const kind of OWNER_KINDS) {
      const port = this.deps.owners[kind]
      for (const record of await port.list()) {
        const next = change(record.tags)
        if (next === null) continue
        try {
          await port.setTags(record.id, next)
          updated[kind] += 1
        } catch (err) {
          failed.push(`${kind}:${record.id}`)
          const deviceId = kind === 'devices' ? Number(record.id) : undefined
          this.deps.logger.error(
            'tag rewrite failed for one record — the rest were still attempted',
            {
              ...(deviceId === undefined || !Number.isFinite(deviceId)
                ? {}
                : { tags: { deviceId } }),
              meta: {
                tag,
                kind,
                recordId: record.id,
                error: err instanceof Error ? err.message : String(err),
              },
            },
          )
        }
      }
    }
    if (failed.length > 0) {
      throw new Error(
        `[tags] "${tag}" was not rewritten on ${failed.length} record(s) (${failed.slice(0, 5).join(', ')}); the style was left alone — repeat the call`,
      )
    }
    return updated
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
