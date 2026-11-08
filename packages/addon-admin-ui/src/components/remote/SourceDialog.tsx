/**
 * Add or edit one source of a remote (planning#460): a channel number, or a
 * sequence of bound buttons. The dialog holds a draft; the rules are the
 * schema's, read back through `draftIssues` (the whole config is parsed).
 */
import type { RemoteConfig, RemoteSource } from '@camstack/types'
import { Button, FormField, IconButton, Input, ItemFormDialog, Select } from '@camstack/ui-library'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BLANK_SOURCE_DRAFT,
  boundStepRoles,
  draftIssues,
  draftOfSource,
  type SourceDraft,
  upsertSource,
} from './remote-config-model'
import { issuesFor, issueText } from './source-text'

export interface SourceDialogProps {
  readonly config: RemoteConfig
  /** The source being edited, or null to add one. */
  readonly source: RemoteSource | null
  readonly roleLabel: (role: string) => string
  readonly onClose: () => void
  readonly onSave: (next: RemoteConfig) => void
}

function Errors({ lines }: { readonly lines: readonly string[] }): ReactNode {
  if (lines.length === 0) return null
  return (
    <div role="alert" className="space-y-0.5 text-xs text-danger">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  )
}

export function SourceDialog({
  config,
  source,
  roleLabel,
  onClose,
  onSave,
}: SourceDialogProps): ReactNode {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<SourceDraft>(
    source === null ? BLANK_SOURCE_DRAFT : draftOfSource(source),
  )
  const [touched, setTouched] = useState(false)
  const [pick, setPick] = useState('')
  const issues = useMemo(
    () => draftIssues(config, draft, source?.id ?? null),
    [config, draft, source],
  )
  const bound = boundStepRoles(config)
  const patch = (next: Partial<SourceDraft>): void => setDraft((prev) => ({ ...prev, ...next }))
  const lines = (field: 'name' | 'number' | 'steps'): readonly string[] =>
    touched ? issuesFor(issues, field, draft.kind).map((i) => issueText(i, t)) : []

  const moveStep = (index: number, delta: -1 | 1): void => {
    const to = index + delta
    if (to < 0 || to >= draft.steps.length) return
    const next = [...draft.steps]
    const [moved] = next.splice(index, 1)
    if (moved === undefined) return
    next.splice(to, 0, moved)
    patch({ steps: next })
  }

  const save = (): void => {
    setTouched(true)
    if (issues.length > 0) return
    onSave(upsertSource(config, draft, source?.id ?? null))
  }

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      title={
        source === null ? t('remote.sources.dialog.addTitle') : t('remote.sources.dialog.editTitle')
      }
      testId="source-dialog"
      footer={
        <Button onClick={save} data-testid="source-save">
          {t('common.save')}
        </Button>
      }
    >
      <div className="space-y-4">
        <FormField label={t('remote.sources.dialog.kind')}>
          <Select
            value={draft.kind}
            options={[
              { value: 'digits', label: t('remote.sources.kind.digits') },
              { value: 'sequence', label: t('remote.sources.kind.sequence') },
            ]}
            onChange={(e) => patch({ kind: e.target.value === 'sequence' ? 'sequence' : 'digits' })}
            data-testid="source-kind"
          />
        </FormField>
        <FormField label={t('remote.sources.dialog.name')}>
          <Input
            value={draft.name}
            state={lines('name').length > 0 ? 'error' : 'default'}
            onChange={(e) => patch({ name: e.target.value })}
            data-testid="source-name"
          />
        </FormField>
        <Errors lines={lines('name')} />
        {draft.kind === 'digits' ? (
          <>
            <FormField
              label={t('remote.sources.dialog.number')}
              description={t('remote.sources.dialog.numberHint')}
            >
              <Input
                value={draft.number}
                inputMode="numeric"
                state={lines('number').length > 0 ? 'error' : 'default'}
                onChange={(e) => patch({ number: e.target.value })}
                data-testid="source-number"
              />
            </FormField>
            <Errors lines={lines('number')} />
          </>
        ) : (
          <div className="space-y-2">
            <FormField
              label={t('remote.sources.dialog.steps')}
              description={t('remote.sources.dialog.stepsHint')}
            >
              {draft.steps.length === 0 ? (
                <p className="text-xs text-foreground-muted">
                  {t('remote.sources.dialog.stepsEmpty')}
                </p>
              ) : (
                <ol className="space-y-1" data-testid="source-steps">
                  {draft.steps.map((role, index) => (
                    <li
                      // The same role may repeat ("down, down"): position is the identity.
                      key={`${index}:${role}`}
                      className="flex items-center gap-1 rounded border border-border bg-surface px-2 py-1"
                    >
                      <span className="w-5 text-xs text-foreground-subtle">{index + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {roleLabel(role)}
                      </span>
                      <IconButton
                        icon={ArrowUp}
                        size="sm"
                        variant="ghost"
                        aria-label={t('remote.sources.dialog.stepUp')}
                        disabled={index === 0}
                        onClick={() => moveStep(index, -1)}
                      />
                      <IconButton
                        icon={ArrowDown}
                        size="sm"
                        variant="ghost"
                        aria-label={t('remote.sources.dialog.stepDown')}
                        disabled={index === draft.steps.length - 1}
                        onClick={() => moveStep(index, 1)}
                      />
                      <IconButton
                        icon={Trash2}
                        size="sm"
                        variant="ghost"
                        aria-label={t('remote.sources.dialog.stepRemove')}
                        onClick={() => patch({ steps: draft.steps.filter((_, i) => i !== index) })}
                      />
                    </li>
                  ))}
                </ol>
              )}
            </FormField>
            {bound.length === 0 ? (
              <p className="text-xs text-foreground-muted" data-testid="source-no-bound">
                {t('remote.sources.dialog.noBound')}
              </p>
            ) : (
              <div className="flex items-center gap-2">
                <Select
                  aria-label={t('remote.sources.dialog.pickStep')}
                  value={pick}
                  options={[
                    { value: '', label: t('remote.sources.dialog.pickStep') },
                    ...bound.map((role) => ({ value: role, label: roleLabel(role) })),
                  ]}
                  onChange={(e) => setPick(e.target.value)}
                  data-testid="source-step-pick"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pick === ''}
                  onClick={() => {
                    patch({ steps: [...draft.steps, pick] })
                    setPick('')
                  }}
                  data-testid="source-step-add"
                >
                  {t('remote.sources.dialog.addStep')}
                </Button>
              </div>
            )}
            <Errors lines={lines('steps')} />
          </div>
        )}
      </div>
    </ItemFormDialog>
  )
}
