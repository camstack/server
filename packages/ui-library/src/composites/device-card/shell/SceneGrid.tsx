import { Fragment, type ReactElement, type ReactNode } from 'react'
import { cn } from '../../../lib/cn'
import type { BottomRow } from './bottom-rows'
import type { ColumnItem } from './column-items'

interface SceneZonesBase {
  /** Behind everything: the role animation. */
  readonly fx?: ReactNode
  readonly image: ReactNode
  /** Anything longer than a compact control, as typed rows: selectors, pills, stats, buttons, a slider, text. */
  readonly bottom?: readonly BottomRow[]
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
}

export interface SceneColumns {
  readonly left?: readonly ColumnItem[]
  readonly right?: readonly ColumnItem[]
}

export type SceneZones = FixedSceneZones

export type SceneGridProps = SceneZones & {
  /** The four corners, placed by the shell. */
  readonly corners: ReactNode
  /** A bottom corner is drawn: leave room under the zones. */
  readonly bottomCorners: boolean
  readonly activity?: string
}

const has = (zone: ReactNode): boolean => zone !== undefined && zone !== null && zone !== false

const hasRows = (rows: readonly BottomRow[] | undefined): rows is readonly BottomRow[] =>
  rows !== undefined && rows.length > 0

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
  const left = columnStack(props.columns?.left)
  const right = columnStack(props.columns?.right)
  return (
    <div
      data-testid="dc-scene"
      data-act={activity}
      data-bottom={hasRows(bottom)}
      data-alert={alert}
      data-sides={Number(has(left)) + Number(has(right))}
      className={cn(
        'dc-scene relative gap-y-3.5 rounded-2xl border pt-10',
        'gap-x-0 px-1',
        alert ? 'border-danger/50 bg-danger/10' : 'border-border bg-background-elevated',
        bottomCorners ? 'pb-10' : 'pb-3.5',
      )}
    >
      {fx}
      {corners}
      {has(left) || has(right) ? (
        <div
          data-zone="left"
          className="dc-left flex w-full min-w-0 max-w-full flex-col items-center gap-2"
        >
          {left}
        </div>
      ) : null}
      <div data-zone="image" className="dc-img relative flex items-center justify-center">
        {image}
      </div>
      {has(left) || has(right) ? (
        <div data-zone="right" className="dc-right flex min-w-0 flex-col items-center gap-2">
          {right}
        </div>
      ) : null}
      {hasRows(bottom) ? (
        <div
          data-zone="bottom"
          className="dc-bottom flex w-full min-w-0 max-w-full flex-col items-center gap-2.5 overflow-x-clip"
        >
          {bottom.map((row) => (
            <div
              key={row.key}
              data-row={row.kind}
              className="flex w-full min-w-0 flex-col items-center gap-1"
            >
              {row.label === undefined ? null : (
                <span className="text-xs uppercase tracking-wide text-foreground-subtle">
                  {row.label}
                </span>
              )}
              {row.node}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
