/**
 * In-place rename of an imported model's display name (Installed tab). A
 * pencil opens a one-line editor; Save sends the typed name, an empty one
 * restores the name the model was imported with. The model id is shown
 * beside it and never changes.
 */
import { useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { MODEL_DISPLAY_NAME_MAX, parseDisplayName } from '../display-name.js'
import { Trans, useT } from '../i18n/index.js'

export interface InlineRenameProps {
  readonly name: string
  readonly modelId: string
  readonly onRename: (name: string) => Promise<void>
  readonly onError: (message: string) => void
}

export function InlineRename({ name, modelId, onRename, onError }: InlineRenameProps) {
  const { t } = useT()
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  if (draft === null) {
    return (
      <span className="flex items-center gap-1 min-w-0">
        <span className="text-sm font-medium text-foreground truncate">
          {name} <span className="text-foreground-subtle font-normal">· {modelId}</span>
        </span>
        <button
          type="button"
          onClick={() => setDraft(name)}
          className="shrink-0 p-1.5 rounded-md text-foreground-subtle hover:text-foreground hover:bg-surface-hover"
          aria-label={t('inlineRename.renameName', { name })}
          title={t('inlineRename.rename')}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </button>
      </span>
    )
  }

  const parsed = parseDisplayName(draft)
  const save = async () => {
    if (parsed.kind === 'invalid') return
    setSaving(true)
    try {
      await onRename(draft)
      setDraft(null)
    } catch (err) {
      onError(err instanceof Error ? err.message : t('inlineRename.failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-1 min-w-0">
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={draft}
          maxLength={MODEL_DISPLAY_NAME_MAX}
          autoFocus
          aria-label={t('inlineRename.displayName')}
          placeholder={t('inlineRename.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') setDraft(null)
          }}
          className="min-w-0 flex-1 px-2 py-1 text-sm rounded-md border border-border bg-surface text-foreground focus:outline-none focus:border-primary/50"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || parsed.kind === 'invalid'}
          className="shrink-0 p-1.5 rounded-md text-primary hover:bg-primary/10 disabled:opacity-50"
          aria-label={t('inlineRename.saveName')}
        >
          <Check className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => setDraft(null)}
          disabled={saving}
          className="shrink-0 p-1.5 rounded-md text-foreground-subtle hover:text-foreground hover:bg-surface-hover"
          aria-label={t('inlineRename.cancel')}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <span className="block text-[10px] text-foreground-subtle">
        {parsed.kind === 'invalid' ? (
          <span className="text-danger">
            {parsed.code === 'control'
              ? t('displayName.control')
              : t('displayName.tooLong', { length: parsed.length, max: MODEL_DISPLAY_NAME_MAX })}
          </span>
        ) : parsed.kind === 'reset' ? (
          t('inlineRename.reset')
        ) : (
          <Trans
            i18nKey="inlineRename.idSame"
            values={{ modelId }}
            components={{ mono: <span className="font-mono" /> }}
          />
        )}
      </span>
    </div>
  )
}
