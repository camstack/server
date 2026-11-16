/**
 * Quick edit — the ONE modal that sets the name and the tags of a Build item.
 * Every section (automation, action, scheduler, script, template, composed
 * device) opens it from a row action and, right after a new item is saved, so
 * the editors themselves carry no Tags field. The save is the section's own:
 * this component only collects the two values.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorBox,
  FormField,
  Input,
  TagInput,
} from '@camstack/ui-library'
import { Loader2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface QuickEditValues {
  readonly name: string
  readonly tags: readonly string[]
}

export interface QuickEditDialogProps {
  /** The item being edited; `null` keeps the modal closed. */
  readonly subject: QuickEditValues | null
  /** Identifies the item, so switching items resets the fields. */
  readonly subjectKey: string
  readonly saving: boolean
  readonly error: string | null
  readonly onSave: (next: QuickEditValues) => void
  readonly onClose: () => void
}

export function QuickEditDialog({
  subject,
  subjectKey,
  saving,
  error,
  onSave,
  onClose,
}: QuickEditDialogProps): ReactNode {
  return (
    <Dialog open={subject !== null} onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile" data-testid="quick-edit-dialog">
        {subject !== null && (
          <QuickEditBody
            key={subjectKey}
            subject={subject}
            saving={saving}
            error={error}
            onSave={onSave}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

interface BodyProps {
  readonly subject: QuickEditValues
  readonly saving: boolean
  readonly error: string | null
  readonly onSave: (next: QuickEditValues) => void
  readonly onClose: () => void
}

function QuickEditBody({ subject, saving, error, onSave, onClose }: BodyProps): ReactNode {
  const { t } = useTranslation()
  const [name, setName] = useState(subject.name)
  const [tags, setTags] = useState<readonly string[]>(subject.tags)
  const canSave = name.trim() !== '' && !saving
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('build.quickEdit.title', 'Quick edit')}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <FormField label={t('build.quickEdit.name', 'Name')}>
          <Input
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            data-testid="quick-edit-name"
          />
        </FormField>
        <div className="text-sm">
          <span className="text-foreground-subtle">{t('common.tags', 'Tags')}</span>
          <TagInput
            className="mt-1"
            value={tags}
            onChange={setTags}
            label={t('common.tags', 'Tags')}
          />
        </div>
        {error !== null && <ErrorBox message={error} />}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button
          disabled={!canSave}
          onClick={() => onSave({ name: name.trim(), tags })}
          data-testid="quick-edit-save"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} {t('common.save', 'Save')}
        </Button>
      </DialogFooter>
    </>
  )
}
