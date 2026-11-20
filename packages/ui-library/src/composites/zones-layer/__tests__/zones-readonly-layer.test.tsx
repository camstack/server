// @vitest-environment jsdom
import { cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MaskShapeCanvasProps } from '../../cap-settings/MaskShapeCanvas'

const slice = vi.hoisted(() => ({ value: undefined as { zones: unknown[] } | undefined }))

vi.mock('../../../contexts/system-context', () => ({ useSystem: () => ({ trpcClient: {} }) }))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({ state: { zones: {} } }),
  useDeviceStateSlice: () => slice.value,
}))
vi.mock('../../cap-settings/MaskShapeCanvas', () => ({
  MaskShapeCanvas: (props: MaskShapeCanvasProps) => (
    <div
      data-testid="canvas"
      data-selected={String(props.selectedId)}
      data-drawing={String(props.drawingKind)}
      data-kinds={props.items.map((i) => i.shape.kind).join(',')}
    />
  ),
}))

import { useDeviceHasZones, ZonesReadOnlyLayer } from '../ZonesReadOnlyLayer'

afterEach(cleanup)

describe('ZonesReadOnlyLayer', () => {
  it('draws the stored zones on the shared plane with nothing selectable', async () => {
    slice.value = {
      zones: [
        {
          id: 'a',
          name: 'Yard',
          kind: 'polygon',
          color: '',
          polygon: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
          ],
        },
        {
          id: 'b',
          name: 'Gate',
          kind: 'tripwire',
          color: '#fff',
          polygon: [
            { x: 0, y: 0.5 },
            { x: 1, y: 0.5 },
          ],
        },
      ],
    }
    render(<ZonesReadOnlyLayer deviceId={7} />)
    const canvas = await screen.findByTestId('canvas')
    expect(canvas.dataset['kinds']).toBe('polygon,line')
    expect(canvas.dataset['selected']).toBe('null')
    expect(canvas.dataset['drawing']).toBe('null')
  })

  it('renders nothing for a device without zones', () => {
    slice.value = { zones: [] }
    const { container } = render(<ZonesReadOnlyLayer deviceId={7} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('useDeviceHasZones', () => {
  it('is false for no slice and for an empty one, true once a zone exists', () => {
    slice.value = undefined
    expect(renderHook(() => useDeviceHasZones(7)).result.current).toBe(false)
    slice.value = { zones: [] }
    expect(renderHook(() => useDeviceHasZones(7)).result.current).toBe(false)
    slice.value = { zones: [{ id: 'a' }] }
    expect(renderHook(() => useDeviceHasZones(7)).result.current).toBe(true)
  })
})
