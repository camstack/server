import type { ReactNode } from 'react'
import type { PlayerOverlayLayer } from '@dominevo/ui-library'

export interface SplitOverlayLayers {
  readonly frame: readonly PlayerOverlayLayer[]
  readonly image: readonly PlayerOverlayLayer[]
}

/** Registered player layers, by where they are placed: the 16:9 frame or the picture's own rect. */
export function splitOverlayLayers(layers: readonly PlayerOverlayLayer[]): SplitOverlayLayers {
  return {
    frame: layers.filter((l) => l.placement !== 'image'),
    image: layers.filter((l) => l.placement === 'image'),
  }
}

/** Each layer in its own full-size slot, or null when there are none. */
export function layersNode(layers: readonly PlayerOverlayLayer[]): ReactNode {
  if (layers.length === 0) return null
  return (
    <>
      {layers.map((layer) => (
        <div key={layer.id} className="absolute inset-0">
          {layer.node}
        </div>
      ))}
    </>
  )
}
