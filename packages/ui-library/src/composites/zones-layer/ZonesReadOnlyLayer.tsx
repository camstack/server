/**
 * ZonesReadOnlyLayer — the device's configured zones, drawn and not editable.
 *
 * Reads the `zones` state slice of the device through the capability API (the
 * same slice the zone editor subscribes to) and paints it on the shared
 * `MaskShapeCanvas` plane in transparent mode with nothing selectable, so
 * clicks fall through to the picture. Place it inside the image's own rect
 * (StreamPanel does, via `containedImageBox`): the points are fractions of the
 * frame.
 */
import { lazy, Suspense, useMemo } from 'react'
import type { ComponentType, JSX, LazyExoticComponent } from 'react'
import { useSystem } from '../../contexts/system-context'
import { useDeviceProxy, useDeviceStateSlice } from '../../hooks/use-device-proxy'
import type { MaskShapeCanvasProps } from '../cap-settings/MaskShapeCanvas'
import { capZoneToCanvas, zoneToItem, ZONE_SHAPE_KINDS } from './zone-items'

// Konva stays off the first-paint bundle: the canvas loads when the layer shows.
const LazyCanvas: LazyExoticComponent<ComponentType<MaskShapeCanvasProps>> = lazy(() =>
  import('../cap-settings/MaskShapeCanvas').then((m) => ({ default: m.MaskShapeCanvas })),
)

const noSelect = (): void => undefined

export interface ZonesReadOnlyLayerProps {
  readonly deviceId: number
}

export function ZonesReadOnlyLayer({ deviceId }: ZonesReadOnlyLayerProps): JSX.Element | null {
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const slice = useDeviceStateSlice(dev?.state.zones)
  const items = useMemo(() => (slice?.zones ?? []).map(capZoneToCanvas).map(zoneToItem), [slice])
  if (items.length === 0) return null
  return (
    <div className="absolute inset-0 pointer-events-none" data-testid="zones-readonly-layer">
      <Suspense fallback={null}>
        <LazyCanvas
          transparent
          items={items}
          selectedId={null}
          onSelect={noSelect}
          onShapeChange={noSelect}
          onDrawComplete={noSelect}
          drawingKind={null}
          supportedShapes={ZONE_SHAPE_KINDS}
        />
      </Suspense>
    </div>
  )
}
