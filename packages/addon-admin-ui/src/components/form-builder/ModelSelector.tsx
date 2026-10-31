import { useState } from 'react'
import { Info, ExternalLink, Check, Cpu } from 'lucide-react'
import { buildModelVariantGroups } from '@camstack/types'
import { GroupedModelSelector, Button, Input } from '@camstack/ui-library'
import type { ConfigModelSelectorField, ModelCatalogEntry } from '../../types/config-ui'
import { useTranslation } from 'react-i18next'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TabId = 'catalog' | 'custom'

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SegmentedControl({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: TabId; label: string }[]
  active: TabId
  onChange: (id: TabId) => void
}) {
  return (
    <div className="flex rounded-lg border border-border bg-surface p-0.5 gap-0.5">
      {tabs.map((tab) => (
        <Button
          variant="unstyled"
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={[
            'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            active === tab.id
              ? 'bg-primary/12 text-primary'
              : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
          ].join(' ')}
        >
          {tab.label}
        </Button>
      ))}
    </div>
  )
}

function formatSize(entry: ModelCatalogEntry): string {
  const formats = entry.formats
  if (!formats) return ''
  const sizes = Object.values(formats)
    .filter((f): f is { url: string; sizeMB: number } => f !== undefined && f.sizeMB > 0)
    .map((f) => f.sizeMB)
  if (sizes.length === 0) return ''
  const min = Math.min(...sizes)
  const max = Math.max(...sizes)
  // i18n-ignore: unit symbol
  if (min === max) return `${min} MB`
  // i18n-ignore: unit symbol
  return `${min}-${max} MB`
}

function formatDimensions(entry: ModelCatalogEntry): string {
  return `${entry.inputSize.width}x${entry.inputSize.height}`
}

function formatFormats(entry: ModelCatalogEntry): string[] {
  if (!entry.formats) return []
  return Object.keys(entry.formats).filter(
    (k) => entry.formats[k as keyof typeof entry.formats] !== undefined,
  )
}

// ---------------------------------------------------------------------------
// Model catalog card
// ---------------------------------------------------------------------------

function ModelCard({
  entry,
  selected,
  onSelect,
  disabled,
}: {
  entry: ModelCatalogEntry
  selected: boolean
  onSelect: () => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const size = formatSize(entry)
  const dims = formatDimensions(entry)
  const formats = formatFormats(entry)

  return (
    <Button
      variant="unstyled"
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={[
        'w-full text-left rounded-lg border p-3 transition-all',
        selected
          ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
          : 'border-border bg-background hover:border-foreground-subtle/40 hover:bg-surface-hover/50',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground truncate">{entry.name}</span>
            {selected && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
          </div>
          <p className="text-[10px] text-foreground-subtle mt-0.5 line-clamp-2">
            {entry.description}
          </p>
        </div>
      </div>

      {/* Metadata row */}
      <div className="flex items-center gap-3 mt-2 flex-wrap">
        <span className="inline-flex items-center gap-1 text-[10px] text-foreground-subtle">
          <Cpu className="h-3 w-3" />
          {dims}
        </span>
        {size && <span className="text-[10px] text-foreground-subtle">{size}</span>}
        {formats.length > 0 && (
          <div className="flex gap-1">
            {formats.map((fmt) => (
              <span
                key={fmt}
                className="text-[9px] uppercase rounded bg-surface border border-border px-1 py-0.5 text-foreground-subtle font-mono"
              >
                {fmt}
              </span>
            ))}
          </div>
        )}
        {entry.labels.length > 0 && (
          <span className="text-[10px] text-foreground-subtle">
            {t('common.labels', { count: entry.labels.length })}
          </span>
        )}
      </div>
    </Button>
  )
}

// ---------------------------------------------------------------------------
// Main ModelSelector component
// ---------------------------------------------------------------------------

interface ModelSelectorProps {
  field: ConfigModelSelectorField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
}

export function ModelSelector({ field, value, onChange, disabled }: ModelSelectorProps) {
  const { t } = useTranslation()
  const catalog = field.catalog ?? []
  const hasCatalog = catalog.length > 0
  // Grouped families present (yolo26 …) → use the Family→Tier→Variant selector.
  const hasGroups = buildModelVariantGroups(catalog).length > 0
  const allowCustomPath = field.allowCustomPath !== false || field.allowCustom === true

  const tabs: { id: TabId; label: string }[] = [
    ...(hasCatalog
      ? [
          {
            id: 'catalog' as TabId,
            label: t('formBuilder.modelSelector.models', 'Models ({{length}})', {
              length: catalog.length,
            }),
          },
        ]
      : []),
    ...(allowCustomPath
      ? [{ id: 'custom' as TabId, label: t('formBuilder.modelSelector.customPath', 'Custom Path') }]
      : []),
  ]

  const [activeTab, setActiveTab] = useState<TabId>(hasCatalog ? 'catalog' : 'custom')

  const currentValue = value === undefined || value === null ? '' : String(value)

  return (
    <div className="space-y-3">
      {tabs.length > 1 && (
        <SegmentedControl tabs={tabs} active={activeTab} onChange={setActiveTab} />
      )}

      {/* Catalog tab — grouped variant selector when the catalog declares
          families (yolo26 …), else the flat card list (face/plate/custom). */}
      {activeTab === 'catalog' && hasCatalog && hasGroups && (
        <GroupedModelSelector
          catalog={catalog}
          value={currentValue}
          onChange={(id) => onChange(id)}
          disabled={disabled || field.disabled}
        />
      )}
      {activeTab === 'catalog' && hasCatalog && !hasGroups && (
        <div className="space-y-1.5 max-h-[320px] overflow-y-auto pr-1">
          {catalog
            .filter((entry) => entry.legacy !== true)
            .map((entry) => (
              <ModelCard
                key={entry.id}
                entry={entry}
                selected={currentValue === entry.id}
                onSelect={() => onChange(entry.id)}
                disabled={disabled || field.disabled}
              />
            ))}
        </div>
      )}

      {/* Fallback when no catalog is available */}
      {activeTab === 'catalog' && !hasCatalog && (
        <div className="rounded-md border border-info/30 bg-info/5 px-3 py-2 flex items-start gap-2">
          <Info className="h-3.5 w-3.5 text-info shrink-0 mt-0.5" />
          <p className="text-[11px] text-foreground-subtle leading-relaxed">
            {t(
              'formBuilder.modelSelector.noPredefinedModelsAvailableUse',
              'No predefined models available. Use the Custom Path tab to specify a model file path or URL.',
            )}
          </p>
        </div>
      )}

      {/* Custom path tab */}
      {activeTab === 'custom' && allowCustomPath && (
        <div className="space-y-2">
          <Input
            type="text"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none disabled:opacity-50"
            placeholder={t(
              'formBuilder.modelSelector.enterPathLikeDataModels',
              'Enter path like /data/models/custom.onnx or https://...',
            )}
            value={currentValue}
            disabled={disabled || field.disabled}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.acceptFormats && field.acceptFormats.length > 0 && (
            <p className="text-[10px] text-foreground-subtle">
              {t('formBuilder.modelSelector.acceptedFormats', 'Accepted formats:')}{' '}
              {field.acceptFormats.join(', ')}
            </p>
          )}
        </div>
      )}

      {/* Footer: compatibility note + conversion guide */}
      {(field.compatibilityNote || field.conversionGuideUrl) && (
        <div className="flex items-start justify-between gap-3 pt-1">
          {field.compatibilityNote && (
            <p className="flex items-start gap-1 text-[10px] text-foreground-subtle">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              {field.compatibilityNote}
            </p>
          )}
          {field.conversionGuideUrl && (
            <a
              href={field.conversionGuideUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[11px] text-primary hover:underline shrink-0"
            >
              {t('formBuilder.modelSelector.howToConvertYourModel', 'How to convert your model')}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}
    </div>
  )
}
