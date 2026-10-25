/**
 * Named swatches for the cluster palette (D939). Each entry is a swatch,
 * its label and its hex, painted on both contrast grounds. Subclasses stay
 * collapsed under the parent.
 */
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AUDIO_GRADIENT_ALPHAS,
  PALETTE_BACKGROUNDS,
  paletteLegend,
  type PaletteLegendGroup,
  type PaletteSwatch,
  type PaletteSwatchMap,
} from '@camstack/types'

export function swatchHex(swatch: PaletteSwatch | undefined): string | undefined {
  return swatch?.hex
}

export function SwatchDot({ hex }: { readonly hex: string }): JSX.Element {
  return (
    <span
      className="inline-block h-3 w-3 shrink-0 rounded-sm border border-border"
      // ui-check-ok: swatch paints a palette data colour, not a theme token
      style={{ backgroundColor: hex }}
    />
  )
}

function Mark({
  id,
  label,
  swatch,
}: {
  readonly id: string
  readonly label: string
  readonly swatch: PaletteSwatch | undefined
}): JSX.Element | null {
  const hex = swatchHex(swatch)
  if (hex === undefined) return null
  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
      data-testid={`palette-entry-${id}`}
    >
      {swatch?.form === 'gradient' ? (
        <span className="flex h-4 overflow-hidden rounded-sm">
          {AUDIO_GRADIENT_ALPHAS.map((alpha) => (
            <span
              key={alpha}
              className="h-4 w-2"
              // ui-check-ok: audio gradient stop is a palette data colour
              style={{ backgroundColor: hex, opacity: alpha }}
            />
          ))}
        </span>
      ) : (
        <span
          className="h-4 w-3 shrink-0 rounded-sm"
          // ui-check-ok: timeline mark paints a palette data colour
          style={{ backgroundColor: hex }}
        />
      )}
      <span>{label}</span>
      <span className="font-mono text-[11px] opacity-80">{hex}</span>
    </span>
  )
}

function GroupBlock({
  ground,
  group,
  swatches,
}: {
  readonly ground: string
  readonly group: PaletteLegendGroup
  readonly swatches: PaletteSwatchMap
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Mark id={group.id} label={group.label} swatch={swatches[group.id]} />
      {group.children.length > 0 && (
        <details data-testid={`palette-subs-${ground}-${group.id}`}>
          <summary className="cursor-pointer text-[11px] opacity-80">
            {t('pipeline.palette.subclasses', 'Subclasses')}
          </summary>
          <div className="mt-1 flex flex-col gap-1 pl-4">
            {group.children.map((child) => (
              <Mark key={child.id} id={child.id} label={child.label} swatch={swatches[child.id]} />
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

export function PaletteLegend({ swatches }: { readonly swatches: PaletteSwatchMap }): JSX.Element {
  const { t } = useTranslation()
  const groups = paletteLegend()
  const rows = [
    { id: 'dark', background: PALETTE_BACKGROUNDS.dark, ink: PALETTE_BACKGROUNDS.light },
    { id: 'light', background: PALETTE_BACKGROUNDS.light, ink: PALETTE_BACKGROUNDS.dark },
  ] as const
  return (
    <div className="flex flex-col gap-2" data-testid="palette-preview">
      <div className="text-[11px] text-foreground-subtle">
        {t('pipeline.palette.preview', 'Timeline marks')}
      </div>
      {rows.map((row) => (
        <div
          key={row.id}
          className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-md border border-border p-2 sm:grid-cols-2"
          data-testid={`palette-ground-${row.id}`}
          // ui-check-ok: preview ground and its ink are the palette contrast pair, not theme tokens
          style={{ backgroundColor: row.background, color: row.ink }}
        >
          {groups.map((group) => (
            <GroupBlock key={group.id} ground={row.id} group={group} swatches={swatches} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function legendLabel(id: string): string {
  for (const group of paletteLegend()) {
    if (group.id === id) return group.label
    const child = group.children.find((row) => row.id === id)
    if (child !== undefined) return child.label
  }
  return id
}
