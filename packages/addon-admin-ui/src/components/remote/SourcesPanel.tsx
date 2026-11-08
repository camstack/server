/**
 * The Sources section of the Remote editor (planning#460): the list a media
 * player's source picker offers, declared by the operator — a button is never a
 * source on its own. Edits go through the pure model; nothing is saved here.
 */
import type { RemoteConfig, RemoteSource } from '@camstack/types'
import {
  REMOTE_STEP_DELAY_MAX_MS,
  REMOTE_STEP_DELAY_MIN_MS,
  remoteSourceSteps,
} from '@camstack/types'
import {
  Badge,
  Button,
  type DataColumn,
  DataTable,
  EmptyState,
  FormField,
  IconButton,
  Input,
} from '@camstack/ui-library'
import { ArrowDown, ArrowUp, ListVideo, Pencil, Plus, Trash2 } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  deleteSource,
  irSourceSummary,
  moveSource,
  setStepDelay,
  sourceIssues,
} from './remote-config-model'
import { SourceDialog, type TransmitterOption } from './SourceDialog'
import { issueText } from './source-text'

export interface SourcesPanelProps {
  readonly config: RemoteConfig
  readonly onChange: (update: (prev: RemoteConfig) => RemoteConfig) => void
  readonly roleLabel: (role: string) => string
  /** The `ir-transmitter` devices an infrared source may send through. */
  readonly transmitters: readonly TransmitterOption[]
}

/** One line on what a source IS: its number, its steps, or the code it carries. */
function SourceDetail({
  source,
  roleLabel,
}: {
  readonly source: RemoteSource
  readonly roleLabel: (role: string) => string
}): ReactNode {
  const { t } = useTranslation()
  switch (source.kind) {
    case 'digits':
      return source.number
    case 'sequence':
      return remoteSourceSteps(source).map(roleLabel).join(' → ')
    case 'ir': {
      const summary = irSourceSummary(source)
      if (summary.pulses === null) return t('remote.sources.irDetailBroken')
      return summary.carrierKhz === null
        ? t('remote.sources.irDetail', { pulses: summary.pulses })
        : t('remote.sources.irDetailCarrier', { pulses: summary.pulses, khz: summary.carrierKhz })
    }
  }
}

type Editing = { readonly source: RemoteSource | null } | null

export function SourcesPanel({
  config,
  onChange,
  roleLabel,
  transmitters,
}: SourcesPanelProps): ReactNode {
  const { t } = useTranslation()
  const [editing, setEditing] = useState<Editing>(null)
  const issues = useMemo(() => sourceIssues(config), [config])
  const last = config.sources.length - 1

  const columns: readonly DataColumn<RemoteSource>[] = [
    {
      key: 'name',
      header: t('remote.sources.col.name'),
      nowrap: false,
      render: (s) => (
        <div className="space-y-1">
          <span className="font-medium text-foreground">{s.name}</span>
          <div>
            <Badge variant="default">{t(`remote.sources.kind.${s.kind}`)}</Badge>
          </div>
        </div>
      ),
    },
    {
      key: 'detail',
      header: t('remote.sources.col.detail'),
      nowrap: false,
      render: (s, index) => (
        <div className="space-y-0.5">
          <span className="text-foreground-muted">
            <SourceDetail source={s} roleLabel={roleLabel} />
          </span>
          {(issues.bySource.get(index) ?? []).map((issue) => (
            <p key={`${issue.field}:${issue.message}`} role="alert" className="text-xs text-danger">
              {issueText(issue, t)}
            </p>
          ))}
        </div>
      ),
    },
    {
      key: 'actions',
      header: t('remote.sources.col.actions'),
      align: 'right',
      render: (s, index) => (
        <div className="flex justify-end gap-0.5">
          <IconButton
            icon={ArrowUp}
            size="sm"
            variant="ghost"
            aria-label={t('remote.sources.moveUp')}
            disabled={index === 0}
            onClick={() => onChange((prev) => moveSource(prev, s.id, -1))}
          />
          <IconButton
            icon={ArrowDown}
            size="sm"
            variant="ghost"
            aria-label={t('remote.sources.moveDown')}
            disabled={index === last}
            onClick={() => onChange((prev) => moveSource(prev, s.id, 1))}
          />
          <IconButton
            icon={Pencil}
            size="sm"
            variant="ghost"
            aria-label={t('remote.sources.edit')}
            onClick={() => setEditing({ source: s })}
          />
          <IconButton
            icon={Trash2}
            size="sm"
            variant="ghost"
            aria-label={t('remote.sources.delete')}
            onClick={() => onChange((prev) => deleteSource(prev, s.id))}
          />
        </div>
      ),
    },
  ]

  return (
    <section className="space-y-3" data-testid="remote-sources">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-foreground">{t('remote.sources.title')}</h3>
          <p className="text-xs text-foreground-muted">{t('remote.sources.hint')}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => setEditing({ source: null })}
          data-testid="source-add"
        >
          <Plus className="mr-1 h-3 w-3" aria-hidden />
          {t('remote.sources.add')}
        </Button>
      </div>
      {config.sources.length === 0 ? (
        <EmptyState icon={ListVideo} title={t('remote.sources.empty')} />
      ) : (
        <DataTable columns={columns} rows={config.sources} rowKey={(s) => s.id} minWidthPx={320} />
      )}
      {(config.refusedSources ?? []).length > 0 && (
        <div role="alert" className="space-y-1" data-testid="remote-refused-sources">
          <p className="text-xs font-medium text-danger">{t('remote.sources.refusedTitle')}</p>
          {(config.refusedSources ?? []).map((refused) => (
            <p key={refused.index} className="text-xs text-foreground-muted">
              {t('remote.sources.refusedRow', {
                name: refused.name ?? refused.id ?? `#${refused.index + 1}`,
                reason: refused.reason,
              })}
            </p>
          ))}
        </div>
      )}
      <FormField
        label={t('remote.sources.stepDelay')}
        description={t('remote.sources.stepDelayHint')}
        error={
          issues.stepDelay === null
            ? undefined
            : t('remote.sources.error.stepDelay', {
                min: REMOTE_STEP_DELAY_MIN_MS,
                max: REMOTE_STEP_DELAY_MAX_MS,
              })
        }
      >
        <Input
          type="number"
          inputMode="numeric"
          className="w-32"
          value={Number.isNaN(config.stepDelayMs) ? '' : config.stepDelayMs}
          state={issues.stepDelay === null ? 'default' : 'error'}
          onChange={(e) => onChange((prev) => setStepDelay(prev, e.target.valueAsNumber))}
          data-testid="source-step-delay"
        />
      </FormField>
      {editing !== null && (
        <SourceDialog
          key={editing.source?.id ?? 'new'}
          config={config}
          source={editing.source}
          roleLabel={roleLabel}
          transmitters={transmitters}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            onChange(() => next)
            setEditing(null)
          }}
        />
      )}
    </section>
  )
}
