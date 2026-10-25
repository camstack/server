/**
 * Catalog — acquisition for CamStack / plugin catalog / plus catalog (same chrome).
 * Custom lives under Import; Installed is the inventory tab.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CHIP_ACTIVE,
  CHIP_BASE,
  CHIP_INACTIVE,
  SectionToolbar,
  Select,
  STACK_GAP,
  cn,
  type AddonPageProps,
  GroupedModelSelector,
} from '@camstack/ui-library'
import { buildModelVariantGroups, type ModelFormat, MODEL_FORMATS } from '@camstack/types'
import { downloadPipelineModel, listPipelineCatalog } from '../ui/api.js'
import {
  catalogFamilyCardTitle,
  catalogGroupedSeeds,
  catalogSeedAsVariantSource,
  catalogSeedsForStep,
  catalogStepOptions,
  catalogUngroupedSeeds,
  formatMB,
  type CatalogSeed,
} from '../ui/model-studio-ui.js'
import { NodeSelector } from '../components/NodeSelector.js'
import { Field } from '../components/Form.js'
import { useOperationModal } from '../components/OperationModalProvider.js'
import { PluginCatalogTab } from './PluginCatalogTab.js'
import { PlusCatalogSection } from './PlusCatalogSourceSections.js'
import { useT } from '../i18n/index.js'

export type CatalogSource = 'camstack' | 'scrypted' | 'frigate'

export function parseCatalogSource(raw: string | null): CatalogSource {
  if (raw === 'scrypted' || raw === 'frigate' || raw === 'camstack') return raw
  // Legacy ?source=custom belonged to Import — Catalog defaults to CamStack.
  return 'camstack'
}

const SOURCE_OPTIONS: readonly { value: CatalogSource; label: string }[] = [
  { value: 'camstack', label: 'CamStack' },
  { value: 'scrypted', label: 'plugin catalog' },
  { value: 'frigate', label: 'plus catalog' },
]

interface CatalogTabProps {
  readonly trpc: AddonPageProps['trpc']
  readonly refreshKey: number
  readonly source: CatalogSource
  readonly onSourceChange: (source: CatalogSource) => void
  readonly onRegistered?: () => void
  readonly onPrefillUpload?: (
    prefill: import('./PlusCatalogSourceSections.js').UploadPrefill,
  ) => void
}

const VALID_FORMATS = new Set<string>(MODEL_FORMATS)

function isModelFormat(value: string): value is ModelFormat {
  return VALID_FORMATS.has(value)
}

function FormatDownloadRow({
  seed,
  nodeId,
  busyKey,
  onDownload,
}: {
  readonly seed: CatalogSeed
  readonly nodeId: string
  readonly busyKey: string | null
  readonly onDownload: (seed: CatalogSeed, format: string) => void
}) {
  const { t } = useT()
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {seed.formats.map((fmt) => {
        const key = `${seed.stepId}/${seed.modelId}/${fmt.format}`
        return (
          <div
            key={fmt.format}
            className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-[11px]"
          >
            <span className="font-mono text-foreground">{fmt.format}</span>
            <span className="text-foreground-subtle">{formatMB(fmt.sizeMB)}</span>
            {fmt.downloaded ? (
              <span className="text-success">{t('catalog.onNode', { nodeId })}</span>
            ) : (
              <button // ui-check-ok: compact format download chip inside format row
                type="button"
                disabled={busyKey === key}
                onClick={() => onDownload(seed, fmt.format)}
                className="px-2 py-0.5 text-[10px] font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {busyKey === key ? t('catalog.downloading') : t('catalog.download')}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function CamStackCatalogSection({
  seeds,
  nodeId,
  busyKey,
  selectedByFamily,
  onSelectFamily,
  onDownload,
}: {
  readonly seeds: readonly CatalogSeed[]
  readonly nodeId: string
  readonly busyKey: string | null
  readonly selectedByFamily: Readonly<Record<string, string>>
  readonly onSelectFamily: (family: string, modelId: string) => void
  readonly onDownload: (seed: CatalogSeed, format: string) => void
}) {
  const groupedSeeds = catalogGroupedSeeds(seeds)
  const ungroupedSeeds = catalogUngroupedSeeds(seeds)
  const variantSources = groupedSeeds.map(catalogSeedAsVariantSource)
  const families = buildModelVariantGroups(variantSources)
  const seedById = new Map(seeds.map((s) => [s.modelId, s]))

  if (families.length === 0 && ungroupedSeeds.length === 0) return null

  return (
    <div className="space-y-3" data-testid="catalog-provider" data-provider="camstack">
      {families.map((family) => {
        const familyCatalog = variantSources.filter((s) => s.group?.family === family.family)
        const selectedId = selectedByFamily[family.family] ?? family.tiers[0]?.baseModelId ?? ''
        const selectedSeed = seedById.get(selectedId)
        return (
          <div
            key={family.family}
            data-testid="catalog-family"
            data-family={family.family}
            className="rounded-xl border border-border bg-surface px-3 py-3 space-y-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-foreground">
                {catalogFamilyCardTitle(family.family, family.label)}
              </span>
              <span className="text-[10px] font-mono text-foreground-subtle">{selectedId}</span>
            </div>
            <GroupedModelSelector
              catalog={familyCatalog}
              value={selectedId}
              onChange={(id) => onSelectFamily(family.family, id)}
            />
            {selectedSeed && (
              <FormatDownloadRow
                seed={selectedSeed}
                nodeId={nodeId}
                busyKey={busyKey}
                onDownload={onDownload}
              />
            )}
          </div>
        )
      })}

      {ungroupedSeeds.map((seed) => (
        <div
          key={`${seed.stepId}:${seed.modelId}`}
          data-testid="catalog-seed"
          className="rounded-xl border border-border bg-surface px-3 py-2.5 space-y-2"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-foreground">{seed.name}</span>
            <span className="text-[10px] font-mono text-foreground-subtle">{seed.modelId}</span>
          </div>
          <FormatDownloadRow
            seed={seed}
            nodeId={nodeId}
            busyKey={busyKey}
            onDownload={onDownload}
          />
        </div>
      ))}
    </div>
  )
}

function CamStackCatalog({
  trpc,
  refreshKey,
  nodeId,
}: {
  readonly trpc: AddonPageProps['trpc']
  readonly refreshKey: number
  readonly nodeId: string
}) {
  const { t } = useT()
  const [seeds, setSeeds] = useState<readonly CatalogSeed[]>([])
  const [stepId, setStepId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [opError, setOpError] = useState<string | null>(null)
  const [selectedByFamily, setSelectedByFamily] = useState<Readonly<Record<string, string>>>({})

  const load = useCallback(async () => {
    setError(null)
    try {
      const next = await listPipelineCatalog(trpc, nodeId)
      setSeeds(next)
      setStepId((prev) => {
        if (prev && next.some((s) => s.stepId === prev)) return prev
        return next[0]?.stepId ?? ''
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('catalog.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [trpc, nodeId, t])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load, refreshKey])

  const steps = useMemo(() => catalogStepOptions(seeds), [seeds])
  const visible = useMemo(() => {
    const forStep = catalogSeedsForStep(seeds, stepId)
    return forStep.filter((s) => s.provider === 'camstack')
  }, [seeds, stepId])
  const allFamilies = useMemo(() => {
    const sources = catalogGroupedSeeds(visible).map(catalogSeedAsVariantSource)
    return buildModelVariantGroups(sources)
  }, [visible])
  const seedById = useMemo(() => {
    const map = new Map<string, CatalogSeed>()
    for (const seed of visible) map.set(seed.modelId, seed)
    return map
  }, [visible])

  useEffect(() => {
    setSelectedByFamily((prev) => {
      const next: Record<string, string> = {}
      let changed = false
      for (const family of allFamilies) {
        const fallback = family.tiers[0]?.baseModelId ?? ''
        const current = prev[family.family]
        const keep =
          current !== undefined &&
          seedById.has(current) &&
          seedById.get(current)?.group?.family === family.family
            ? current
            : fallback
        next[family.family] = keep
        if (keep !== current) changed = true
      }
      if (!changed && Object.keys(prev).length === Object.keys(next).length) return prev
      return next
    })
  }, [allFamilies, seedById])

  const operations = useOperationModal()

  const handleDownload = useCallback(
    async (seed: CatalogSeed, format: string) => {
      if (!isModelFormat(format)) return
      const key = `${seed.stepId}/${seed.modelId}/${format}`
      setBusyKey(key)
      setOpError(null)
      try {
        await operations.run(
          {
            kind: 'download',
            title: t('catalog.opTitle', { modelId: seed.modelId, format }),
            modelId: seed.modelId,
            format,
            nodeId,
            steps: [
              {
                id: 'download',
                label: t('catalog.opStep', { format, nodeId }),
                status: 'active',
              },
            ],
            initialLog: t('catalog.opInitialLog', { modelId: seed.modelId, format, nodeId }),
          },
          async ({ appendLog, patchSteps }) => {
            await downloadPipelineModel(trpc, {
              addonId: seed.stepId,
              modelId: seed.modelId,
              format,
              nodeId,
            })
            patchSteps((prev) =>
              prev.map((s) => (s.id === 'download' ? { ...s, status: 'done' } : s)),
            )
            appendLog(t('catalog.opDone', { format, nodeId }))
          },
        )
        await load()
      } catch (err) {
        setOpError(err instanceof Error ? err.message : t('catalog.downloadFailed'))
      } finally {
        setBusyKey(null)
      }
    },
    [trpc, nodeId, load, operations, t],
  )

  if (loading) {
    return (
      <div className="text-sm text-foreground-subtle animate-pulse py-8 text-center">
        {t('catalog.loading')}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
      {opError && (
        <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {opError}
        </div>
      )}

      <Field label={t('common.step')}>
        <Select
          aria-label={t('common.step')}
          value={stepId}
          onChange={(e) => setStepId(e.target.value)}
          className="w-56 text-xs"
          options={
            steps.length === 0
              ? [{ value: '', label: t('catalog.noModels') }]
              : steps.map((step) => ({ value: step.id, label: step.name }))
          }
        />
      </Field>

      {visible.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface text-center text-xs text-foreground-subtle italic py-10">
          {t('catalog.noCamstackModels')}
        </div>
      ) : (
        <CamStackCatalogSection
          seeds={visible}
          nodeId={nodeId}
          busyKey={busyKey}
          selectedByFamily={selectedByFamily}
          onSelectFamily={(family, modelId) =>
            setSelectedByFamily((prev) => ({ ...prev, [family]: modelId }))
          }
          onDownload={(seed, format) => void handleDownload(seed, format)}
        />
      )}
    </div>
  )
}

export function CatalogTab({
  trpc,
  refreshKey,
  source,
  onSourceChange,
  onRegistered,
  onPrefillUpload,
}: CatalogTabProps) {
  const { t } = useT()
  const [nodeId, setNodeId] = useState('hub')

  return (
    <div className={STACK_GAP} data-testid="catalog-tab">
      <SectionToolbar
        testId="catalog-toolbar"
        className="sm:items-end"
        start={
          <div
            className="flex flex-wrap gap-1"
            data-testid="catalog-source"
            data-source={source}
            role="group"
            aria-label={t('catalog.sourceAria')}
          >
            {SOURCE_OPTIONS.map((o) => (
              <button // ui-check-ok: CHIP_* source pill (InstalledFilters pattern)
                key={o.value}
                type="button"
                aria-pressed={source === o.value}
                onClick={() => onSourceChange(o.value)}
                className={cn(CHIP_BASE, 'px-2', source === o.value ? CHIP_ACTIVE : CHIP_INACTIVE)}
              >
                {o.label}
              </button>
            ))}
          </div>
        }
        end={<NodeSelector selectedNodeId={nodeId} onSelect={setNodeId} />}
      />

      {source === 'camstack' && (
        <CamStackCatalog trpc={trpc} refreshKey={refreshKey} nodeId={nodeId} />
      )}
      {source === 'scrypted' && (
        <PluginCatalogTab trpc={trpc} landNodeId={nodeId} onImported={() => onRegistered?.()} />
      )}
      {source === 'frigate' && (
        <PlusCatalogSection
          trpc={trpc}
          landNodeId={nodeId}
          onRegistered={(message) => {
            onRegistered?.()
            void message
          }}
          onError={() => {}}
          onPrefillUpload={(prefill) => onPrefillUpload?.(prefill)}
        />
      )}
    </div>
  )
}
