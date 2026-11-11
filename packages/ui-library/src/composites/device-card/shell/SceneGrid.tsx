import type { ReactElement, ReactNode } from 'react'
import { cn } from '../../../lib/cn'

export interface SceneZones {
  /** Behind everything: the role animation. */
  readonly fx?: ReactNode
  readonly left?: ReactNode
  readonly image: ReactNode
  readonly right?: ReactNode
  readonly bottom?: ReactNode
}

export interface SceneGridProps extends SceneZones {
  /** The four corners, placed by the shell. */
  readonly corners: ReactNode
  /** A bottom corner is drawn: leave room under the zones. */
  readonly bottomCorners: boolean
  readonly activity?: string
}

const has = (zone: ReactNode): boolean => zone !== undefined && zone !== null && zone !== false

/**
 * The scene: left column, drawing, right column, and a bottom row — the same
 * four zones for every device type. A zone with nothing in it is not rendered.
 */
export function SceneGrid({
  fx,
  left,
  image,
  right,
  bottom,
  corners,
  bottomCorners,
  activity,
}: SceneGridProps): ReactElement {
  return (
    <div
      data-testid="dc-scene"
      data-act={activity}
      data-bottom={has(bottom)}
      className={cn(
        'dc-scene relative gap-x-2 gap-y-3.5 rounded-2xl border border-border bg-background-elevated px-3 pt-10',
        bottomCorners ? 'pb-10' : 'pb-3.5',
      )}
    >
      {fx}
      {corners}
      {has(left) ? (
        <div data-zone="left" className="dc-left flex flex-col items-center gap-2">
          {left}
        </div>
      ) : null}
      <div data-zone="image" className="dc-img relative flex items-center justify-center">
        {image}
      </div>
      {has(right) ? (
        <div
          data-zone="right"
          className="dc-right flex w-full min-w-0 max-w-28 flex-col items-stretch gap-2 [&>*]:min-w-0 [&>*>button]:w-full [&>*>button]:gap-0.5 [&>*>button]:px-1 [&>*>button]:text-xs [&>button]:px-2 [&>button]:text-xs"
        >
          {right}
        </div>
      ) : null}
      {has(bottom) ? (
        <div data-zone="bottom" className="dc-bottom flex flex-col items-center gap-2.5">
          {bottom}
        </div>
      ) : null}
    </div>
  )
}
