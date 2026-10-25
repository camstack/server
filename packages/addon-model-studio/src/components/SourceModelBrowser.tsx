/**
 * Shared Sources browser: optional pre-selectors above Catalog-style
 * family cards (`GroupedModelSelector` + action row).
 *
 * Each family card keeps its own chip selection and can render its own
 * Import row — plus catalog shows YOLONAS and YOLOv9 side by side, both
 * independently downloadable.
 *
 * plugin catalog uses a Variant pre-selector (Standard/Test = relu/relu_test).
 * plus catalog uses kind / release / detector pre-selectors before arch chips.
 */
import { useState, type ReactNode } from 'react'
import { GroupedModelSelector } from '@camstack/ui-library'
import { buildModelVariantGroups, type ModelVariantSource } from '@camstack/types'
import { FacetSelect, type FacetOption } from './register-shared.js'
import { useT } from '../i18n/index.js'

export interface SourcePreSelector {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly options: readonly FacetOption[]
  readonly onChange: (value: string) => void
  readonly hint?: ReactNode
  readonly compactWhenSingle?: boolean
  readonly formatOption?: (option: FacetOption) => string
}

export interface SourceModelBrowserProps {
  readonly preSelectors?: readonly SourcePreSelector[]
  readonly catalog: readonly ModelVariantSource[]
  readonly value: string
  readonly onChange: (id: string) => void
  /** Override the first family's title; other families keep their group label. */
  readonly title?: string
  readonly subtitle?: ReactNode
  /**
   * Legacy single action row — only under the family that owns `value`.
   * Prefer {@link renderActionRow} when every family should be importable.
   */
  readonly actionRow?: ReactNode
  /** Per-family Import row keyed by that family's selected source id. */
  readonly renderActionRow?: (sourceId: string) => ReactNode
  readonly footer?: ReactNode
  readonly emptyMessage?: string
  readonly testId?: string
}

export function SourceModelBrowser({
  preSelectors = [],
  catalog,
  value,
  onChange,
  title,
  subtitle,
  actionRow,
  renderActionRow,
  footer,
  emptyMessage,
  testId = 'source-model-browser',
}: SourceModelBrowserProps) {
  const { t } = useT()
  const families = buildModelVariantGroups(catalog)
  const [familyChip, setFamilyChip] = useState<Readonly<Record<string, string>>>({})

  return (
    <div className="space-y-3" data-testid={testId}>
      {preSelectors.length > 0 && (
        <div className="space-y-3" data-testid="source-pre-selectors">
          {preSelectors.map((sel) => (
            <FacetSelect
              key={sel.id}
              label={sel.label}
              value={sel.value}
              options={sel.options}
              onChange={sel.onChange}
              compactWhenSingle={sel.compactWhenSingle ?? true}
              {...(sel.formatOption !== undefined ? { formatOption: sel.formatOption } : {})}
              {...(sel.hint !== undefined ? { hint: sel.hint } : {})}
            />
          ))}
        </div>
      )}

      {families.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface text-center text-xs text-foreground-subtle italic py-8">
          {emptyMessage ?? t('sourceBrowser.empty')}
        </div>
      ) : (
        families.map((family, index) => {
          const familyCatalog = catalog.filter((s) => s.group?.family === family.family)
          const defaultId = family.tiers[0]?.baseModelId ?? familyCatalog[0]?.id ?? ''
          const ownsGlobalValue = value.length > 0 && familyCatalog.some((s) => s.id === value)
          const chipValue = ownsGlobalValue ? value : (familyChip[family.family] ?? defaultId)
          const selectedHere = ownsGlobalValue || (value.length === 0 && index === 0)
          return (
            <div
              key={family.family}
              data-testid="source-family-card"
              data-family={family.family}
              className="rounded-xl border border-border bg-surface px-3 py-3 space-y-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-foreground">
                  {index === 0 && title !== undefined ? title : family.label}
                </span>
                <span className="text-[10px] font-mono text-foreground-subtle">{chipValue}</span>
              </div>
              {selectedHere ? subtitle : null}
              <GroupedModelSelector
                catalog={familyCatalog}
                value={chipValue}
                onChange={(id) => {
                  setFamilyChip((prev) => ({ ...prev, [family.family]: id }))
                  onChange(id)
                }}
              />
              {renderActionRow !== undefined
                ? chipValue.length > 0
                  ? renderActionRow(chipValue)
                  : null
                : selectedHere
                  ? actionRow
                  : null}
            </div>
          )
        })
      )}

      {footer}
    </div>
  )
}
