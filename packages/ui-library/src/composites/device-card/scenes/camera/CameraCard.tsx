import type { ReactElement, ReactNode } from 'react'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardCommon, CardOrientation, CardState } from '../../shell/model'

export interface CameraCardProps {
  readonly common: CardCommon
  /** What the camera is doing: asleep, motion now, awake (the base card's state line). */
  readonly state: CardState
  /** The camera's live / snapshot view, owned by the host (the device page's player). */
  readonly scene: ReactNode
  readonly orientation?: CardOrientation
  readonly showName?: boolean
  readonly className?: string
}

/**
 * A camera: the base device card with its scene forced to full width. The
 * host's player (with its own toolbar) is the whole scene and nothing is drawn
 * over it; the state line, the History view, the battery and the rest of what
 * every device card carries sit in the card's frame around it. The recorded
 * history is `common.history`, opened from the state line like any device's.
 */
export function CameraCard({
  common,
  state,
  scene,
  orientation = 'horizontal',
  showName = true,
  className,
}: CameraCardProps): ReactElement {
  return (
    <DeviceCard
      kind="camera"
      common={common}
      state={state}
      orientation={orientation}
      showName={showName}
      {...(className === undefined ? {} : { className })}
      scene={{ wide: true, image: scene }}
    />
  )
}
