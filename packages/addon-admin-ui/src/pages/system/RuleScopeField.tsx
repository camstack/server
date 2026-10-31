/**
 * One scope axis of a rule — its devices, or its detection classes — as ONE
 * field (D641, operator ruling 2026-09-26): a segmented pre-selector
 * "All | Only these | All except these" and, for the two list modes, ONE
 * picker underneath. The two stored lists never sit side by side again.
 *
 * The decisions are `rule-scope-model.ts` (shared with the viewer,
 * byte-identical); this file draws them:
 *
 *  - All draws no picker at all — there is nothing to pick.
 *  - A mode switch moves nothing: the list left behind stays in the draft, and
 *    what Save will clear is SAID under the picker, never done quietly.
 *  - A legacy rule carrying BOTH lists opens in Only with a one-line notice
 *    naming its exclusions and a "Remove exclusions" action (D49): they are
 *    never dropped by a read or a save, only by the operator.
 *  - "All except these" is offered only when the hub serves the matching
 *    exclude condition (`exceptOffered`): a hub that does not know it would
 *    strip the key and the rule would silently include what the operator
 *    excluded.
 *
 * The picker itself is the caller's (`renderPicker`), so devices and classes
 * each keep their own list, noun and grouping.
 */

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@camstack/ui-library'
import {
  RULE_SCOPE_MODES,
  type RuleScopeDraft,
  type RuleScopeId,
  type RuleScopeMode,
  removeRuleScopeExclusions,
  ruleScopeClearedOnSave,
  ruleScopeLegacyExclusions,
  ruleScopeList,
  setRuleScopeList,
  switchRuleScopeMode,
} from './rule-scope-model'

/** The list mode a picker is drawn for. */
export type RuleScopeListMode = Exclude<RuleScopeMode, 'all'>

/** The pre-selector's words: English fallbacks for `ruleScope.mode.<mode>` (en + it). */
export const RULE_SCOPE_MODE_LABEL: Readonly<Record<RuleScopeMode, string>> = {
  all: 'All',
  only: 'Only these',
  except: 'All except these',
}

/** What one scope field lists — the key of its plural and "every …" words. */
export type RuleScopeAxis = 'devices' | 'classes' | 'zones' | 'faces' | 'labels' | 'calendars'

/** English fallbacks for `ruleScope.items.<axis>` and `ruleScope.every.<axis>`. */
const AXIS_WORDS: Readonly<
  Record<RuleScopeAxis, { readonly items: string; readonly every: string }>
> = {
  devices: { items: 'devices', every: 'Every device — no restriction.' },
  classes: { items: 'classes', every: 'Every class — no restriction.' },
  zones: { items: 'zones', every: 'Every zone — no restriction.' },
  faces: { items: 'faces', every: 'Every face — no restriction.' },
  labels: { items: 'labels', every: 'Every label — no restriction.' },
  calendars: { items: 'calendars', every: 'Every calendar — no restriction.' },
}

export interface RuleScopeFieldProps<Id extends RuleScopeId> {
  readonly draft: RuleScopeDraft<Id>
  readonly onChange: (next: RuleScopeDraft<Id>) => void
  /** The hub serves the exclude condition for this axis and trigger. */
  readonly exceptOffered: boolean
  /** What the field lists — the pre-selector's accessible name and sentences. */
  readonly plural: RuleScopeAxis
  /** The one picker, over the active mode's list. */
  readonly renderPicker: (
    value: readonly Id[],
    onChange: (next: Id[]) => void,
    mode: RuleScopeListMode,
  ) => ReactNode
  /** An id as the notices name it (a device's name, a class's label). */
  readonly describe: (id: Id) => string
  readonly testId?: string
}

export function RuleScopeField<Id extends RuleScopeId>({
  draft,
  onChange,
  exceptOffered,
  plural,
  renderPicker,
  describe,
  testId,
}: RuleScopeFieldProps<Id>) {
  const { t } = useTranslation()
  // `{{items}}` is filled here as well as by i18next: an i18n instance that has
  // not initialised (a test, a first paint) returns the fallback UNinterpolated.
  const withItems = (key: string, fallback: string, value: string): string =>
    t(key, { items: value, defaultValue: fallback }).replaceAll('{{items}}', value)
  const items = t(`ruleScope.items.${plural}`, AXIS_WORDS[plural].items)
  const modes = RULE_SCOPE_MODES.filter(
    (mode) => mode !== 'except' || exceptOffered || draft.mode === 'except',
  )
  const legacy = ruleScopeLegacyExclusions(draft)
  const cleared = ruleScopeClearedOnSave(draft)
  const listMode: RuleScopeListMode | null = draft.mode === 'all' ? null : draft.mode

  return (
    <div className="mt-1 space-y-1.5" data-testid={testId}>
      <div
        role="radiogroup"
        aria-label={withItems('ruleScope.which', 'Which {{items}}', items)}
        className="inline-flex flex-wrap items-center gap-1"
      >
        {modes.map((mode) => {
          const active = mode === draft.mode
          return (
            <Button
              variant="unstyled"
              key={mode}
              type="button"
              role="radio"
              aria-checked={active}
              data-testid={`scope-mode-${mode}`}
              onClick={() => onChange(switchRuleScopeMode(draft, mode))}
              className={
                active
                  ? 'rounded-md border border-primary bg-primary/10 px-2 py-0.5 text-[11px] text-primary'
                  : 'rounded-md border border-border px-2 py-0.5 text-[11px] text-foreground-subtle hover:bg-surface-hover'
              }
            >
              {t(`ruleScope.mode.${mode}`, RULE_SCOPE_MODE_LABEL[mode])}
            </Button>
          )
        })}
      </div>
      {listMode === null ? (
        <p className="text-[11px] text-foreground-subtle">
          {t(`ruleScope.every.${plural}`, AXIS_WORDS[plural].every)}
        </p>
      ) : (
        renderPicker(
          ruleScopeList(draft),
          (next) => onChange(setRuleScopeList(draft, next)),
          listMode,
        )
      )}
      {legacy.length > 0 && (
        <p className="text-[11px] text-warning" data-testid="scope-legacy-exclusions">
          {withItems(
            'ruleScope.legacy',
            'This rule also excludes {{items}} — kept when you save.',
            legacy.map(describe).join(', '),
          )}{' '}
          <Button
            variant="unstyled"
            type="button"
            className="underline hover:no-underline"
            onClick={() => onChange(removeRuleScopeExclusions(draft))}
          >
            {t('ruleScope.removeExclusions', 'Remove exclusions')}
          </Button>
        </p>
      )}
      {cleared.length > 0 && (
        <p className="text-[11px] text-foreground-subtle" data-testid="scope-cleared-on-save">
          {withItems(
            'ruleScope.cleared',
            'Saving in this mode clears {{items}} from the rule.',
            cleared.map(describe).join(', '),
          )}
        </p>
      )}
    </div>
  )
}
