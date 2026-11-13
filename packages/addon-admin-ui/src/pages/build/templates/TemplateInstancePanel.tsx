/**
 * Loads the template an automation is (or is about to be) made from and hands
 * the editor what it needs. A template that answered `null` is gone — the
 * editor then offers only to convert; one that is still loading shows a
 * skeleton, never "gone" (D315).
 */
import {
  AutomationTemplatePayloadSchema,
  type AutomationRecipe,
  type CoreBlock,
  type CoreBlockInput,
} from '@camstack/types'
import { ErrorBox, Skeleton, useTemplateGet } from '@camstack/ui-library'
import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { TemplateInstanceEditor } from './TemplateInstanceEditor'
import { initialValues } from './template-values'

export interface TemplateInstancePanelProps {
  readonly templateId: string
  /** `null` while creating. */
  readonly existing: CoreBlock | null
  /** The stored recipe of an existing instance. */
  readonly recipe: AutomationRecipe | null
  readonly saving: boolean
  readonly saveError: string | null
  readonly onSave: (input: CoreBlockInput) => void
  readonly onCancel: () => void
}

export function TemplateInstancePanel({
  templateId,
  existing,
  recipe,
  saving,
  saveError,
  onSave,
  onCancel,
}: TemplateInstancePanelProps): ReactNode {
  const { t } = useTranslation()
  const query = useTemplateGet({ id: templateId })
  if (query.status === 'error') {
    return (
      <ErrorBox
        title={t('build.templates.loadFailed', 'Could not read the template')}
        message={query.error.message}
        onRetry={() => void query.refetch()}
      />
    )
  }
  if (query.data === undefined) return <Skeleton className="h-24 w-full" />
  const record = query.data
  const parsed = record === null ? null : AutomationTemplatePayloadSchema.safeParse(record.payload)
  if (parsed !== null && !parsed.success) {
    return (
      <ErrorBox
        title={t('build.templates.unreadable', 'This template cannot be read')}
        message={parsed.error.issues[0]?.message ?? ''}
      />
    )
  }
  const payload = parsed === null ? null : parsed.data
  const link = recipe?.template
  return (
    <TemplateInstanceEditor
      key={existing?.id ?? `new:${templateId}`}
      templateId={templateId}
      templateName={record === null ? null : record.name}
      payload={payload}
      existing={existing}
      currentRecipe={recipe}
      initialName={existing?.name ?? record?.name ?? ''}
      initialValues={link?.values ?? (payload === null ? {} : initialValues(payload))}
      storedProblems={link?.problems ?? []}
      saving={saving}
      saveError={saveError}
      onSave={onSave}
      onCancel={onCancel}
    />
  )
}
