/**
 * "New automation": blank, or made from a template. With no template to offer
 * the choice is not shown — the editor just opens blank.
 */
import { AutomationTemplatePayloadSchema } from '@camstack/types'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Skeleton,
  useTemplateList,
} from '@camstack/ui-library'
import { type ReactNode, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

export interface NewAutomationChooserProps {
  readonly open: boolean
  readonly onBlank: () => void
  readonly onTemplate: (templateId: string) => void
  readonly onClose: () => void
}

export function NewAutomationChooser({
  open,
  onBlank,
  onTemplate,
  onClose,
}: NewAutomationChooserProps): ReactNode {
  const { t } = useTranslation()
  const list = useTemplateList({ kind: 'automation' }, { enabled: open })
  const none = list.data !== undefined && list.data.length === 0
  useEffect(() => {
    if (open && none) onBlank()
  }, [open, none, onBlank])
  return (
    <Dialog open={open && !none} onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile">
        <DialogHeader>
          <DialogTitle>{t('build.templates.newAutomationTitle', 'New automation')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-2" data-testid="new-automation-chooser">
          <Button
            variant="outline"
            className="h-auto w-full justify-start whitespace-normal py-2 text-left"
            onClick={onBlank}
            data-testid="new-automation-blank"
          >
            <span className="block">
              <span className="block font-medium">{t('build.templates.blank', 'Blank')}</span>
              <span className="block text-xs text-foreground-muted">
                {t('build.templates.blankHint', 'Start from an empty trigger and steps.')}
              </span>
            </span>
          </Button>
          {list.data === undefined ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            list.data.map((record) => (
              <Button
                key={record.id}
                variant="outline"
                className="h-auto w-full justify-start whitespace-normal py-2 text-left"
                onClick={() => onTemplate(record.id)}
                data-testid={`new-automation-template-${record.id}`}
              >
                <span className="block">
                  <span className="block font-medium">{record.name}</span>
                  <span className="block text-xs text-foreground-muted">
                    {AutomationTemplatePayloadSchema.safeParse(record.payload).data?.description ??
                      t(
                        'build.templates.fromTemplateHint',
                        'From a template — only its inputs to fill in.',
                      )}
                  </span>
                </span>
              </Button>
            ))
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
