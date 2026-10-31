/**
 * Installed — the model FILES on the selected node, one row per model ×
 * format, with the devices that use each file (`installed-inventory.ts`), and
 * the cluster-wide models with where each one runs on every node.
 *
 * "In use" = resident in a device's pool (`listLoadedEngines`); "configured"
 * = an enabled device's effective model with its file current on disk. Remove
 * is per format and offered only on idle / unused files.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BTN_COMPACT_DANGER,
  STACK_GAP,
  TEXT_HINT,
  useConfirm,
  useUrlQueryParam,
  type AddonPageProps,
  Button,
} from '@camstack/ui-library'
import type {
  ClusterStepModels,
  CustomModelDescriptor,
  ModelFormat,
  NodeInferenceDevice,
} from '@camstack/types'
import { MODEL_FORMATS } from '@camstack/types'
import {
  deletePipelineModel,
  listAvailability,
  listClusterStepModels,
  listCustomModels,
  listLoadedEngines,
  listNodeInferenceDevices,
  listPipelineCatalogBundle,
  removeModelFromNode,
  renameCustomModel,
  setAgentInferenceDevices,
  type LoadedEngine,
} from '../ui/api.js'
import { patchStepModelOnDevices } from '../ui/installed-activation.js'
import {
  buildInstalledInventory,
  deviceFilterOptions,
  devicesNoticeKind,
  filterInventoryRows,
  reclaimableMB,
  type InstalledDeviceChip,
  type InstalledFileRow,
} from '../ui/installed-inventory.js'
import {
  formatMB,
  type AvailabilityMap,
  type CatalogSeed,
  type StepCatalogSlice,
} from '../ui/model-studio-ui.js'
import { InstalledSettingsModal } from '../components/InstalledSettingsModal.js'
import { ClusterModelsSection } from '../components/installed/ClusterModelsSection.js'
import { InstalledFilesTable } from '../components/installed/InstalledFilesTable.js'
import {
  InstalledFilters,
  type InstalledProviderFilter,
} from '../components/installed/InstalledFilters.js'
import { useT } from '../i18n/index.js'

export type { InstalledProviderFilter } from '../components/installed/InstalledFilters.js'

export function parseInstalledProvider(raw: string | null): InstalledProviderFilter {
  if (raw === 'camstack' || raw === 'scrypted' || raw === 'frigate' || raw === 'custom') {
    return raw
  }
  return 'all'
}

/** `all`, or any non-empty value (a step id / a device key) kept verbatim. */
function parseAllOr(raw: string | null): string {
  if (raw === null || raw.length === 0 || raw === 'all') return 'all'
  return raw
}

export const parseInstalledType = parseAllOr
export const parseInstalledDevice = parseAllOr

export function parseInstalledNode(raw: string | null): string {
  if (raw === null || raw.length === 0) return 'hub'
  return raw
}

interface InstalledTabProps {
  readonly trpc: AddonPageProps['trpc']
  readonly refreshKey: number
}

interface NodeSnapshot {
  readonly models: readonly CustomModelDescriptor[]
  readonly availability: AvailabilityMap
  readonly seeds: readonly CatalogSeed[]
  readonly stepCatalogs: Readonly<Record<string, StepCatalogSlice>>
  readonly devices: readonly NodeInferenceDevice[]
  /** False when the device read failed: `devices` is then empty without saying the node has none. */
  readonly devicesAnswered: boolean
  readonly engines: readonly LoadedEngine[] | null
  readonly clusterModels: ClusterStepModels | null
}

interface SettingsTarget {
  readonly row: InstalledFileRow
  readonly deviceKey: string
}

function isModelFormat(value: string): value is ModelFormat {
  return MODEL_FORMATS.some((f) => f === value)
}

async function loadSnapshot(trpc: AddonPageProps['trpc'], nodeId: string): Promise<NodeSnapshot> {
  const [models, availability, catalog, devices, engines, clusterModels] = await Promise.all([
    listCustomModels(trpc),
    listAvailability(trpc),
    listPipelineCatalogBundle(trpc, nodeId),
    listNodeInferenceDevices(trpc, nodeId).catch(() => null),
    listLoadedEngines(trpc, nodeId).catch(() => null),
    listClusterStepModels(trpc).catch(() => null),
  ])
  return {
    models,
    availability,
    seeds: catalog.seeds,
    stepCatalogs: catalog.stepCatalogs,
    devices: devices ?? [],
    devicesAnswered: devices !== null,
    engines,
    clusterModels,
  }
}

function useUrlFilter(name: string, parse: (raw: string | null) => string, dflt: string) {
  const [raw, setRaw] = useUrlQueryParam(name)
  const set = useCallback((next: string) => setRaw(next === dflt ? null : next), [setRaw, dflt])
  return [parse(raw), set] as const
}

export function InstalledTab({ trpc, refreshKey }: InstalledTabProps) {
  const { t } = useT()
  const [providerParam, setProviderParam] = useUrlQueryParam('provider')
  const providerFilter = parseInstalledProvider(providerParam)
  const setProviderFilter = useCallback(
    (next: InstalledProviderFilter) => setProviderParam(next === 'all' ? null : next),
    [setProviderParam],
  )
  const [stepFilter, setStepFilter] = useUrlFilter('type', parseInstalledType, 'all')
  const [deviceFilter, setDeviceFilter] = useUrlFilter('device', parseInstalledDevice, 'all')
  const [nodeId, setNodeId] = useUrlFilter('node', parseInstalledNode, 'hub')

  const confirm = useConfirm()
  const [snapshot, setSnapshot] = useState<NodeSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setSnapshot(await loadSnapshot(trpc, nodeId))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('installed.loadFailed'))
    }
  }, [trpc, nodeId, t])

  useEffect(() => {
    setSnapshot(null)
    void load()
  }, [load, refreshKey])

  const reload = useCallback(async () => {
    await load()
    setReloads((n) => n + 1)
  }, [load])

  const rows = useMemo(
    () =>
      snapshot === null
        ? []
        : buildInstalledInventory({
            nodeId,
            seeds: snapshot.seeds,
            stepCatalogs: snapshot.stepCatalogs,
            devices: snapshot.devices,
            engines: snapshot.engines,
            clusterModels: snapshot.clusterModels,
            registry: snapshot.models,
            availability: snapshot.availability,
          }),
    [snapshot, nodeId],
  )
  const devices = snapshot?.devices ?? []
  const devicesNotice =
    snapshot === null ? null : devicesNoticeKind(snapshot.devices, snapshot.devicesAnswered)
  const filtered = useMemo(
    () =>
      filterInventoryRows(rows, devices, {
        provider: providerFilter,
        step: stepFilter,
        device: deviceFilter,
      }),
    [rows, devices, providerFilter, stepFilter, deviceFilter],
  )
  const stepOptions = useMemo(() => {
    const ids = new Set(rows.map((r) => r.stepId))
    if (stepFilter !== 'all') ids.add(stepFilter)
    return [...ids].toSorted((a, b) => a.localeCompare(b))
  }, [rows, stepFilter])

  const deleteInstalledFile = useCallback(
    async (row: InstalledFileRow): Promise<void> => {
      if (!row.removable || !isModelFormat(row.format)) return
      const target = { modelId: row.modelId, format: row.format, nodeId }
      if (row.origin === 'registry') await removeModelFromNode(trpc, target)
      else await deletePipelineModel(trpc, { ...target, addonId: row.stepId })
    },
    [nodeId, trpc],
  )

  const handleRemove = useCallback(
    async (row: InstalledFileRow) => {
      if (!row.removable || !isModelFormat(row.format)) return
      const ok = await confirm({
        title: t('installed.deleteFile.title'),
        message: t('installed.deleteFile.message', {
          format: row.format,
          name: row.name,
          modelId: row.modelId,
          size: formatMB(row.sizeMB),
          nodeId,
        }),
        confirmLabel: t('installed.deleteFile.confirm'),
        cancelLabel: t('common.cancel'),
        variant: 'danger',
      })
      if (!ok) return
      await deleteInstalledFile(row)
      await reload()
    },
    [confirm, deleteInstalledFile, nodeId, reload, t],
  )

  // Per-row Remove shows for idle OR unused; bulk must count the same set.
  const unusedRemovable = useMemo(() => filtered.filter((r) => r.removable), [filtered])

  const handleRemoveUnusedBulk = useCallback(async () => {
    if (unusedRemovable.length === 0) return
    const mb = unusedRemovable.reduce((sum, r) => sum + r.sizeMB, 0)
    const ok = await confirm({
      title: t('installed.deleteUnused.title'),
      message: t('installed.deleteUnused.message', {
        count: unusedRemovable.length,
        size: formatMB(mb),
        nodeId,
      }),
      confirmLabel: t('installed.deleteUnused.confirm'),
      cancelLabel: t('common.cancel'),
      variant: 'danger',
    })
    if (!ok) return
    for (const row of unusedRemovable) {
      await deleteInstalledFile(row)
    }
    await reload()
  }, [confirm, deleteInstalledFile, nodeId, reload, unusedRemovable, t])

  const handleRename = useCallback(
    async (row: InstalledFileRow, name: string) => {
      await renameCustomModel(trpc, { modelId: row.modelId, name })
      await reload()
    },
    [trpc, reload],
  )

  const handleChip = useCallback(
    async (row: InstalledFileRow, chip: InstalledDeviceChip) => {
      if (chip.configured) {
        setSettingsTarget({ row, deviceKey: chip.deviceKey })
        return
      }
      const ok = await confirm({
        title: t('installed.activate.title'),
        message: t('installed.activate.message', {
          name: row.name,
          label: chip.label,
          deviceKey: chip.deviceKey,
          nodeId,
        }),
        confirmLabel: t('common.activate'),
        cancelLabel: t('common.cancel'),
        variant: 'default',
      })
      if (!ok) return
      await setAgentInferenceDevices(trpc, {
        agentNodeId: nodeId,
        inferenceDevices: patchStepModelOnDevices(devices, row.stepId, row.modelId, [
          chip.deviceKey,
        ]),
      })
      await reload()
    },
    [confirm, nodeId, trpc, devices, reload, t],
  )

  const totalMB = rows.reduce((sum, r) => sum + r.sizeMB, 0)
  const filtersActive = providerFilter !== 'all' || stepFilter !== 'all' || deviceFilter !== 'all'

  return (
    <div className={STACK_GAP} data-testid="installed-tab">
      {error && (
        <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
      <InstalledFilters
        provider={providerFilter}
        onProvider={setProviderFilter}
        step={stepFilter}
        stepOptions={stepOptions}
        onStep={setStepFilter}
        device={deviceFilter}
        deviceOptions={deviceFilterOptions(devices)}
        onDevice={setDeviceFilter}
        nodeId={nodeId}
        onNode={setNodeId}
      />
      {snapshot === null && error === null ? (
        <p className="animate-pulse py-8 text-center text-xs text-foreground-subtle">
          {t('installed.loading')}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className={TEXT_HINT} data-testid="installed-summary">
              {t('installed.summary.files', { count: filtered.length, nodeId })}
              {filtersActive ? ` ${t('installed.summary.ofTotal', { total: rows.length })}` : ''} ·{' '}
              {t('installed.summary.onDisk', { size: formatMB(totalMB) })} ·{' '}
              {t('installed.summary.reclaimable', {
                size: formatMB(reclaimableMB(rows)),
              })}
              {snapshot?.engines === null ? ` · ${t('installed.summary.loadedUnavailable')}` : ''}
            </p>
            {unusedRemovable.length > 0 && (
              <Button
                variant="unstyled"
                type="button"
                className={BTN_COMPACT_DANGER}
                data-testid="installed-remove-unused-bulk"
                onClick={() => void handleRemoveUnusedBulk()}
              >
                {t('installed.removeUnused', { count: unusedRemovable.length })}
              </Button>
            )}
          </div>
          {devicesNotice !== null && (
            <p
              role="status"
              className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
              data-testid="installed-devices-notice"
              data-kind={devicesNotice}
            >
              {t(
                `installed.devicesNotice.${devicesNotice === 'all-disabled' ? 'allDisabled' : devicesNotice}`,
              )}
            </p>
          )}
          <InstalledFilesTable
            rows={filtered}
            emptyMessage={
              rows.length === 0
                ? t('installed.emptyNode', { nodeId })
                : t('installed.emptyFiltered')
            }
            onRemove={handleRemove}
            onRename={handleRename}
            onChip={handleChip}
            onError={setError}
          />
          <ClusterModelsSection
            trpc={trpc}
            refreshKey={refreshKey + reloads}
            clusterModels={snapshot?.clusterModels ?? null}
            onChanged={() => void reload()}
            onError={setError}
          />
        </>
      )}
      {settingsTarget && (
        <InstalledSettingsModal
          trpc={trpc}
          nodeId={nodeId}
          stepId={settingsTarget.row.stepId}
          modelId={settingsTarget.row.modelId}
          modelName={settingsTarget.row.name}
          devices={devices}
          deviceKey={settingsTarget.deviceKey}
          onClose={() => setSettingsTarget(null)}
          onDone={() => void reload()}
        />
      )}
    </div>
  )
}
