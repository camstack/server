/**
 * The shortcut from a remote to its layout template: opens System → Templates
 * with the editor already on that template (`?edit=<templateId>`).
 */
import { Button } from '@camstack/ui-library'
import { Pencil } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

export const TEMPLATE_EDIT_PARAM = 'edit'

export function templateEditPath(templateId: string): string {
  return `/system/templates?${TEMPLATE_EDIT_PARAM}=${encodeURIComponent(templateId)}`
}

export interface EditTemplateButtonProps {
  readonly templateId: string
  readonly testId?: string
}

export function EditTemplateButton({ templateId, testId }: EditTemplateButtonProps): ReactNode {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => navigate(templateEditPath(templateId))}
      data-testid={testId ?? 'remote-edit-template'}
    >
      <Pencil className="h-3.5 w-3.5" aria-hidden />
      {t('remote.editTemplate')}
    </Button>
  )
}
