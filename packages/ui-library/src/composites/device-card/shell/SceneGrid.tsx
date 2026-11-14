import { Fragment, type ReactElement, type ReactNode } from 'react'
import { cn } from '../../../lib/cn'
import type { ColumnItem } from './column-items'

interface SceneZonesBase {
  /** Behind everything: the role animation. */
  readonly fx?: ReactNode
  readonly image: ReactNode
  /** Anything longer than a compact control: selectors, segmented choices, text. */
  readonly bottom?: ReactNode
  /**
   * The device is in an alarm state (triggered, jammed, sounding, blocked, a
   * leak): the scene is washed in the danger colour.
   */
  readonly alert?: boolean
}

/**
 * A scene on the fixed proportions: two equal side columns that take only
 * {@link ColumnItem}s (a compact control or one short value), the drawing in
 * between, and everything longer in `bottom`.
 */
export interface FixedSceneZones extends SceneZonesBase {
  readonly columns?: SceneColumns
  readonly left?: never
  readonly right?: never
}

export interface SceneColumns {
  readonly left?: readonly ColumnItem[]
  readonly right?: readonly ColumnItem[]
}

/**
 * A scene not yet moved to the fixed proportions: free content in its columns.
 * Each device moves to {@link FixedSceneZones} in turn.
 */
export interface FreeSceneZones extends SceneZonesBase {
  readonly left?: ReactNode
  readonly right?: ReactNode
  readonly columns?: never
}

export type SceneZones = FixedSceneZones | FreeSceneZones

export type SceneGridProps = SceneZones & {
  /** The four corners, placed by the shell. */
  readonly corners: ReactNode
  /** A bottom corner is drawn: leave room under the zones. */
  readonly bottomCorners: boolean
  readonly activity?: string
}

const has = (zone: ReactNode): boolean => zone !== undefined && zone !== null && zone !== false

function columnStack(items: readonly ColumnItem[] | undefined): ReactNode {
  if (items === undefined || items.length === 0) return null
  return items.map((item) => <Fragment key={item.key}>{item.node}</Fragment>)
}

/**
 * The scene: left column, drawing, right column, and a bottom row — the same
 * four zones for every device type. A zone with nothing in it is not rendered.
 */
export function SceneGrid(props: SceneGridProps): ReactElement {
  const { fx, image, bottom, corners, bottomCorners, activity, alert = false } = props
  const fixed = props.columns !== undefined
  const left = props.columns === undefined ? props.left : columnStack(props.columns.left)
  const right = props.columns === undefined ? props.right : columnStack(props.columns.right)
  return (
    <div
      data-testid="dc-scene"
      data-act={activity}
      data-bottom={has(bottom)}
      data-alert={alert}
      data-columns={fixed ? 'fixed' : 'free'}
      data-sides={fixed ? Number(has(left)) + Number(has(right)) : undefined}
      className={cn(
        'dc-scene relative gap-y-3.5 rounded-2xl border pt-10',
        fixed ? 'gap-x-0 px-1' : 'gap-x-2 px-3',
        alert ? 'border-danger/50 bg-danger/10' : 'border-border bg-background-elevated',
        bottomCorners ? 'pb-10' : 'pb-3.5',
      )}
    >
      {fx}
      {corners}
      {has(left) || (fixed && has(right)) ? (
        <div
          data-zone="left"
          className={cn(
            'dc-left flex w-full min-w-0 max-w-full flex-col items-center gap-2',
            !fixed && 'overflow-x-clip',
          )}
        >
          {left}
        </div>
      ) : null}
      <div data-zone="image" className="dc-img relative flex items-center justify-center">
        {image}
      </div>
      {has(right) || (fixed && has(left)) ? (
        <div
          data-zone="right"
          className={cn(
            'dc-right flex min-w-0 flex-col gap-2',
            fixed
              ? 'items-center'
              : 'items-stretch [&>*]:min-w-0 [&>*>button]:w-full [&>*>button]:gap-0.5 [&>*>button]:px-1 [&>*>button]:text-xs [&>button]:px-2 [&>button]:text-xs',
          )}
        >
          {right}
        </div>
      ) : null}
      {has(bottom) ? (
        <div
          data-zone="bottom"
          className="dc-bottom flex w-full min-w-0 max-w-full flex-col items-center gap-2.5 overflow-x-clip"
        >
          {bottom}
        </div>
      ) : null}
    </div>
  )
}
