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
import { ArrowLeft, Redo2, Undo2 } from 'lucide-react'
import { type ReactNode, useReducer, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  canRedo,
  canUndo,
  type EditHistoryAction,
  editHistoryReducer,
  startHistory,
} from './edit-history'
import { CREATABLE_TEMPLATE_KINDS, savablePayload, templateKindView } from './template-kinds'

export interface TemplateDraft {
  /** `null` for a template that does not exist yet. */
  readonly id: string | null
  readonly kind: TemplateKind
  readonly name: string
  readonly payload: unknown
  /** Operator tags (D1054); absent leaves the stored tags alone. */
  readonly tags?: readonly string[]
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
          <TemplateEditorBody
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
export interface EditorSnapshot {
  readonly kind: TemplateKind
  readonly presetId: string
  readonly payload: unknown
}

/** Shown by a host that embeds the editor body in another dialog: a way back and a title. */
export interface TemplateEditorBack {
  /** What the back button names, e.g. the remote the layout belongs to. */
  readonly label: string
  readonly title: string
  readonly onBack: () => void
}

interface BodyProps {
  readonly draft: TemplateDraft
  readonly saving: boolean
  readonly error: string | null
  readonly onSave: (draft: TemplateDraft) => void
  readonly onClose: () => void
  readonly back?: TemplateEditorBack
}

/** The state of one template being edited: name, kind, preset and payload, with undo. */
export interface TemplateEditorState {
  readonly name: string
  readonly setName: (name: string) => void
  readonly kind: TemplateKind
  readonly presetId: string
  readonly payload: unknown
  readonly setPayload: (payload: unknown) => void
  readonly undo: () => void
  readonly redo: () => void
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly canSave: boolean
  readonly dispatch: (action: EditHistoryAction<EditorSnapshot>) => void
  /** The draft to hand to the save, or `null` while the payload is not savable. */
  readonly toDraft: () => TemplateDraft | null
}

/**
 * Tags are not edited here (Quick edit owns them); a save carries the stored
 * ones through `draft.tags`.
 */
export function useTemplateEditorState(draft: TemplateDraft, saving: boolean): TemplateEditorState {
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
  useHotkey('mod+z', undo, { allowInInput: false, label: 'Undo' })
  useHotkey('mod+shift+z', redo, { allowInInput: false, label: 'Redo' })
  const view = templateKindView(kind)
  const clean = savablePayload(kind, payload)
  const canSave = name.trim() !== '' && clean !== null && view.isSavable(payload) && !saving
  return {
    name,
    setName,
    kind,
    presetId,
    payload,
    setPayload,
    undo,
    redo,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    canSave,
    dispatch,
    toDraft: () =>
      clean === null
        ? null
        : {
            id: draft.id,
            kind,
            name: name.trim(),
            payload: clean,
            ...(draft.tags === undefined ? {} : { tags: draft.tags }),
          },
  }
}

/** The undo / redo pair, for whichever chrome hosts the editor. */
export function TemplateUndoRedo({ editor }: { readonly editor: TemplateEditorState }): ReactNode {
  const { t } = useTranslation()
  return (
    <>
      <IconButton
        icon={Undo2}
        size="sm"
        variant="ghost"
        aria-label={t('remote.history.undo')}
        title={t('remote.history.undo')}
        disabled={!editor.canUndo}
        onClick={editor.undo}
        data-testid="template-undo"
      />
      <IconButton
        icon={Redo2}
        size="sm"
        variant="ghost"
        aria-label={t('remote.history.redo')}
        title={t('remote.history.redo')}
        disabled={!editor.canRedo}
        onClick={editor.redo}
        data-testid="template-redo"
      />
    </>
  )
}

/** Name, kind, preset and the payload editor; the chrome around it is the host's. */
export function TemplateEditorFields({
  editor,
  draftId,
  error,
}: {
  readonly editor: TemplateEditorState
  readonly draftId: string | null
  readonly error: string | null
}): ReactNode {
  const { t } = useTranslation()
  const { kind, presetId, payload, name, dispatch } = editor
  const view = templateKindView(kind)
  const presets = view.presets(t)
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={t('remote.templates.name')}>
          <Input
            value={name}
            maxLength={120}
            onChange={(e) => editor.setName(e.target.value)}
            data-testid="template-name"
          />
        </FormField>
        {draftId === null && CREATABLE_TEMPLATE_KINDS.length > 1 && (
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
        {draftId === null && presets.length > 0 && (
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
                if (chosen !== undefined && name.trim() === '') editor.setName(chosen.label)
              }}
              data-testid="template-preset"
            />
          </FormField>
        )}
      </div>
      {view.renderEditor(payload, editor.setPayload)}
      {error !== null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </>
  )
}

/**
 * The editor of one template inside a dialog: the remote modal swaps it in for
 * its binding view. The Templates page edits in its own page section instead.
 */
export function TemplateEditorBody({
  draft,
  saving,
  error,
  onSave,
  onClose,
  back,
}: BodyProps): ReactNode {
  const { t } = useTranslation()
  const editor = useTemplateEditorState(draft, saving)
  return (
    <>
      <DialogHeader className="flex-row items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {back !== undefined && (
            <Button size="sm" variant="ghost" onClick={back.onBack} data-testid="template-back">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              <span className="truncate">{back.label}</span>
            </Button>
          )}
          <DialogTitle className="truncate">
            {back !== undefined
              ? back.title
              : draft.id === null
                ? t('remote.templates.newTitle')
                : t('remote.templates.editTitle')}
          </DialogTitle>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <TemplateUndoRedo editor={editor} />
        </div>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <TemplateEditorFields editor={editor} draftId={draft.id} error={error} />
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          disabled={!editor.canSave}
          onClick={() => {
            const next = editor.toDraft()
            if (next !== null) onSave(next)
          }}
          data-testid="template-save"
        >
          {t('common.save')}
        </Button>
      </DialogFooter>
    </>
  )
}
