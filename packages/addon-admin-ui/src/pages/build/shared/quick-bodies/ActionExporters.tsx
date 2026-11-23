/**
 * The Exporters tab of an action: one switch per export instance that can
 * expose actions (Alexa scenes, a Home Assistant button, …). What an exporter
 * can expose is ASKED of it (`listSupportedEntityKinds`); an instance that does
 * not answer, or does not take actions, shows nothing — never a switch that
 * cannot work. An exposed action shows the name the exporter publishes it as.
 * The panel is mounted only while its tab is open, so none of these queries
 * runs at modal open.
 */
import {
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
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

const KindsSchema = z.array(z.string())
const ExposedSchema = z.array(
  z.object({
    entity: z.object({ kind: z.string(), actionId: z.string().optional() }),
    exposedAs: z.string().optional(),
  }),
)

function ActionExporterRow({
  instance,
  actionId,
}: {
  readonly instance: LinkableInstance
  readonly actionId: string
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
  if (!accepts) return null
  const parsed = ExposedSchema.safeParse(exposed.data)
  // Unanswered stays off the screen: not-yet-known must not read as "not exposed".
  if (!parsed.success) return null
  const mine = parsed.data.find((e) => e.entity.kind === 'action' && e.entity.actionId === actionId)
  const on = mine !== undefined
  const target = {
    nodeId: 'hub',
    addonId: instance.addonId,
    instanceId: instance.id,
    entity: { kind: 'action' as const, actionId },
  }
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
        onCheckedChange={(next) => (next ? expose.mutate(target) : unexpose.mutate(target))}
      />
    </label>
  )
}

export function ActionExporters({ actionId }: { readonly actionId: string }): ReactNode {
  const { t } = useTranslation()
  const instances = useInstancesOfCap({ functionCap: 'device-export' })
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
          key={`${instance.addonId}:${instance.id}`}
          instance={instance}
          actionId={actionId}
        />
      ))}
    </div>
  )
}
