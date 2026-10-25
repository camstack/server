/**
 * A rule's SCOPE on one axis — its devices, or its detection classes — as the
 * editor presents it: a pre-selector "All | Only these | All except these"
 * over ONE picker (D641, operator ruling 2026-09-26).
 *
 * The rule stores two lists per axis (`devices` / `devicesExclude`,
 * `classes` / `classesExclude`), and the engine evaluates each independently.
 * The editor used to show them as two unrelated fields, and the combination
 * of both is one nobody means — so the editor shows ONE field whose mode picks
 * which list the picker edits. The mode is DERIVED from the stored lists, never
 * stored: include non-empty → Only; else exclude non-empty → Except; else All.
 *
 * What this module decides, and the two rules that shaped it:
 *
 *  - Switching the mode MOVES NOTHING. The list of the mode you leave stays in
 *    the draft, so switching back restores it; only a SAVE writes, and it
 *    writes the active mode's list alone. What the save will clear is
 *    {@link ruleScopeClearedOnSave}, so the editor can say it rather than do it
 *    quietly.
 *  - D49, the LEGACY case: a stored rule carrying BOTH lists opens in Only,
 *    and its exclusions are neither shown as a second field nor dropped on
 *    save. {@link ruleScopeLegacyExclusions} lists them for a one-line notice,
 *    and only the operator removes them ({@link removeRuleScopeExclusions}).
 *
 * It reads nothing and imports nothing: the id is generic (a device id, a
 * class name).
 *
 * TWO BYTE-IDENTICAL COPIES: `camstack/src/components/notifications/
 * rule-scope-model.ts` (viewer) and `packages/addon-admin-ui/src/pages/system/
 * rule-scope-model.ts` (admin), for the reason `device-selection.ts` has two.
 * `scripts/check-device-selection-in-sync.ts` fails the commit when they
 * differ; edit both. No `toSorted` here: the viewer runs on Hermes.
 */

/** What a scoped list holds: a device id, or a class name. */
export type RuleScopeId = number | string

/** The pre-selector's three states, in the order the control draws them. */
export const RULE_SCOPE_MODES = ['all', 'only', 'except'] as const
export type RuleScopeMode = (typeof RULE_SCOPE_MODES)[number]

/** One axis of a rule being edited. */
export interface RuleScopeDraft<Id extends RuleScopeId> {
  readonly mode: RuleScopeMode
  /** The "Only these" list — kept while another mode is active. */
  readonly include: readonly Id[]
  /** The "All except these" list — kept while another mode is active. */
  readonly exclude: readonly Id[]
  /**
   * The rule was OPENED carrying both lists (legacy). Its exclusions ride
   * along with Only until the operator removes them — never dropped by a
   * save (D49).
   */
  readonly legacyBoth: boolean
}

/** What a save writes for one axis. An absent key is written as absent. */
export interface RuleScopeSave<Id extends RuleScopeId> {
  readonly include?: readonly Id[]
  readonly exclude?: readonly Id[]
}

/** The mode two stored lists mean. Include wins: it is the narrower reading. */
export function ruleScopeModeOf<Id extends RuleScopeId>(
  include: readonly Id[] | undefined,
  exclude: readonly Id[] | undefined,
): RuleScopeMode {
  if ((include ?? []).length > 0) return 'only'
  if ((exclude ?? []).length > 0) return 'except'
  return 'all'
}

/** The draft a stored rule opens as. */
export function ruleScopeDraftOf<Id extends RuleScopeId>(
  include: readonly Id[] | undefined,
  exclude: readonly Id[] | undefined,
): RuleScopeDraft<Id> {
  const inc = [...(include ?? [])]
  const exc = [...(exclude ?? [])]
  return {
    mode: ruleScopeModeOf(inc, exc),
    include: inc,
    exclude: exc,
    legacyBoth: inc.length > 0 && exc.length > 0,
  }
}

/** Switch the pre-selector. Both lists are kept; nothing is written until save. */
export function switchRuleScopeMode<Id extends RuleScopeId>(
  draft: RuleScopeDraft<Id>,
  mode: RuleScopeMode,
): RuleScopeDraft<Id> {
  return { ...draft, mode }
}

/** The list the ONE picker edits in this mode; `All` edits none. */
export function ruleScopeList<Id extends RuleScopeId>(draft: RuleScopeDraft<Id>): readonly Id[] {
  switch (draft.mode) {
    case 'only':
      return draft.include
    case 'except':
      return draft.exclude
    case 'all':
      return []
  }
}

/** The picker changed its list. Under `All` there is no list, so nothing moves. */
export function setRuleScopeList<Id extends RuleScopeId>(
  draft: RuleScopeDraft<Id>,
  next: readonly Id[],
): RuleScopeDraft<Id> {
  switch (draft.mode) {
    case 'only':
      return { ...draft, include: [...next] }
    case 'except':
      return { ...draft, exclude: [...next] }
    case 'all':
      return draft
  }
}

/** The legacy exclusions the notice under an Only picker lists; `[]` otherwise. */
export function ruleScopeLegacyExclusions<Id extends RuleScopeId>(
  draft: RuleScopeDraft<Id>,
): readonly Id[] {
  return draft.mode === 'only' && draft.legacyBoth ? draft.exclude : []
}

/** The notice's action: the operator removes the legacy exclusions. */
export function removeRuleScopeExclusions<Id extends RuleScopeId>(
  draft: RuleScopeDraft<Id>,
): RuleScopeDraft<Id> {
  return { ...draft, exclude: [], legacyBoth: false }
}

/** What a save writes: the active mode's list, plus legacy exclusions still kept. */
export function projectRuleScope<Id extends RuleScopeId>(
  draft: RuleScopeDraft<Id>,
): RuleScopeSave<Id> {
  switch (draft.mode) {
    case 'all':
      return {}
    case 'except':
      return draft.exclude.length > 0 ? { exclude: [...draft.exclude] } : {}
    case 'only': {
      const legacy = ruleScopeLegacyExclusions(draft)
      return {
        ...(draft.include.length > 0 ? { include: [...draft.include] } : {}),
        ...(legacy.length > 0 ? { exclude: [...legacy] } : {}),
      }
    }
  }
}

/**
 * The ids a save would CLEAR from the list the active mode does not edit — the
 * list left behind by a mode switch. Said by the editor before Save, so a
 * switch never removes anything the operator was not told about.
 */
export function ruleScopeClearedOnSave<Id extends RuleScopeId>(
  draft: RuleScopeDraft<Id>,
): readonly Id[] {
  const saved = projectRuleScope(draft)
  const include = saved.include ?? []
  const exclude = saved.exclude ?? []
  return [
    ...draft.include.filter((id) => !include.includes(id)),
    ...draft.exclude.filter((id) => !exclude.includes(id)),
  ]
}
