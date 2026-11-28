// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlayerOverlayLayer } from '@dominevo/ui-library'
import { layersNode, splitOverlayLayers } from '../overlay-layers'

afterEach(cleanup)

const ptz: PlayerOverlayLayer = { id: 'ptz', order: 0, node: <i data-testid="ptz" /> }
const zones: PlayerOverlayLayer = {
  id: 'zones',
  order: 100,
  placement: 'image',
  node: <i data-testid="zones" />,
}

describe('splitOverlayLayers', () => {
  it('an unplaced layer is a frame layer; an image layer goes to the image rect', () => {
    const { frame, image } = splitOverlayLayers([ptz, zones])
    expect(frame.map((l) => l.id)).toEqual(['ptz'])
    expect(image.map((l) => l.id)).toEqual(['zones'])
  })

  it('no layers is no node', () => {
    expect(layersNode([])).toBeNull()
    render(<>{layersNode([zones])}</>)
    expect(screen.getByTestId('zones')).toBeTruthy()
  })
})
