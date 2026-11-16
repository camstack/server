/**
 * The remote-layout template editor, in-page in the Templates tab: the same
 * editor body the remote modal uses, inside the common Build editor frame
 * (pinned header and footer, the body scrolls on its own).
 */
import { LayoutTemplate } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  TemplateEditorFields,
  type TemplateDraft,
  TemplateUndoRedo,
  useTemplateEditorState,
} from '../../../components/remote/TemplateEditorDialog'
import { BuildEditorFrame } from '../shared/BuildEditorFrame'

export interface RemoteTemplateEditorProps {
  readonly draft: TemplateDraft
  readonly saving: boolean
  readonly error: string | null
  readonly onSave: (draft: TemplateDraft) => void
  readonly onClose: () => void
  /** Opens the shared Quick edit modal (name + tags); offered once the template exists. */
  readonly onQuickEdit?: () => void
}

export function RemoteTemplateEditor({
  draft,
  saving,
  error,
  onSave,
  onClose,
  onQuickEdit,
}: RemoteTemplateEditorProps): ReactNode {
  const { t } = useTranslation()
  const editor = useTemplateEditorState(draft, saving)
  return (
    <BuildEditorFrame
      testId="remote-template-editor"
      icon={LayoutTemplate}
      title={
        draft.id === null
          ? t('remote.templates.newTitle')
          : editor.name.trim() === ''
            ? t('remote.templates.editTitle')
            : editor.name
      }
      onClose={onClose}
      onQuickEdit={onQuickEdit}
      headerActions={<TemplateUndoRedo editor={editor} />}
      onSave={() => {
        const next = editor.toDraft()
        if (next !== null) onSave(next)
      }}
      saveDisabled={!editor.canSave}
      saving={saving}
      saveTestId="template-save"
    >
      <TemplateEditorFields editor={editor} draftId={draft.id} error={error} />
    </BuildEditorFrame>
  )
}
