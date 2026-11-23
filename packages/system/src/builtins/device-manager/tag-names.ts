/**
 * The names of the tags a device carries, DERIVED beside `tagIds` (D1089).
 *
 * The tag records belong to the `core-blocks` builtin; the device manager does
 * not keep a second authority, only a read-through copy of id → name that
 * serves the synchronous row decode. It is revalidated at most once per
 * {@link TAG_NAMES_FRESH_MS} by the reads that surface names (the freshness
 * window belongs to the reader), never by a timer. An id with no record answers
 * `null` — the reader falls back to the kept legacy name, or shows nothing.
 */
import { errMsg, type IScopedLogger, type TagRecord } from '@camstack/types'

export const TAG_NAMES_FRESH_MS = 5_000

/** The two `tags` cap calls the device manager makes (over `ctx.api`). */
export interface TagNamesSource {
  list(): Promise<readonly TagRecord[]>
  ensure(name: string): Promise<TagRecord>
}

export class TagNames {
  private names: ReadonlyMap<string, string> = new Map()
  private refreshedAt = 0
  private inFlight: Promise<void> | null = null

  constructor(
    private readonly source: TagNamesSource | null,
    private readonly logger: IScopedLogger,
    private readonly now: () => number = Date.now,
  ) {}

  nameOf(id: string): string | null {
    return this.names.get(id) ?? null
  }

  /** Revalidate when older than the window. A failed read keeps the last answer. */
  async fresh(): Promise<void> {
    if (this.source === null) return
    if (this.now() - this.refreshedAt < TAG_NAMES_FRESH_MS) return
    await this.refresh()
  }

  async refresh(): Promise<void> {
    const source = this.source
    if (source === null) return
    if (this.inFlight !== null) return this.inFlight
    const run = (async (): Promise<void> => {
      try {
        const tags = await source.list()
        this.names = new Map(tags.map((tag) => [tag.id, tag.name]))
        this.refreshedAt = this.now()
      } catch (err) {
        this.logger.warn('tag names not refreshed — keeping the last answer', {
          meta: { error: errMsg(err) },
        })
      } finally {
        this.inFlight = null
      }
    })()
    this.inFlight = run
    return run
  }

  /** Resolve text names to ids through `ensureTag`; a name no tag cap can mint is left out. */
  async ensureIds(names: readonly string[]): Promise<string[]> {
    const source = this.source
    if (source === null) return []
    const ids: string[] = []
    for (const name of names) {
      const tag = await source.ensure(name)
      ids.push(tag.id)
    }
    await this.refresh()
    return ids
  }
}
