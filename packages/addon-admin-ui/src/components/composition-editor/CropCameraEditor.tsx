/**
 * The crop of a crop camera (#611), drawn on its source camera's snapshot: one
 * highlighted rectangle, dragged to move and resized from its corners. The
 * canvas is the library's `SourceCropCanvas`, the one the camera grid's
 * per-cell crop uses; the geometry is the engine's own (`crop-geometry`), so
 * what is locked here is what the engine will cut.
 *
 * The ratio presets are a segmented control: a preset re-seeds the rectangle
 * for that ratio and locks the corners to it, `Free` unlocks them.
 */
import {
  CROP_ASPECTS,
  type CropAspect,
  type CropHandle,
  type GridRect,
  moveCropRect,
  resizeCropRect,
  seedCropRect,
} from '@dominevo/types'
import { Button, SourceCropCanvas, type SourceCropDrag } from '@dominevo/ui-library'
import { type ReactNode, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_SOURCE_ASPECT } from './helper-form-model'

const CORNERS: readonly CropHandle[] = ['nw', 'ne', 'se', 'sw']

function isCorner(mode: SourceCropDrag['mode']): mode is CropHandle {
  return mode === 'nw' || mode === 'ne' || mode === 'se' || mode === 'sw'
}

export interface CropValue {
  readonly rect: GridRect
  readonly aspect: CropAspect
}

export interface CropCameraEditorProps {
  /** The source camera whose snapshot is drawn; null until one is picked. */
  readonly sourceDeviceId: number | null
  readonly value: CropValue
  /**
   * Create: the rectangle is re-seeded once the snapshot tells the frame's real
   * shape, unless the operator already moved it. Edit: the stored rectangle stands.
   */
  readonly reseedOnLoad: boolean
  readonly disabled?: boolean
  readonly onChange: (next: CropValue) => void
}

export function CropCameraEditor({
  sourceDeviceId,
  value,
  reseedOnLoad,
  disabled = false,
  onChange,
}: CropCameraEditorProps): ReactNode {
  const { t } = useTranslation()
  const [sourceAspect, setSourceAspect] = useState(DEFAULT_SOURCE_ASPECT)
  const touched = useRef(!reseedOnLoad)

  if (sourceDeviceId === null) {
    return (
      <p className="text-[11px] text-foreground-muted" data-testid="crop-pick-source">
        {t('helper.crop.pickSource')}
      </p>
    )
  }

  const onDrag = (drag: SourceCropDrag): void => {
    if (disabled) return
    touched.current = true
    if (drag.mode === 'move') {
      onChange({ ...value, rect: moveCropRect(drag.origin, drag.dx, drag.dy) })
      return
    }
    if (!isCorner(drag.mode)) return
    onChange({
      ...value,
      rect: resizeCropRect({
        rect: drag.origin,
        handle: drag.mode,
        point: drag.point,
        aspect: value.aspect,
        sourceAspect: drag.sourceAspect,
      }),
    })
  }

  return (
    <div className="flex max-w-xl flex-col gap-2" data-testid="crop-camera-editor">
      <div
        role="radiogroup"
        aria-label={t('helper.crop.ratio')}
        className="flex flex-wrap items-center gap-1"
        data-testid="crop-ratio"
      >
        <span className="mr-1 text-[11px] text-foreground-muted">{t('helper.crop.ratio')}</span>
        {CROP_ASPECTS.map((aspect) => (
          <Button
            key={aspect}
            size="sm"
            role="radio"
            aria-checked={value.aspect === aspect}
            variant={value.aspect === aspect ? 'primary' : 'ghost'}
            disabled={disabled}
            data-testid={`crop-ratio-${aspect}`}
            onClick={() => {
              touched.current = true
              onChange({ aspect, rect: seedCropRect(aspect, sourceAspect) })
            }}
          >
            {aspect === 'free' ? t('helper.crop.free') : aspect}
          </Button>
        ))}
      </div>
      <SourceCropCanvas
        deviceId={sourceDeviceId}
        rect={value.rect}
        handles={CORNERS}
        onDrag={onDrag}
        onSourceAspect={(aspect) => {
          setSourceAspect(aspect)
          if (!touched.current) onChange({ ...value, rect: seedCropRect(value.aspect, aspect) })
        }}
      />
      <p className="text-[11px] text-foreground-muted">{t('helper.crop.hint')}</p>
    </div>
  )
}
