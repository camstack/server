/**
 * Create or edit one template: its name and the editor of its kind. The save
 * is the caller's; a refusal comes back as text and the dialog stays open.
 */
import type { TemplateKind } from '@camstack/types'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  Select,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CREATABLE_TEMPLATE_KINDS, savablePayload, templateKindView } from './template-kinds'

export interface TemplateDraft {
  /** `null` for a template that does not exist yet. */
  readonly id: string | null
  readonly kind: TemplateKind
  readonly name: string
  readonly payload: unknown
}

export interface TemplateEditorDialogProps {
  readonly draft: TemplateDraft | null
  readonly saving: boolean
  readonly error: string | null
  readonly onSave: (draft: TemplateDraft) => void
  readonly onClose: () => void
}

export function TemplateEditorDialog({
  draft,
  saving,
  error,
  onSave,
  onClose,
}: TemplateEditorDialogProps): ReactNode {
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="xl" placement="sheet-on-mobile" scroll="body">
        {draft !== null && (
          <EditorBody
            key={draft.id ?? 'new'}
            draft={draft}
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
  readonly draft: TemplateDraft
  readonly saving: boolean
  readonly error: string | null
  readonly onSave: (draft: TemplateDraft) => void
  readonly onClose: () => void
}

function EditorBody({ draft, saving, error, onSave, onClose }: BodyProps): ReactNode {
  const { t } = useTranslation()
  const [kind, setKind] = useState<TemplateKind>(draft.kind)
  const [name, setName] = useState(draft.name)
  const [payload, setPayload] = useState<unknown>(draft.payload)
  const view = templateKindView(kind)
  const clean = savablePayload(kind, payload)
  const canSave = name.trim() !== '' && clean !== null && view.isSavable(payload) && !saving
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {draft.id === null ? t('remote.templates.newTitle') : t('remote.templates.editTitle')}
        </DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label={t('remote.templates.name')}>
            <Input
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              data-testid="template-name"
            />
          </FormField>
          {draft.id === null && CREATABLE_TEMPLATE_KINDS.length > 1 && (
            <FormField label={t('remote.templates.kind.label')}>
              <Select
                value={kind}
                options={CREATABLE_TEMPLATE_KINDS.map((k) => ({
                  value: k,
                  label: templateKindView(k).label(t),
                }))}
                onChange={(e) => {
                  const next = CREATABLE_TEMPLATE_KINDS.find((k) => k === e.target.value)
                  if (next === undefined) return
                  setKind(next)
                  setPayload(templateKindView(next).emptyPayload())
                }}
              />
            </FormField>
          )}
        </div>
        {view.renderEditor(payload, setPayload)}
        {error !== null && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          disabled={!canSave}
          onClick={() => onSave({ id: draft.id, kind, name: name.trim(), payload: clean })}
          data-testid="template-save"
        >
          {t('common.save')}
        </Button>
      </DialogFooter>
    </>
  )
}
