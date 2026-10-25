/**
 * Cluster palette editor (D939). Presets or a custom table. The verdict is
 * {@link validatePalette} — the same rule the hub refuses with.
 */
import { useMemo, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PALETTE_ENTRY_IDS,
  formatPaletteViolations,
  validatePalette,
  type ConfigColorField,
  type PaletteSwatch,
  type PaletteSwatchMap,
  type SetPaletteInput,
} from '@camstack/types'
import { Button, ConfigFormField, SectionCard } from '@camstack/ui-library'
import { PaletteLegend, SwatchDot, legendLabel, swatchHex } from './palette-legend'

export interface PalettePresetChoice {
  readonly id: string
  readonly name: string
  readonly swatches: PaletteSwatchMap
  readonly fallbacks: readonly string[]
}

export interface PaletteEditorProps {
  readonly status: 'pending' | 'unknown' | 'ready'
  readonly reason?: string
  readonly source?: 'stored' | 'unconfigured'
  readonly presetId?: string
  readonly customized?: boolean
  readonly swatches?: PaletteSwatchMap
  readonly presets: readonly PalettePresetChoice[]
  readonly saving?: boolean
  readonly onApply: (input: SetPaletteInput) => void
}

function isHex(value: string): boolean {
  return /^#[0-9a-f]{6}$/.test(value)
}

function overridesAgainst(
  base: PaletteSwatchMap,
  current: PaletteSwatchMap,
): Record<string, PaletteSwatch> {
  const overrides: Record<string, PaletteSwatch> = {}
  for (const id of PALETTE_ENTRY_IDS) {
    const next = current[id]
    const from = base[id]
    if (next === undefined || from === undefined) continue
    if (next.hex !== from.hex) overrides[id] = next
  }
  return overrides
}

export function PaletteEditor({
  status,
  reason,
  source,
  presetId,
  customized,
  swatches,
  presets,
  saving,
  onApply,
}: PaletteEditorProps): JSX.Element {
  const { t } = useTranslation()
  const [custom, setCustom] = useState(customized === true)
  const [baseId, setBaseId] = useState(presetId ?? presets[0]?.id ?? 'camstack')
  const [draft, setDraft] = useState<PaletteSwatchMap>(swatches ?? presets[0]?.swatches ?? {})

  const base = presets.find((row) => row.id === baseId) ?? presets[0]
  const verdict = useMemo(() => {
    if (base === undefined) return null
    return validatePalette(draft, base.fallbacks)
  }, [base, draft])

  if (status === 'pending') {
    return (
      <p className="text-xs text-foreground-subtle" role="status">
        {t('pipeline.palette.pending', 'Reading the cluster palette…')}
      </p>
    )
  }

  const applyPreset = (id: string): void => {
    const row = presets.find((preset) => preset.id === id)
    if (row === undefined) return
    setCustom(false)
    setBaseId(id)
    setDraft(row.swatches)
    onApply({ presetId: id })
  }

  const startCustom = (): void => {
    if (base === undefined) return
    setCustom(true)
    setDraft(base.swatches)
  }

  const editHex = (id: string, value: unknown): void => {
    if (typeof value !== 'string') return
    const hex = value.trim().toLowerCase()
    if (!isHex(hex)) return
    const current = draft[id]
    const next: PaletteSwatch =
      current?.form === 'gradient' ? { ...current, hex } : { form: 'solid', hex }
    setDraft({ ...draft, [id]: next })
  }

  const saveCustom = (): void => {
    if (base === undefined || verdict === null || !verdict.ok) return
    const overrides = overridesAgainst(base.swatches, draft)
    onApply(
      Object.keys(overrides).length > 0 ? { presetId: base.id, overrides } : { presetId: base.id },
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {status === 'unknown' && (
        <p className="text-xs text-warning" role="status" data-testid="palette-unknown">
          {t(
            'pipeline.palette.unknown',
            'The stored palette cannot be read ({{reason}}). Boxes use the bundled CamStack preset.',
            { reason: reason ?? '' },
          )}
        </p>
      )}
      {status === 'ready' && source === 'unconfigured' && (
        <p className="text-xs text-foreground-subtle">
          {t('pipeline.palette.sourceUnconfigured', 'CamStack preset (cluster default)')}
        </p>
      )}
      <SectionCard headingId="palette-presets" title={t('pipeline.palette.presets', 'Presets')}>
        <div className="flex flex-wrap gap-2 p-3">
          {presets.map((preset) => (
            <Button
              key={preset.id}
              type="button"
              size="sm"
              variant={!custom && preset.id === baseId ? 'primary' : 'outline'}
              onClick={() => applyPreset(preset.id)}
              disabled={saving}
            >
              <span className="inline-flex items-center gap-1">
                {(['person', 'vehicle', 'animal'] as const).map((id) => {
                  const hex = swatchHex(preset.swatches[id])
                  return hex === undefined ? null : <SwatchDot key={id} hex={hex} />
                })}
                {preset.name}
              </span>
            </Button>
          ))}
          <Button
            type="button"
            size="sm"
            variant={custom ? 'primary' : 'outline'}
            onClick={startCustom}
            disabled={saving || base === undefined}
          >
            {t('pipeline.palette.custom', 'Custom')}
          </Button>
        </div>
      </SectionCard>
      <PaletteLegend swatches={draft} />
      {verdict !== null && verdict.ok && (
        <p className="text-xs text-success" data-testid="palette-verdict">
          {t('pipeline.palette.valid', 'Every colour is distinct on both themes.')}
        </p>
      )}
      {verdict !== null && !verdict.ok && (
        <p className="text-xs text-danger" data-testid="palette-verdict">
          {t('pipeline.palette.invalid', 'This palette is refused: {{reason}}', {
            reason: formatPaletteViolations(verdict.violations),
          })}
        </p>
      )}
      {custom && base !== undefined && (
        <SectionCard headingId="palette-custom" title={t('pipeline.palette.custom', 'Custom')}>
          <div className="flex flex-col gap-2 p-3">
            {PALETTE_ENTRY_IDS.map((id) => {
              const hex = swatchHex(draft[id])
              if (hex === undefined) return null
              const field: ConfigColorField = { type: 'color', key: id, label: legendLabel(id) }
              return (
                <ConfigFormField
                  key={id}
                  field={field}
                  values={{ [id]: hex }}
                  onChange={(_key, value) => editHex(id, value)}
                />
              )
            })}
            <Button
              type="button"
              size="sm"
              onClick={saveCustom}
              disabled={saving || verdict === null || !verdict.ok}
            >
              {t('pipeline.palette.save', 'Save custom palette')}
            </Button>
          </div>
        </SectionCard>
      )}
    </div>
  )
}
