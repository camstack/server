/**
 * The Exporters tab of an action: one switch per export instance that can
 * expose actions (Alexa scenes, a Home Assistant button, …). What an exporter
 * can expose is ASKED of it (`listSupportedEntityKinds`); an instance that does
 * not answer, or does not take actions, shows nothing — never a switch that
 * cannot work. An exposed action shows the name the exporter publishes it as.
 * The switches edit one draft for the whole tab: Save exposes / unexposes every
 * changed instance, Discard drops the picks (planning#675). The panel is mounted only while its tab is open, so none of these queries
 * runs at modal open.
 */
import {
  FormSaveBar,
  Skeleton,
  Switch,
  useDeviceExportExposeEntity,
  useDeviceExportListExposedEntities,
  useDeviceExportListSupportedEntityKinds,
  useDeviceExportUnexposeEntity,
  useInstancesOfCap,
  type LinkableInstance,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

const KindsSchema = z.array(z.string())
const ExposedSchema = z.array(
  z.object({
    entity: z.object({ kind: z.string(), actionId: z.string().optional() }),
    exposedAs: z.string().optional(),
  }),
)

/** Reports the write one row needs (absent: nothing to write) to the tab's Save bar. */
type ReportWrite = (key: string, write: (() => Promise<unknown>) | undefined) => void

function ActionExporterRow({
  instance,
  actionId,
  report,
}: {
  readonly instance: LinkableInstance
  readonly actionId: string
  readonly report: ReportWrite
}): ReactNode {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const kinds = useDeviceExportListSupportedEntityKinds(
    { nodeId: 'hub', addonId: instance.addonId },
    { retry: false },
  )
  const accepts = KindsSchema.safeParse(kinds.data).data?.includes('action') === true
  const exposed = useDeviceExportListExposedEntities(
    { nodeId: 'hub', addonId: instance.addonId, instanceId: instance.id },
    { retry: false, enabled: accepts },
  )
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: [['deviceExport']] })
  }
  const expose = useDeviceExportExposeEntity({ onSuccess: invalidate })
  const unexpose = useDeviceExportUnexposeEntity({ onSuccess: invalidate })
  const [pick, setPick] = useState<boolean | null>(null)
  const rowKey = `${instance.addonId}:${instance.id}`
  const parsedExposed = ExposedSchema.safeParse(exposed.data)
  const servedOn =
    parsedExposed.success &&
    parsedExposed.data.some((e) => e.entity.kind === 'action' && e.entity.actionId === actionId)
  const dirty = pick !== null && pick !== servedOn
  const target = {
    nodeId: 'hub',
    addonId: instance.addonId,
    instanceId: instance.id,
    entity: { kind: 'action' as const, actionId },
  }
  const latest = useRef({ expose, unexpose, target })
  latest.current = { expose, unexpose, target }
  useEffect(() => {
    if (!dirty) {
      report(rowKey, undefined)
      return
    }
    report(rowKey, () =>
      pick === true
        ? latest.current.expose.mutateAsync(latest.current.target)
        : latest.current.unexpose.mutateAsync(latest.current.target),
    )
    return () => report(rowKey, undefined)
  }, [dirty, pick, rowKey, report])
  if (!accepts) return null
  const parsed = ExposedSchema.safeParse(exposed.data)
  // Unanswered stays off the screen: not-yet-known must not read as "not exposed".
  if (!parsed.success) return null
  const mine = parsed.data.find((e) => e.entity.kind === 'action' && e.entity.actionId === actionId)
  const on = pick ?? mine !== undefined
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="min-w-0">
        <span className="block truncate">{instance.name}</span>
        {mine?.exposedAs !== undefined && (
          <span
            className="block truncate text-xs text-foreground-muted"
            data-testid="exporter-exposed-as"
          >
            {t('build.quickModal.exposedAs', 'Exported as {{name}}', {
              name: mine.exposedAs,
            })}
          </span>
        )}
      </span>
      <Switch
        checked={on}
        disabled={expose.isPending || unexpose.isPending}
        aria-label={t('build.quickModal.exportAction', 'Expose to {{name}}', {
          name: instance.name,
        })}
        onCheckedChange={setPick}
      />
    </label>
  )
}

export function ActionExporters({ actionId }: { readonly actionId: string }): ReactNode {
  const { t } = useTranslation()
  const instances = useInstancesOfCap({ functionCap: 'device-export' })
  const [writes, setWrites] = useState<Readonly<Record<string, () => Promise<unknown>>>>({})
  /** Bumped by Save / Discard: the rows remount and drop their picks. */
  const [epoch, setEpoch] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const report = useCallback<ReportWrite>((key, write) => {
    setWrites((prev) => {
      if (write === undefined) {
        if (!(key in prev)) return prev
        const { [key]: _gone, ...rest } = prev
        return rest
      }
      return { ...prev, [key]: write }
    })
  }, [])
  const save = (): void => {
    setSaving(true)
    setSaveError(null)
    void Promise.all(Object.values(writes).map((write) => write()))
      .then(() => setEpoch((n) => n + 1))
      .catch((err: unknown) => setSaveError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false))
  }
  if (instances.isLoading) return <Skeleton className="h-10 w-full" />
  const usable = (instances.data ?? []).filter((i) => i.usable)
  if (usable.length === 0) {
    return (
      <p className="text-xs text-foreground-subtle">
        {t('build.quickModal.noExporters', 'No exporter is set up.')}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      {usable.map((instance) => (
        <ActionExporterRow
          key={`${instance.addonId}:${instance.id}:${epoch}`}
          instance={instance}
          actionId={actionId}
          report={report}
        />
      ))}
      {saveError !== null && (
        <p role="alert" className="text-xs text-danger">
          {saveError}
        </p>
      )}
      <FormSaveBar
        pendingCount={Object.keys(writes).length}
        saving={saving}
        onSave={save}
        onDiscard={() => {
          setSaveError(null)
          setEpoch((n) => n + 1)
        }}
      />
    </div>
  )
}
