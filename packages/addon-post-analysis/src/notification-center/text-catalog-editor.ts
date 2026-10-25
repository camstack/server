/**
 * The EDIT SURFACE's server half (Phase 2) — read the projected catalog, change
 * the hub language, override a key.
 *
 * Three lines of this file are the whole point:
 *
 *   `this.catalog.apply(next)`
 *
 * after every write. The durable store is not what a notification reads — the
 * ONE shared {@link NcTextCatalog} is, and it is otherwise refreshed on the
 * centre's reload tick. Without the apply, an operator who renames a word is
 * told "saved" and the next notification, minutes later, still says the old
 * one. Bounded staleness is the right answer for another node (D8); it is the
 * wrong answer for the node the operator is looking at.
 *
 * Everything else is refusal discipline. A patch naming a key no locale ships
 * is rejected WHOLE, before any write: half an edit round applied is a table
 * that disagrees with itself, and the operator's next action is to re-save the
 * half that vanished.
 *
 * It lives in its own file rather than on `NotificationCenter` so it can be
 * tested against a real store and a real catalog without a centre — the
 * override-wins property is the one Phase 1 promised and nothing exercised.
 */

import type { IScopedLogger } from '@camstack/types'
import type { NcLanguage, NcTextBundle, NcTextCatalog } from './text-catalog.js'
import type { NcTextCatalogStore } from './text-catalog-store.js'
import {
  applyNcTextOverridePatch,
  buildNcTextCatalogView,
  type NcTextCatalogView,
  type NcTextOverridePatch,
  unknownNcTextKeys,
} from './text-catalog-view.js'

export interface NcTextCatalogEditorDeps {
  readonly store: NcTextCatalogStore
  /** The LIVE catalog every producer shares — the reason the writes below
   *  re-apply rather than only persisting. */
  readonly catalog: NcTextCatalog
  readonly logger: IScopedLogger
  /** Production always uses the shipped files; tests narrow this. */
  readonly bundles?: Readonly<Record<NcLanguage, NcTextBundle>>
}

export class NcTextCatalogEditor {
  private readonly store: NcTextCatalogStore
  private readonly catalog: NcTextCatalog
  private readonly logger: IScopedLogger
  private readonly bundles: Readonly<Record<NcLanguage, NcTextBundle>> | undefined

  constructor(deps: NcTextCatalogEditorDeps) {
    this.store = deps.store
    this.catalog = deps.catalog
    this.logger = deps.logger
    this.bundles = deps.bundles
  }

  /**
   * The catalog as an editor sees it. `language` selects which locale's texts
   * to show and defaults to the hub's own — an operator may inspect and even
   * pre-translate a language the hub does not speak yet, which is the only way
   * to prepare a switch without the household reading half-English
   * notifications while he types.
   *
   * Re-reads the document first: another admin (or another node) may have
   * written since this process last ticked, and an editor opened on a stale
   * copy saves the stale copy back.
   */
  async view(language?: NcLanguage): Promise<NcTextCatalogView> {
    const snapshot = await this.store.load()
    this.catalog.apply(snapshot)
    return this.project(language ?? snapshot.language, snapshot.language)
  }

  /** Change the language every notification is written in — durably, and in
   *  the live catalog on this node at once. */
  async setLanguage(language: NcLanguage): Promise<NcTextCatalogView> {
    const before = this.catalog.language
    const next = await this.store.setLanguage(language)
    this.catalog.apply(next)
    this.logger.info('notification language changed', {
      meta: { from: before, to: next.language },
    })
    return this.project(next.language, next.language)
  }

  /**
   * Apply one edit round to a language's overrides.
   *
   * Refuses the WHOLE patch on any unknown key (never half-applied), and reads
   * the current document before merging so a concurrent edit to a different key
   * survives.
   */
  async setOverrides(language: NcLanguage, patch: NcTextOverridePatch): Promise<NcTextCatalogView> {
    const unknown = unknownNcTextKeys(Object.keys(patch), this.bundles)
    if (unknown.length > 0) {
      throw new Error(
        `no shipped locale carries these notification text keys: ${unknown.join(', ')}`,
      )
    }
    const base = await this.store.load()
    const merged = applyNcTextOverridePatch(base.overrides, language, patch)
    const next = await this.store.setOverrides(merged)
    this.catalog.apply(next)
    const kept = Object.keys(next.overrides[language] ?? {}).length
    this.logger.info('notification texts overridden', {
      meta: { language, edited: Object.keys(patch).length, overriddenKeys: kept },
    })
    return this.project(language, next.language)
  }

  private project(language: NcLanguage, activeLanguage: NcLanguage): NcTextCatalogView {
    return buildNcTextCatalogView({
      language,
      activeLanguage,
      overrides: this.catalog.snapshot.overrides,
      ...(this.bundles !== undefined ? { bundles: this.bundles } : {}),
    })
  }
}
