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
  IconButton,
  Select,
  useHotkey,
} from '@camstack/ui-library'
import { Redo2, Undo2 } from 'lucide-react'
import { type ReactNode, useReducer, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { canRedo, canUndo, editHistoryReducer, startHistory } from './edit-history'
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

/** What one undo step restores. */
interface EditorSnapshot {
  readonly kind: TemplateKind
  readonly presetId: string
  readonly payload: unknown
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
  const [name, setName] = useState(draft.name)
  // Kind, preset and payload move together, so one undo step never leaves a
  // payload under the wrong kind. The name is a text field and keeps its own undo.
  const [history, dispatch] = useReducer(
    editHistoryReducer<EditorSnapshot>,
    { kind: draft.kind, presetId: '', payload: draft.payload },
    startHistory,
  )
  const { kind, presetId, payload } = history.present
  const setPayload = (next: unknown): void =>
    dispatch({ type: 'edit', value: { ...history.present, payload: next } })
  const undo = (): void => dispatch({ type: 'undo' })
  const redo = (): void => dispatch({ type: 'redo' })
  // Left to the field while one has focus (`allowInInput` off), so typing keeps its own undo.
  useHotkey('mod+z', undo, { allowInInput: false })
  useHotkey('mod+shift+z', redo, { allowInInput: false })
  const view = templateKindView(kind)
  const presets = view.presets(t)
  const clean = savablePayload(kind, payload)
  const canSave = name.trim() !== '' && clean !== null && view.isSavable(payload) && !saving
  return (
    <>
      <DialogHeader className="flex-row items-center justify-between gap-2">
        <DialogTitle>
          {draft.id === null ? t('remote.templates.newTitle') : t('remote.templates.editTitle')}
        </DialogTitle>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            icon={Undo2}
            size="sm"
            variant="ghost"
            aria-label={t('remote.history.undo')}
            title={t('remote.history.undo')}
            disabled={!canUndo(history)}
            onClick={undo}
            data-testid="template-undo"
          />
          <IconButton
            icon={Redo2}
            size="sm"
            variant="ghost"
            aria-label={t('remote.history.redo')}
            title={t('remote.history.redo')}
            disabled={!canRedo(history)}
            onClick={redo}
            data-testid="template-redo"
          />
        </div>
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
                  dispatch({
                    type: 'edit',
                    value: {
                      kind: next,
                      presetId: '',
                      payload: templateKindView(next).emptyPayload(),
                    },
                  })
                }}
              />
            </FormField>
          )}
          {draft.id === null && presets.length > 0 && (
            <FormField label={t('remote.templates.startFrom')}>
              <Select
                value={presetId}
                options={[
                  { value: '', label: t('remote.templates.startBlank') },
                  ...presets.map((p) => ({ value: p.id, label: p.label })),
                ]}
                onChange={(e) => {
                  const chosen = presets.find((p) => p.id === e.target.value)
                  dispatch({
                    type: 'edit',
                    value: {
                      kind,
                      presetId: chosen?.id ?? '',
                      payload: chosen === undefined ? view.emptyPayload() : chosen.payload(),
                    },
                  })
                  if (chosen !== undefined && name.trim() === '') setName(chosen.label)
                }}
                data-testid="template-preset"
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
