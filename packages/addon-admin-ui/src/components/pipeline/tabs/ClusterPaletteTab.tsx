/**
 * Pipeline → Cluster → Palette (D939).
 */
import type { JSX } from 'react'
import {
  useDisplayPaletteGetPalette,
  useDisplayPaletteListPresets,
  useDisplayPaletteSetPalette,
} from '@camstack/ui-library'
import type { SetPaletteInput } from '@camstack/types'
import { PaletteEditor } from './palette-editor'

export function ClusterPaletteTab(): JSX.Element {
  const palette = useDisplayPaletteGetPalette({})
  const presets = useDisplayPaletteListPresets({})
  const setPalette = useDisplayPaletteSetPalette()
  const apply = (input: SetPaletteInput): void => {
    setPalette.mutate(input, {
      onSuccess: () => {
        void palette.refetch()
        void presets.refetch()
      },
    })
  }
  if (palette.isPending || presets.isPending) {
    return <PaletteEditor status="pending" presets={[]} onApply={apply} />
  }
  if (palette.isError || palette.data === undefined) {
    return (
      <PaletteEditor
        status="unknown"
        reason={palette.isError ? String(palette.error) : 'no palette'}
        presets={presets.data ?? []}
        saving={setPalette.isPending}
        onApply={apply}
      />
    )
  }
  if (presets.isError || presets.data === undefined) {
    return (
      <PaletteEditor
        status="unknown"
        reason={String(presets.error)}
        presets={[]}
        saving={setPalette.isPending}
        onApply={apply}
      />
    )
  }
  if (palette.data.status === 'unknown') {
    return (
      <PaletteEditor
        status="unknown"
        reason={palette.data.reason}
        presets={presets.data}
        saving={setPalette.isPending}
        onApply={apply}
      />
    )
  }
  const ready = palette.data
  return (
    <PaletteEditor
      key={`${ready.presetId}:${String(ready.customized)}`}
      status="ready"
      source={ready.source}
      presetId={ready.presetId}
      customized={ready.customized}
      swatches={ready.swatches}
      presets={presets.data}
      saving={setPalette.isPending}
      onApply={apply}
    />
  )
}
