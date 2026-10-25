/**
 * The block directly under the device's hero card (D915): one section per
 * `hero` widget the device's capabilities declare — the Consumables panel for
 * every device bound to `consumables`, whatever its type. It sits in the same
 * hero slot of the page (left column on desktop, first row on a phone), so it
 * is in view on every tab. Each widget brings its own card; this block only
 * stacks them and points each at the device it belongs to (a container's
 * primary child for a promoted widget). Renders nothing when the device
 * declares none.
 */
import { DeviceContextProvider, WidgetSlot } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import type { HeroWidget } from './hero-widgets'

export interface DeviceHeroWidgetsProps {
  /** The page's device — a widget for another id (a promoted child) gets its own context. */
  readonly deviceId: number
  readonly widgets: readonly HeroWidget[]
}

export function DeviceHeroWidgets({ deviceId, widgets }: DeviceHeroWidgetsProps): ReactNode {
  if (widgets.length === 0) return null
  return (
    <div
      className="flex flex-col gap-3 px-3 pb-3 sm:px-4 sm:pb-4"
      data-testid="device-hero-widgets"
    >
      {widgets.map((widget) => {
        const slot = <WidgetSlot widgetId={widget.widgetId} deviceId={widget.deviceId} />
        return (
          <div key={widget.widgetId}>
            {widget.deviceId === deviceId ? (
              slot
            ) : (
              <DeviceContextProvider deviceId={widget.deviceId}>{slot}</DeviceContextProvider>
            )}
          </div>
        )
      })}
    </div>
  )
}
