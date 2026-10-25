/**
 * 6. Result — baseline vs candidate (and INT8) on the held-out frames, the
 * proposed floors, and the operator's actions: Register, Register + Canary,
 * Discard, Rollback. Nothing here happens without a click.
 *
 * A canary pins the model on chosen ACCELERATORS: a model is chosen by the
 * accelerator that runs it (D927), and every camera balanced onto one runs it.
 */
import { useState } from 'react'
import type { TrainingAcceleratorRef, TrainingJob, TrainingResult } from '@camstack/types'
import { Badge, Button, Checkbox, useConfirm, type AddonPageProps } from '@camstack/ui-library'
import { Trans, useT, type TFn } from '../i18n/index.js'
import { ComparisonTable } from './ComparisonTable.js'
import { errorText, useAsync } from './use-async.js'
import { formatBytes } from './view-model.js'

export interface ResultPanelProps {
  readonly job: TrainingJob
  readonly trpc: AddonPageProps['trpc']
  readonly onChanged: () => void
  readonly cameraName: (id: number) => string
}

function acceleratorKey(a: TrainingAcceleratorRef): string {
  return `${a.nodeId}|${a.deviceKey}`
}

function acceleratorName(a: TrainingAcceleratorRef): string {
  return `${a.nodeId} · ${a.deviceKey}`
}

function floorList(floors: Readonly<Record<string, number>>): string {
  return Object.entries(floors)
    .map(([c, f]) => `${c} ${f.toFixed(2)}`)
    .join(', ')
}

/** The INT8 verdict, its reason, and the exports that were dropped. */
function int8Text(t: TFn, r: TrainingResult): string {
  if (r.int8 === undefined) return ''
  const { kept, reason } = r.int8
  const verdict =
    reason === null
      ? t(kept ? 'result.int8Kept' : 'result.int8Dropped')
      : t(kept ? 'result.int8KeptReason' : 'result.int8DroppedReason', { reason })
  const dropped = r.exportsDropped ?? []
  if (dropped.length === 0) return verdict
  const list = dropped.map((d) => `${d.export} (${d.reason})`).join(', ')
  return `${verdict} · ${t('result.notExported', { list })}`
}

export function ResultPanel({ job, trpc, onChanged, cameraName }: ResultPanelProps) {
  const { t, lang } = useT()
  const confirm = useConfirm()
  const result = useAsync(
    () => trpc.training.getJobResult.query({ id: job.id }),
    [job.id, job.state],
  )
  const targets = useAsync(() => trpc.training.listCanaryTargets.query(), [])
  const [picked, setPicked] = useState<readonly TrainingAcceleratorRef[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const act = async (body: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await body()
      onChanged()
    } catch (err: unknown) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const register = (canary: readonly TrainingAcceleratorRef[]) =>
    act(() => trpc.training.registerResult.mutate({ id: job.id, canaryAccelerators: [...canary] }))
  const canary = () =>
    act(() => trpc.training.canaryResult.mutate({ id: job.id, accelerators: [...picked] }))
  const isPicked = (a: TrainingAcceleratorRef): boolean =>
    picked.some((p) => acceleratorKey(p) === acceleratorKey(a))
  const discard = async () => {
    const ok = await confirm({
      title: t('result.discardConfirm.title'),
      message: t('result.discardConfirm.message'),
      confirmLabel: t('result.discardConfirm.confirm'),
      variant: 'danger',
    })
    if (ok) await act(() => trpc.training.discardResult.mutate({ id: job.id }))
  }
  const rollback = async () => {
    const ok = await confirm({
      title: t('result.rollbackConfirm.title'),
      message: t('result.rollbackConfirm.message'),
      confirmLabel: t('result.rollbackConfirm.confirm'),
    })
    if (ok) await act(() => trpc.training.rollbackCanary.mutate({ id: job.id }))
  }

  if (result.state.status === 'pending')
    return <p className="text-sm text-foreground-subtle">{t('result.loading')}</p>
  if (result.state.status === 'error')
    return (
      <p className="text-sm text-danger">
        {t('result.couldNotLoad')} {result.state.error}
      </p>
    )
  const r = result.state.data
  if (r === null) return <p className="text-sm text-foreground-muted">{t('result.gone')}</p>
  const files = r.files ?? []
  return (
    <div className="space-y-3 border-t border-border pt-3" data-testid="result-panel">
      <ComparisonTable result={r} cameraName={cameraName} />
      {r.floors !== undefined && (
        <p className="text-xs text-foreground-muted">
          {r.floors.notes.length > 0
            ? t('result.floorsWithNotes', {
                floors: floorList(r.floors.candidate),
                notes: r.floors.notes.join('; '),
              })
            : t('result.floors', { floors: floorList(r.floors.candidate) })}
        </p>
      )}
      {r.int8 !== undefined && <p className="text-xs text-foreground-muted">{int8Text(t, r)}</p>}
      {files.length > 0 && (
        <p className="text-xs text-foreground-subtle">
          {t('result.files', {
            count: files.length,
            size: formatBytes(files.reduce((s, f) => s + f.bytes, 0)),
            licence: r.licence,
          })}
        </p>
      )}
      {job.canary !== null && (
        <p className="text-sm text-foreground">
          <Trans
            i18nKey="result.canarySince"
            values={{
              accelerators: job.canary.accelerators.map(acceleratorName).join(', '),
              since: new Date(job.canary.since).toLocaleString(lang),
            }}
            components={{ badge: <Badge variant="success" /> }}
          />
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {job.state === 'ready' && (
          <>
            <Button size="md" disabled={busy} onClick={() => void register([])}>
              {t('result.register')}
            </Button>
            <Button
              size="md"
              variant="secondary"
              disabled={busy || picked.length === 0}
              onClick={() => void register(picked)}
            >
              {t('result.registerCanary', { count: picked.length })}
            </Button>
            <Button size="md" variant="outline" disabled={busy} onClick={() => void discard()}>
              {t('result.discard')}
            </Button>
          </>
        )}
        {(job.state === 'registered' || job.state === 'canary') && (
          <Button
            size="md"
            variant="secondary"
            disabled={busy || picked.length === 0}
            onClick={() => void canary()}
          >
            {t('result.canaryOn', { count: picked.length })}
          </Button>
        )}
        {job.state === 'canary' && (
          <Button size="md" variant="outline" disabled={busy} onClick={() => void rollback()}>
            {t('result.rollback')}
          </Button>
        )}
      </div>
      <fieldset className="space-y-1">
        <legend className="text-xs text-foreground-muted">{t('result.canaryAccelerators')}</legend>
        {targets.state.status === 'pending' && (
          <span className="text-xs text-foreground-subtle">{t('result.loadingAccelerators')}</span>
        )}
        {targets.state.status === 'error' && (
          <span className="text-xs text-danger">{targets.state.error}</span>
        )}
        {targets.state.status === 'ok' && (
          <div className="flex flex-wrap gap-3">
            {targets.state.data.map((a) => (
              <label
                key={acceleratorKey(a)}
                className="flex items-center gap-1 text-xs text-foreground-muted"
              >
                <Checkbox
                  checked={isPicked(a)}
                  onChange={(e) =>
                    setPicked(
                      e.target.checked
                        ? [...picked, { nodeId: a.nodeId, deviceKey: a.deviceKey }]
                        : picked.filter((p) => acceleratorKey(p) !== acceleratorKey(a)),
                    )
                  }
                />
                {acceleratorName(a)}
                {a.pinnedModelId !== null && (
                  <span className="font-mono text-foreground-subtle">({a.pinnedModelId})</span>
                )}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      {error !== null && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
