/**
 * GroupedModelSelector — the shared Family → Tier → Variant model picker.
 *
 * The catalog is a FLAT list of models (ids like `yolo26s`, `yolo26s-int8`);
 * this folds it into a `family → tier → variant` tree (see
 * `buildModelVariantGroups` in `@camstack/types`) so the operator picks
 * "YOLO26 → Small → Int8" instead of scanning a flat dropdown of every
 * size×quantization. The selected value stays the flat model id.
 *
 * Parameterised on the minimal `ModelVariantSource` shape so BOTH the config-UI
 * catalog (`ModelCatalogEntry`) and the pipeline/device steppers
 * (`PipelineModelOption`) drive the same component. Legacy / ungrouped models
 * never appear here (the grouping helpers skip them).
 */
import { useUiText } from '../contexts/ui-text'
import { Check, Cpu, Zap } from 'lucide-react'
import type { JSX } from 'react'
import {
  buildModelVariantGroups,
  describeModelVariant,
  resolveVariantModelId,
  type ModelVariantOption,
  type ModelVariantSource,
} from '@camstack/types'
import { cn } from '../lib/cn'

function Chip({
  active,
  onClick,
  disabled,
  children,
  title,
}: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'rounded-full px-3 py-1 text-[11px] font-medium border transition-colors',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border bg-background text-foreground-subtle hover:text-foreground hover:border-foreground-subtle/40',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
      )}
    >
      {children}
    </button>
  )
}

export interface GroupedModelSelectorProps {
  readonly catalog: readonly ModelVariantSource[]
  readonly value: string
  readonly onChange: (id: string) => void
  readonly disabled?: boolean
}

export function GroupedModelSelector({
  catalog,
  value,
  onChange,
  disabled,
}: GroupedModelSelectorProps): JSX.Element | null {
  const t = useUiText()
  const families = buildModelVariantGroups(catalog)
  const current = describeModelVariant(catalog, value)

  // Selected family/tier: from the current value, else the first available.
  const activeFamily =
    families.find((f) => f.family === current?.family)?.family ?? families[0]?.family ?? ''
  const family = families.find((f) => f.family === activeFamily) ?? families[0]
  if (!family) return null
  const activeTier =
    family.tiers.find((entry) => entry.tier === current?.tier)?.tier ?? family.tiers[0]?.tier ?? ''
  const tier = family.tiers.find((entry) => entry.tier === activeTier) ?? family.tiers[0]
  if (!tier) return null

  // Resolution axis: distinct input resolutions in the tier, largest first
  // (640, 320, 256). An entry that states none sorts first as the native build.
  // Only surfaced when a tier ships more than one — the reduced-input latency
  // variants.
  const resolutions = [...new Set(tier.options.map((o) => o.resolution))].sort(
    (a, b) => (b ?? Infinity) - (a ?? Infinity),
  )
  const selectedResolution = resolutions.includes(current?.resolution)
    ? current?.resolution
    : resolutions[0]
  // The precision/optimization variants available AT the selected resolution.
  const variantOptions = tier.options.filter((o) => o.resolution === selectedResolution)
  // No hardcoded number. This read "640 · native" for any entry that omitted
  // its resolution, which is a lie for every family whose native input is not
  // 640 — and the catalog now states the number, so the chip just shows it.
  const resLabel = (r: number | undefined): string =>
    r === undefined ? t('uiLibrary.groupedModelSelector.native', 'native') : `${r}`

  const selectTier = (tierId: string): void => {
    const entry = family.tiers.find((x) => x.tier === tierId)
    if (!entry) return
    // Preserve the current variant axes (precision/optimization/resolution) if
    // that exact variant exists in the new tier, else fall back to the base.
    const keep = entry.options.find(
      (o) =>
        o.precision === (current?.precision ?? 'fp32') &&
        o.optimization === (current?.optimization ?? 'standard') &&
        o.resolution === current?.resolution,
    )
    onChange((keep ?? entry.options[0]!).modelId)
  }

  const selectResolution = (resolution: number | undefined): void => {
    // Keep the current precision/optimization at the new resolution if it ships,
    // else the resolution's base (fp32/standard).
    const opts = tier.options.filter((o) => o.resolution === resolution)
    const keep = opts.find(
      (o) =>
        o.precision === (current?.precision ?? 'fp32') &&
        o.optimization === (current?.optimization ?? 'standard'),
    )
    const pick = keep ?? opts[0]
    if (pick) onChange(pick.modelId)
  }

  const selectVariant = (opt: ModelVariantOption): void => {
    const id = resolveVariantModelId(catalog, {
      family: family.family,
      tier: tier.tier,
      precision: opt.precision,
      optimization: opt.optimization,
      resolution: opt.resolution,
    })
    if (id) onChange(id)
  }

  const selectedOption = tier.options.find((o) => o.modelId === value) ?? null

  return (
    <div className="space-y-3">
      {/* Family — only when more than one exists */}
      {families.length > 1 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-foreground-subtle mb-1.5">
            {t('uiLibrary.groupedModelSelector.family', 'Family')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {families.map((f) => (
              <Chip
                key={f.family}
                active={f.family === family.family}
                disabled={disabled}
                {...(f.hint !== undefined ? { title: f.hint } : {})}
                onClick={() => onChange(f.tiers[0]?.baseModelId ?? '')}
              >
                {f.label}
              </Chip>
            ))}
          </div>
          {family.hint !== undefined && (
            <p className="mt-1 text-[10px] text-foreground-subtle" data-testid="model-family-hint">
              {family.label}: {family.hint}
            </p>
          )}
        </div>
      )}

      {/* Tier — size ladder; hide when the family has only one size */}
      {family.tiers.length > 1 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-foreground-subtle mb-1.5">
            {t('uiLibrary.groupedModelSelector.size', '{{family}} — size', {
              family: family.label,
            })}
          </p>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {family.tiers.map((entry) => {
              const active = entry.tier === tier.tier
              // The size QUOTED on the card follows the resolution selected
              // below it: the tier base is a fixed build, so a 320 selection kept
              // advertising the 640 weight while the footer already read the real
              // one. Falls back to the tier base for a tier that has no build at
              // the selected resolution.
              const quoted =
                entry.options.find(
                  (o) => o.resolution === selectedResolution && o.precision === 'fp32',
                ) ??
                entry.options.find((o) => o.modelId === entry.baseModelId) ??
                entry.options[0]
              return (
                <button
                  key={entry.tier}
                  type="button"
                  disabled={disabled}
                  onClick={() => selectTier(entry.tier)}
                  className={cn(
                    'rounded-lg border px-2 py-2 text-left transition-all',
                    active
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                      : 'border-border bg-background hover:border-foreground-subtle/40',
                    disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
                  )}
                >
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-semibold text-foreground">{entry.label}</span>
                    {active && <Check className="h-3 w-3 text-primary" />}
                  </div>
                  {quoted !== undefined && quoted.sizeMB > 0 && (
                    <span className="text-[10px] text-foreground-subtle">
                      {t('uiLibrary.groupedModelSelector.approxSize', '~{{size}} MB', {
                        size: quoted.sizeMB,
                      })}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Resolution — input-size axis; only when the tier ships reduced-input builds */}
      {resolutions.length > 1 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-foreground-subtle mb-1.5">
            {t('uiLibrary.groupedModelSelector.resolution', 'Resolution')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {resolutions.map((r) => (
              <Chip
                key={r ?? 'native'}
                active={r === selectedResolution}
                disabled={disabled}
                title={
                  r === undefined
                    ? t('uiLibrary.groupedModelSelector.nativeTitle', 'native (best accuracy)')
                    : t(
                        'uiLibrary.groupedModelSelector.fasterTitle',
                        '{{size}}×{{size}} (faster)',
                        {
                          size: r,
                        },
                      )
                }
                onClick={() => selectResolution(r)}
              >
                {resLabel(r)}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {/* Variant — precision / optimization; hide when there is nothing to pick */}
      {variantOptions.length > 1 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-foreground-subtle mb-1.5">
            {t('uiLibrary.groupedModelSelector.variant', 'Variant')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {variantOptions.map((opt) => (
              <Chip
                key={opt.modelId}
                active={opt.modelId === value}
                disabled={disabled}
                title={
                  opt.sizeMB > 0
                    ? t(
                        'uiLibrary.groupedModelSelector.formatsSize',
                        '{{formats}} · ~{{size}} MB',
                        {
                          formats: opt.formats.join(', '),
                          size: opt.sizeMB,
                        },
                      )
                    : opt.formats.join(', ')
                }
                onClick={() => selectVariant(opt)}
              >
                <span className="inline-flex items-center gap-1">
                  {opt.optimization === 'test' && <Zap className="h-3 w-3" />}
                  {opt.label}
                </span>
              </Chip>
            ))}
          </div>
        </div>
      )}

      {/* Selected summary */}
      <div className="flex items-center gap-2 text-[10px] text-foreground-subtle pt-0.5">
        <Cpu className="h-3 w-3" />
        <span className="font-mono">{value || '—'}</span>
        {selectedOption && (
          <span>
            · {selectedOption.formats.join(', ')}
            {selectedOption.sizeMB > 0
              ? t('uiLibrary.groupedModelSelector.sizeSuffix', ' · ~{{size}} MB', {
                  size: selectedOption.sizeMB,
                })
              : ''}
          </span>
        )}
      </div>
    </div>
  )
}
