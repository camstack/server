/**
 * Add or edit one source of a remote (planning#460): a channel number, a
 * sequence of bound buttons, or an infrared code of its own (planning#464). The
 * dialog holds a draft; the rules are the schema's, read back through
 * `draftIssues` (the whole config is parsed).
 */
import type { RemoteConfig, RemoteSource, RemoteSourceKind } from '@camstack/types'
import { REMOTE_SOURCE_KINDS } from '@camstack/types'
import {
  Button,
  FormField,
  IconButton,
  Input,
  ItemFormDialog,
  Select,
  Textarea,
} from '@camstack/ui-library'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LearnButton } from './LearnButton'
import {
  BLANK_SOURCE_DRAFT,
  boundStepRoles,
  draftIssues,
  draftOfSource,
  type IrCodeEncoding,
  type SourceDraft,
  upsertSource,
} from './remote-config-model'
import { type SourceDialogField, issuesFor, issueText } from './source-text'

/** A transmitter the operator can pick for an infrared source. */
export interface TransmitterOption {
  readonly id: number
  readonly label: string
}

export interface SourceDialogProps {
  readonly config: RemoteConfig
  /** The source being edited, or null to add one. */
  readonly source: RemoteSource | null
  readonly roleLabel: (role: string) => string
  /** The `ir-transmitter` devices an infrared source may send through. */
  readonly transmitters: readonly TransmitterOption[]
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

function isSourceKind(value: string): value is RemoteSourceKind {
  return REMOTE_SOURCE_KINDS.some((kind) => kind === value)
}

export function SourceDialog({
  config,
  source,
  roleLabel,
  transmitters,
  onClose,
  onSave,
}: SourceDialogProps): ReactNode {
  const { t } = useTranslation()
  // An infrared source goes through the remote's default emitter until one is chosen.
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
  const lines = (field: SourceDialogField): readonly string[] =>
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
            options={REMOTE_SOURCE_KINDS.map((kind) => ({
              value: kind,
              label: t(`remote.sources.kind.${kind}`),
            }))}
            onChange={(e) => {
              if (isSourceKind(e.target.value)) patch({ kind: e.target.value })
            }}
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
        {draft.kind === 'ir' && (
          <IrFields
            draft={draft}
            transmitters={transmitters}
            defaultTransmitterId={config.defaultTransmitterId}
            patch={patch}
            lines={lines}
          />
        )}
        {draft.kind === 'digits' && (
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
        )}
        {draft.kind === 'sequence' && (
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

interface IrFieldsProps {
  readonly draft: SourceDraft
  readonly transmitters: readonly TransmitterOption[]
  /** The remote's default emitter; the source goes through it unless one is chosen. */
  readonly defaultTransmitterId: number | null
  readonly patch: (next: Partial<SourceDraft>) => void
  readonly lines: (field: SourceDialogField) => readonly string[]
}

/** The transmitter, the format and the code of an `ir` source; the carrier only for a raw train. */
/** The encoding a Select value names; `native` is never picked, only learned. */
function encodingOf(value: string, current: IrCodeEncoding): IrCodeEncoding {
  if (value === 'pronto') return 'pronto'
  if (value === 'native' && current === 'native') return 'native'
  return 'raw'
}

function IrFields({
  draft,
  transmitters,
  defaultTransmitterId,
  patch,
  lines,
}: IrFieldsProps): ReactNode {
  const { t } = useTranslation()
  const defaultLabel = transmitters.find((d) => d.id === defaultTransmitterId)?.label
  const learnTransmitterId = draft.transmitterId ?? defaultTransmitterId ?? null
  return (
    <>
      <FormField label={t('remote.sources.dialog.transmitter')}>
        <Select
          value={draft.transmitterId === null ? '' : String(draft.transmitterId)}
          options={[
            {
              value: '',
              label:
                defaultLabel === undefined
                  ? t('remote.sources.dialog.noTransmitter')
                  : `${t('remote.sources.dialog.noTransmitter')} (${defaultLabel})`,
            },
            ...transmitters.map((d) => ({ value: String(d.id), label: d.label })),
          ]}
          onChange={(e) =>
            patch({ transmitterId: e.target.value === '' ? null : Number(e.target.value) })
          }
          data-testid="source-transmitter"
        />
      </FormField>
      <Errors lines={lines('transmitterId')} />
      {learnTransmitterId !== null && (
        <LearnButton transmitterId={learnTransmitterId} onLearned={patch} />
      )}
      <FormField label={t('remote.sources.dialog.encoding')}>
        <Select
          value={draft.encoding}
          options={[
            { value: 'raw', label: t('remote.sources.encoding.raw') },
            { value: 'pronto', label: t('remote.sources.encoding.pronto') },
            ...(draft.encoding === 'native'
              ? [{ value: 'native', label: t('remote.sources.encoding.native') }]
              : []),
          ]}
          onChange={(e) => patch({ encoding: encodingOf(e.target.value, draft.encoding) })}
          data-testid="source-encoding"
        />
      </FormField>
      <FormField
        label={t('remote.sources.dialog.code')}
        description={
          draft.encoding === 'pronto'
            ? t('remote.sources.dialog.prontoHint')
            : draft.encoding === 'native'
              ? t('remote.sources.dialog.nativeHint')
              : t('remote.sources.dialog.codeHint')
        }
      >
        <Textarea
          value={draft.code}
          rows={4}
          spellCheck={false}
          className="font-mono text-xs"
          state={lines('payload').length > 0 ? 'error' : 'default'}
          onChange={(e) => patch({ code: e.target.value })}
          data-testid="source-code"
        />
      </FormField>
      {draft.encoding === 'raw' && (
        <FormField
          label={t('remote.sources.dialog.carrier')}
          description={t('remote.sources.dialog.carrierHint')}
        >
          <Input
            value={draft.carrierKhz}
            inputMode="decimal"
            className="w-32"
            onChange={(e) => patch({ carrierKhz: e.target.value })}
            data-testid="source-carrier"
          />
        </FormField>
      )}
      <Errors lines={lines('payload')} />
    </>
  )
}
