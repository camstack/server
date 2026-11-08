/**
 * How a source issue reads to the operator. A rule the schema states in its own
 * words (a `custom` refinement) is shown as the schema wrote it; a generic Zod
 * issue (too short, wrong shape) gets a sentence in the operator's language.
 */
import type { TFunction } from 'i18next'
import type { SourceIssue } from './remote-config-model'

export function issueText(issue: SourceIssue, t: TFunction): string {
  return t(`remote.sources.error.${issue.field}.${issue.code}`, { defaultValue: issue.message })
}

/** The issues for one field of the dialog; a digits source shows its step issues under the number. */
export function issuesFor(
  issues: readonly SourceIssue[],
  field: 'name' | 'number' | 'steps',
  kind: 'digits' | 'sequence',
): readonly SourceIssue[] {
  return issues.filter((i) => {
    if (field === 'name') return i.field === 'name' || i.field === 'id'
    if (field === 'number')
      return i.field === 'number' || (kind === 'digits' && i.field === 'steps')
    return kind === 'sequence' && i.field === 'steps'
  })
}
