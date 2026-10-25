/**
 * The ONE durable document behind the text catalog: which language the hub
 * speaks, and the operator's per-key replacements.
 *
 * Backed by the `texts` record kind (`RecordKindHandle<TextsBody>`, built with
 * `static of(records, logger)`).
 *
 * Cross-node: every node reads the hub's records engine, so a
 * language changed on one node reaches the evaluating node on its next
 * {@link NcTextCatalogStore.load} — bounded staleness, never wrongness (D8).
 */

import type { IScopedLogger, RecordKindHandle, RecordsAccess } from '@camstack/types'
import {
  NC_DEFAULT_TEXT_SNAPSHOT,
  type NcLanguage,
  NcLanguageSchema,
  type NcTextOverrides,
  type NcTextSnapshot,
} from './text-catalog.js'
import { ncRecordKinds, type TextsBody } from './record-kinds.js'

/**
 * @durable class=config owner=pipeline-analytics
 *   write="one row, id `texts`, rewritten wholesale when the operator changes the hub
 *     language (`setLanguage`) or replaces the per-key override set (`setOverrides`).
 *     Both re-read first, so a concurrent edit on another node is not clobbered"
 *   retention="none — a single document, overwritten in place; nothing deletes it. Losing
 *     it costs the chosen language and the household's preferred wording, never a
 *     notification: every read path degrades to the shipped English catalog."
 */
export const NC_TEXTS_COLLECTION = 'notification-center:texts'

/** One row, always this id — the document IS the setting. */
export const NC_TEXTS_DOC_ID = 'texts'

/**
 * Catalog keys that left the shipped files. {@link NcTextCatalogStore.load} DROPS such an
 * override from the snapshot it hands out; it never writes back.
 */
export const NC_RETIRED_TEXT_KEYS: readonly string[] = ['detection.body.enhanced']

export interface NcTextCatalogStoreRecordsDeps {
  readonly kind: RecordKindHandle<TextsBody>
  readonly logger: IScopedLogger
}

export type NcTextCatalogStoreDeps = NcTextCatalogStoreRecordsDeps

export class NcTextCatalogStore {
  private current: NcTextSnapshot = NC_DEFAULT_TEXT_SNAPSHOT
  private readonly kind: RecordKindHandle<TextsBody>
  private readonly logger: IScopedLogger
  private readonly retiredReported = new Set<string>()

  constructor(deps: NcTextCatalogStoreDeps) {
    this.logger = deps.logger
    this.kind = deps.kind
  }

  static of(records: Pick<RecordsAccess, 'kind'>, logger: IScopedLogger): NcTextCatalogStore {
    return new NcTextCatalogStore({ kind: records.kind(ncRecordKinds.texts), logger })
  }

  get snapshot(): NcTextSnapshot {
    return this.current
  }

  async load(): Promise<NcTextSnapshot> {
    try {
      const row = await this.kind.get(NC_TEXTS_DOC_ID)
      if (row === null) {
        this.current = NC_DEFAULT_TEXT_SNAPSHOT
        return this.current
      }
      this.current = this.withoutRetired(this.parseBody(row.data))
      return this.current
    } catch (err) {
      this.logger.warn('notification text settings could not be read — keeping the current ones', {
        meta: { error: String(err), language: this.current.language },
      })
      return this.current
    }
  }

  async setLanguage(language: NcTextSnapshot['language']): Promise<NcTextSnapshot> {
    const base = await this.load()
    return this.write({ language, overrides: base.overrides })
  }

  async setOverrides(overrides: NcTextOverrides): Promise<NcTextSnapshot> {
    const base = await this.load()
    return this.write({ language: base.language, overrides })
  }

  private async write(next: NcTextSnapshot): Promise<NcTextSnapshot> {
    await this.kind.put({
      id: NC_TEXTS_DOC_ID,
      data: { language: next.language, overrides: next.overrides },
    })
    this.current = next
    return this.current
  }

  private withoutRetired(snapshot: NcTextSnapshot): NcTextSnapshot {
    const kept: Partial<Record<NcLanguage, Readonly<Record<string, string>>>> = {}
    for (const language of NcLanguageSchema.options) {
      const table = snapshot.overrides[language]
      if (table === undefined) continue
      const live: Record<string, string> = {}
      for (const [key, text] of Object.entries(table)) {
        if (!NC_RETIRED_TEXT_KEYS.includes(key)) {
          live[key] = text
          continue
        }
        if (this.retiredReported.has(key)) continue
        this.retiredReported.add(key)
        this.logger.info('retired text override dropped — the key left the catalog', {
          meta: { key, language },
        })
      }
      if (Object.keys(live).length > 0) kept[language] = live
    }
    return { language: snapshot.language, overrides: kept }
  }

  private parseBody(data: TextsBody): NcTextSnapshot {
    const language = NcLanguageSchema.safeParse(data.language)
    if (!language.success) {
      this.logger.warn(
        'notification text settings row has unknown language — defaulting to English',
        {
          meta: { raw: String(data.language) },
        },
      )
      return { language: NC_DEFAULT_TEXT_SNAPSHOT.language, overrides: data.overrides ?? {} }
    }
    return { language: language.data, overrides: data.overrides ?? {} }
  }
}
