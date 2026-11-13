import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { SceneBackdrop } from '../../hero-scene/backdrops'
import { HERO_SCENE_CSS } from '../../hero-scene/hero-scene-css'
import { TONE_CLASS } from '../../hero-scene/scene-map'
import type { SceneVisual } from '../../hero-scene/types'

export interface MeasurementFxProps {
  readonly visual: SceneVisual
}

/**
 * The backdrop behind a sensor's reading, in the reading's tone: the scene's
 * ambient layer for a measurement. Under `prefers-reduced-motion` it stands
 * still (HERO_SCENE_CSS).
 */
export function MeasurementFx({ visual }: MeasurementFxProps): ReactElement {
  return (
    <div
      className={cn('dc-fx', TONE_CLASS[visual.tone])}
      data-testid="dc-measurement-fx"
      data-fx={visual.kind}
    >
      <style>{HERO_SCENE_CSS}</style>
      <SceneBackdrop visual={visual} />
    </div>
  )
}
