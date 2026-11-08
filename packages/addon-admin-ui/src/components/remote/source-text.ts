/**
 * How a source issue reads to the operator. A rule the schema states in its own
 * words (a `custom` refinement) is shown as the schema wrote it; a generic Zod
 * issue (too short, wrong shape) gets a sentence in the operator's language.
 */
import type { RemoteSourceKind } from '@camstack/types'
import type { TFunction } from 'i18next'
import type { SourceIssue } from './remote-config-model'

export function issueText(issue: SourceIssue, t: TFunction): string {
  return t(`remote.sources.error.${issue.field}.${issue.code}`, { defaultValue: issue.message })
}

/** The fields the dialog shows issues under. */
export type SourceDialogField = 'name' | 'number' | 'steps' | 'transmitterId' | 'payload'

/** The issues for one field of the dialog; a digits source shows its step issues under the number. */
export function issuesFor(
  issues: readonly SourceIssue[],
  field: SourceDialogField,
  kind: RemoteSourceKind,
): readonly SourceIssue[] {
  return issues.filter((i) => {
    switch (field) {
      case 'name':
        return i.field === 'name' || i.field === 'id'
      case 'number':
        return i.field === 'number' || (kind === 'digits' && i.field === 'steps')
      case 'steps':
        return kind === 'sequence' && i.field === 'steps'
      case 'transmitterId':
      case 'payload':
        return kind === 'ir' && i.field === field
    }
  })
}
