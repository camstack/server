/**
 * Save-time check of a `when` tree against the SITE: a `time-is` window
 * bounded by a sun event needs the site location, and any window needs a known
 * time zone. Refused before the save with a typed reason — at run time the
 * same leaf can only read `unknown`, and a rule that never decides is a rule
 * the operator believes is working. Pure: the site reading is handed in.
 */
import {
  type SiteReading,
  type TimeSpecRefusal,
  validateTimeSpecForSite,
} from '../time/time-spec.js'
import type { AutomationRecipe } from './recipe.js'
import { type AutomationWhen, forEachLeaf } from './when.js'

export interface WhenSiteIssue {
  /** `when.1.between.from` — the end of the window that cannot be placed. */
  readonly path: string
  readonly reason: TimeSpecRefusal
  readonly message: string
}

const WINDOW_ENDS = ['from', 'to'] as const

/** Every `time-is` window end of the tree this site cannot place. `rootPath` replaces the leading `when`. */
export function whenSiteIssues(
  when: AutomationWhen,
  reading: SiteReading,
  rootPath = 'when',
): WhenSiteIssue[] {
  const issues: WhenSiteIssue[] = []
  forEachLeaf(
    when,
    (leaf, path) => {
      if (leaf.kind !== 'time-is' || leaf.between === undefined) return
      for (const end of WINDOW_ENDS) {
        const checked = validateTimeSpecForSite(leaf.between[end], reading)
        if (!checked.ok) {
          issues.push({
            path: `${path}.between.${end}`,
            reason: checked.reason,
            message: checked.message,
          })
        }
      }
    },
    rootPath,
  )
  return issues
}

/** A step as far as its guard goes. */
export interface GuardedStepLike {
  readonly kind: string
  readonly if?: AutomationWhen | undefined
}

/** The same check over the guard (`if`) of every step of a list, reported under `<rootPath>.<i>.if`. */
export function stepGuardSiteIssues(
  steps: readonly GuardedStepLike[],
  reading: SiteReading,
  rootPath: string,
): WhenSiteIssue[] {
  return steps.flatMap((step, i) =>
    step.if === undefined ? [] : whenSiteIssues(step.if, reading, `${rootPath}.${i}.if`),
  )
}

/** The whole recipe: its `when` tree and every step guard. */
export function recipeSiteIssues(recipe: AutomationRecipe, reading: SiteReading): WhenSiteIssue[] {
  return [
    ...whenSiteIssues(recipe.when, reading),
    ...stepGuardSiteIssues(recipe.actions, reading, 'actions'),
  ]
}
