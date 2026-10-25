/**
 * plugin catalog Sources — Catalog-style family card + Variant pre-selector.
 *
 * Same YOLOv9 family as the pipeline picker: Standard/Test trainings, size
 * chips, formats ONNX / OpenVINO / CoreML / TFLite on one registry id per chip.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AddonPageProps } from '@camstack/ui-library'
import type { ModelFormat } from '@camstack/types'
import {
  ensureModelFormats,
  importPluginCatalogCatalogModel,
  listAvailability,
  listCustomModels,
  listPluginCatalogCatalog,
  tfliteSupportNodes,
  type PluginCatalogCatalogDriftView,
  type PluginCatalogCatalogEntryView,
} from '../ui/api.js'
import { entryFormats, nodePresence } from '../ui/model-studio-ui.js'
import {
  pluginCatalogDriftOf,
  type PluginCatalogFormat,
} from '../plugin-catalog/plugin-catalog-catalog-selectors.js'
import {
  pluginCatalogEntriesAsVariantSources,
  pluginCatalogVariantSourceId,
} from '../plugin-catalog/plugin-catalog-as-variant-sources.js'
import { pluginCatalogManifestIdForFormat } from '../plugin-catalog/plugin-catalog-canonical.js'
import { SourceModelBrowser } from '../components/SourceModelBrowser.js'
import { FormatImportRow, type FormatRowEntry } from '../components/FormatImportRow.js'
import { useOperationModal } from '../components/OperationModalProvider.js'
import {
  DisplayNameField,
  importNameOf,
  isDisplayNameInvalid,
} from '../components/DisplayNameField.js'
import { Trans, useT } from '../i18n/index.js'

interface PluginCatalogTabProps {
  readonly trpc: AddonPageProps['trpc']
  /** Catalog NodeSelector — land imports on this node when set. */
  readonly landNodeId?: string
  readonly onImported?: () => void
}

type PluginCatalogVariant = 'relu' | 'relu_test'

const FORMAT_ORDER: readonly PluginCatalogFormat[] = ['onnx', 'openvino', 'coreml', 'tflite']

const VARIANT_OPTIONS = [
  { value: 'relu', key: 'standard' },
  { value: 'relu_test', key: 'test' },
] as const

export function PluginCatalogTab({ trpc, landNodeId, onImported }: PluginCatalogTabProps) {
  const { t } = useT()
  const operations = useOperationModal()
  const [entries, setEntries] = useState<readonly PluginCatalogCatalogEntryView[] | null>(null)
  const [drift, setDrift] = useState<readonly PluginCatalogCatalogDriftView[]>([])
  const [registeredIds, setRegisteredIds] = useState<ReadonlySet<string> | null>(null)
  const [registryFormats, setRegistryFormats] = useState<
    Readonly<Record<string, readonly ModelFormat[]>>
  >({})
  const [presenceByModel, setPresenceByModel] = useState<
    Readonly<Record<string, ReturnType<typeof nodePresence>>>
  >({})
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [variant, setVariant] = useState<PluginCatalogVariant>('relu')
  const [selectedId, setSelectedId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [tfliteNodes, setTfliteNodes] = useState<readonly string[] | null>(null)
  const [landNode, setLandNode] = useState('')
  const loadGeneration = useRef(0)
  const importInFlight = useRef(false)

  const effectiveLand =
    landNodeId !== undefined && landNodeId.length > 0
      ? landNodeId
      : landNode.length > 0
        ? landNode
        : undefined

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    setError(null)
    try {
      const catalogP = listPluginCatalogCatalog(trpc)
      const registryP = listCustomModels(trpc).then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      )
      const availP = listAvailability(trpc).then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      )
      const coralP = tfliteSupportNodes(trpc).then(
        (v) => v,
        () => [] as readonly string[],
      )
      const [catalog, registry, avail, coral] = await Promise.all([
        catalogP,
        registryP,
        availP,
        coralP,
      ])
      if (generation !== loadGeneration.current) return
      setEntries(catalog.entries)
      setDrift(catalog.drift)
      setTfliteNodes(coral)
      if (coral.length > 0) {
        setLandNode((prev) => (prev.length > 0 && coral.includes(prev) ? prev : coral[0]!))
      }
      if (registry.ok) {
        setRegisteredIds(new Set(registry.value.map((m) => m.entry.id)))
        const formats: Record<string, readonly ModelFormat[]> = {}
        for (const m of registry.value) {
          formats[m.entry.id] = entryFormats(m.entry)
        }
        setRegistryFormats(formats)
      } else {
        setRegisteredIds(null)
        setRegistryFormats({})
      }
      if (avail.ok && registry.ok) {
        const map: Record<string, ReturnType<typeof nodePresence>> = {}
        for (const m of registry.value) {
          map[m.entry.id] = nodePresence(avail.value, m.entry.id)
        }
        setPresenceByModel(map)
      } else {
        setPresenceByModel({})
      }
    } catch (err) {
      if (generation !== loadGeneration.current) return
      setEntries(null)
      setError(err instanceof Error ? err.message : t('pluginCatalog.loadFailed'))
    }
  }, [trpc, t])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(
    () => (entries ?? []).filter((e) => e.variant === variant),
    [entries, variant],
  )
  const sources = useMemo(() => pluginCatalogEntriesAsVariantSources(filtered), [filtered])
  const sourceById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources])
  const effectiveSelectedId =
    selectedId.length > 0 && sourceById.has(selectedId) ? selectedId : (sources[0]?.id ?? '')

  const handleImport = useCallback(
    async (slot: FormatSlot) => {
      if (importInFlight.current || isDisplayNameInvalid(displayName)) return
      const operatorName = importNameOf(displayName)
      importInFlight.current = true
      setBusyId(slot.id)
      setImportError(null)
      const land =
        slot.format === 'tflite'
          ? effectiveLand
          : landNodeId !== undefined && landNodeId.length > 0
            ? landNodeId
            : undefined
      try {
        await operations.run(
          {
            kind: slot.mode === 'convert' ? 'convert' : 'import',
            title: t('importOp.title', { modelId: slot.canonicalId, format: slot.format }),
            modelId: slot.canonicalId,
            format: slot.format,
            ...(land !== undefined ? { nodeId: land } : {}),
            steps: [
              {
                id: 'import',
                label: t('importOp.step', { format: slot.format }),
                status: 'active',
              },
              ...(land !== undefined
                ? [
                    {
                      id: 'land',
                      label: t('importOp.landStep', { nodeId: land }),
                      status: 'pending' as const,
                    },
                  ]
                : []),
            ],
            initialLog: t('importOp.start', { format: slot.format, modelId: slot.canonicalId }),
          },
          async ({ appendLog, patchSteps }) => {
            if (slot.mode === 'native') {
              await importPluginCatalogCatalogModel(trpc, {
                manifestId: slot.manifestId,
                ...(operatorName !== undefined ? { name: operatorName } : {}),
                ...(land !== undefined ? { targetNodeId: land } : {}),
              })
              appendLog(
                land !== undefined
                  ? t('importOp.landed', { nodeId: land })
                  : t('importOp.intoRegistry', { format: slot.format }),
              )
            } else {
              const onnxRegistered = registeredIds?.has(slot.canonicalId) === true
              const hasOnnx = (registryFormats[slot.canonicalId] ?? []).includes('onnx')
              if (!onnxRegistered || !hasOnnx) {
                appendLog(t('pluginCatalog.onnxFirst'))
                await importPluginCatalogCatalogModel(trpc, {
                  manifestId: slot.onnxManifestId,
                  ...(operatorName !== undefined ? { name: operatorName } : {}),
                  ...(land !== undefined ? { targetNodeId: land } : {}),
                })
              }
              appendLog(t('pluginCatalog.converting', { format: slot.format }))
              await ensureModelFormats(trpc, slot.canonicalId, [slot.format])
              appendLog(t('pluginCatalog.converted', { format: slot.format }))
            }
            patchSteps((prev) =>
              prev.map((s) =>
                s.status === 'active' || s.status === 'pending' ? { ...s, status: 'done' } : s,
              ),
            )
          },
        )
        await load()
        onImported?.()
      } catch (err) {
        setImportError(err instanceof Error ? err.message : t('importOp.failed'))
      } finally {
        importInFlight.current = false
        setBusyId(null)
      }
    },
    [
      trpc,
      load,
      onImported,
      registeredIds,
      registryFormats,
      effectiveLand,
      landNodeId,
      operations,
      displayName,
      t,
    ],
  )

  if (entries === null && error === null) {
    return (
      <div
        data-testid="plugin-catalog-tab"
        className="text-sm text-foreground-subtle animate-pulse py-8 text-center"
      >
        {t('pluginCatalog.loading')}
      </div>
    )
  }

  if (error) {
    return (
      <div data-testid="plugin-catalog-tab" className="space-y-2">
        <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="px-3 py-1.5 text-[10px] font-medium rounded-md border border-border text-foreground-subtle hover:text-foreground"
        >
          {t('common.retry')}
        </button>
      </div>
    )
  }

  const selected = sourceById.get(effectiveSelectedId)
  const slots =
    selected && entries
      ? buildFormatSlots({
          filtered,
          drift,
          sourceId: selected.id,
        })
      : []

  const formatEntries: FormatRowEntry[] = slots.map((s) => ({
    id: s.id,
    format: s.format,
    ...(s.sizeMB !== undefined ? { sizeMB: s.sizeMB } : {}),
    driftStatus: s.driftStatus,
  }))

  const presence = selected ? (presenceByModel[selected.id] ?? []) : []

  return (
    <div data-testid="plugin-catalog-tab" className="space-y-4">
      {importError && (
        <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {importError}
        </div>
      )}
      <p className="text-[11px] text-foreground-subtle">{t('pluginCatalog.intro')}</p>
      {landNodeId === undefined && tfliteNodes !== null && tfliteNodes.length > 0 && (
        <label className="flex items-center gap-2 text-[11px] text-foreground">
          <span className="text-foreground-subtle uppercase tracking-wide text-[10px]">
            {t('pluginCatalog.tfliteCoral')}
          </span>
          <select
            className="bg-surface border border-border rounded px-2 py-0.5 text-[11px]"
            value={landNode}
            onChange={(e) => setLandNode(e.target.value)}
          >
            {tfliteNodes.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}
      {landNodeId === undefined && tfliteNodes !== null && tfliteNodes.length === 0 && (
        <p className="text-[11px] text-warning">{t('pluginCatalog.noCoral')}</p>
      )}
      {landNodeId !== undefined && (
        <p className="text-[10px] text-foreground-subtle">
          <Trans
            i18nKey="pluginCatalog.landOn"
            values={{ nodeId: landNodeId }}
            components={{ mono: <span className="font-mono" /> }}
          />
        </p>
      )}

      <SourceModelBrowser
        testId="plugin-catalog-browser"
        title="YOLOv9"
        preSelectors={[
          {
            id: 'variant',
            label: t('pluginCatalog.variant'),
            value: variant,
            options: VARIANT_OPTIONS.map((o) => ({
              value: o.value,
              label: t(`pluginCatalog.variants.${o.key}`),
              count: (entries ?? []).filter((e) => e.variant === o.value).length,
            })),
            onChange: (v) => {
              if (v === 'relu' || v === 'relu_test') {
                setVariant(v)
                setSelectedId('')
              }
            },
            compactWhenSingle: false,
          },
        ]}
        catalog={sources}
        value={effectiveSelectedId}
        onChange={setSelectedId}
        emptyMessage={t('pluginCatalog.emptyVariant')}
        actionRow={
          selected && formatEntries.length > 0 ? (
            <div className="space-y-2">
              <DisplayNameField
                value={displayName}
                onChange={setDisplayName}
                defaultName={selected.name}
              />
              <FormatImportRow
                entries={formatEntries}
                registeredIds={registeredIds}
                isImported={(e) => {
                  const slot = slots.find((s) => s.id === e.id)
                  if (!slot) return false
                  return (registryFormats[slot.canonicalId] ?? []).includes(slot.format)
                }}
                presence={presence}
                busyId={busyId}
                onImport={(id) => {
                  const slot = slots.find((s) => s.id === id)
                  if (slot) void handleImport(slot)
                }}
              />
            </div>
          ) : null
        }
      />
    </div>
  )
}

interface FormatSlotBase {
  readonly id: string
  readonly manifestId: string
  readonly canonicalId: string
  readonly onnxManifestId: string
  readonly sizeMB?: number
  /** `undefined` = no drift row for the manifest: unknown, which blocks import. */
  readonly driftStatus: string | undefined
}

/** A build the plugin catalog catalog ships for this format. */
interface NativeFormatSlot extends FormatSlotBase {
  readonly mode: 'native'
  readonly format: ModelFormat
}

/** A format produced by converting the ONNX build (`ensureModelFormats`). */
interface ConvertFormatSlot extends FormatSlotBase {
  readonly mode: 'convert'
  readonly format: 'openvino' | 'coreml'
}

type FormatSlot = NativeFormatSlot | ConvertFormatSlot

const TFLITE_PRECISION_RANK: readonly string[] = [
  'edgetpu',
  'int8',
  'full_integer_quant',
  'integer_quant',
  'float16',
  'float32',
]

function pickNativeForFormat(
  chip: readonly PluginCatalogCatalogEntryView[],
  format: ModelFormat,
  canonicalId: string,
): PluginCatalogCatalogEntryView | undefined {
  const natives = chip.filter((e) => e.format === format)
  if (natives.length === 0) return undefined
  if (format === 'tflite') {
    const preferredId = pluginCatalogManifestIdForFormat(canonicalId, 'tflite')
    const preferred =
      preferredId !== undefined ? natives.find((e) => e.id === preferredId) : undefined
    if (preferred) return preferred
    return natives.toSorted((a, b) => {
      const ia = TFLITE_PRECISION_RANK.indexOf(a.precision.toLowerCase())
      const ib = TFLITE_PRECISION_RANK.indexOf(b.precision.toLowerCase())
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    })[0]
  }
  return natives.toSorted(
    (a, b) => a.files.reduce((s, f) => s + f.size, 0) - b.files.reduce((s, f) => s + f.size, 0),
  )[0]
}

function buildFormatSlots(input: {
  readonly filtered: readonly PluginCatalogCatalogEntryView[]
  readonly drift: readonly PluginCatalogCatalogDriftView[]
  readonly sourceId: string
}): readonly FormatSlot[] {
  const canonicalId = input.sourceId
  const chip = input.filtered.filter((e) => pluginCatalogVariantSourceId(e) === canonicalId)
  if (chip.length === 0) return []

  const onnxNative = pickNativeForFormat(chip, 'onnx', canonicalId)
  const onnxManifestId = onnxNative?.id ?? pluginCatalogManifestIdForFormat(canonicalId, 'onnx')
  const slots: FormatSlot[] = []

  for (const format of FORMAT_ORDER) {
    const native = pickNativeForFormat(chip, format, canonicalId)
    if (native) {
      slots.push({
        id: `${canonicalId}::${format}`,
        format,
        mode: 'native',
        manifestId: native.id,
        canonicalId,
        onnxManifestId: onnxManifestId ?? native.id,
        sizeMB: native.model.formats[format]?.sizeMB,
        driftStatus: pluginCatalogDriftOf(input.drift, native.id),
      })
      continue
    }
    if ((format === 'openvino' || format === 'coreml') && onnxManifestId !== undefined) {
      slots.push({
        id: `${canonicalId}::convert::${format}`,
        format,
        mode: 'convert',
        manifestId: onnxManifestId,
        canonicalId,
        onnxManifestId,
        driftStatus: 'ok',
      })
    }
  }
  return slots
}
