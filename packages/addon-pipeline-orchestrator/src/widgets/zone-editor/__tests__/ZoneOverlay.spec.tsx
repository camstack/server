// @vitest-environment jsdom
/**
 * Finishing a shape on the zone overlay adds a zone through `zones.addZone`,
 * also where `crypto.randomUUID` does not exist (a hub served over plain
 * http on the LAN is not a secure context), and a rejected save is shown
 * to the operator instead of being logged and dropped.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MaskShape } from '@camstack/types'

interface CanvasProps {
  readonly onDrawComplete: (shape: MaskShape) => void
}

const hoisted = vi.hoisted(() => ({
  canvasProps: { current: null as unknown },
  addZone: vi.fn(),
  setSelectedZoneId: vi.fn(),
  setDrawingKind: vi.fn(),
}))

vi.mock('@camstack/ui-library', () => ({
  MaskShapeCanvas: (props: unknown) => {
    hoisted.canvasProps.current = props
    return null
  },
  useSystem: () => ({ trpcClient: { zones: { addZone: { mutate: hoisted.addZone } } } }),
  // A cluster singleton has no per-device binding entry, so the proxy carries no `zones`.
  useDeviceProxy: () => ({ state: { zones: {} } }),
  useDeviceStateSlice: () => ({ zones: [] }),
  useZoneEditing: () => ({
    drawingKind: 'polygon',
    selectedZoneId: null,
    editingDraft: null,
    setSelectedZoneId: hoisted.setSelectedZoneId,
    setDrawingKind: hoisted.setDrawingKind,
    enterDraft: vi.fn(),
    discardDraft: vi.fn(),
    updateDraft: vi.fn(),
  }),
}))

import { ZoneOverlay } from '../ZoneOverlay'

const POLYGON: MaskShape = {
  kind: 'polygon',
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.5, y: 0.1 },
    { x: 0.3, y: 0.5 },
  ],
}

async function finishShape(): Promise<void> {
  const props = hoisted.canvasProps.current as CanvasProps
  await act(async () => {
    props.onDrawComplete(POLYGON)
  })
}

describe('ZoneOverlay draw completion', () => {
  beforeEach(() => {
    hoisted.addZone.mockReset()
    hoisted.addZone.mockResolvedValue(undefined)
    hoisted.setSelectedZoneId.mockReset()
    hoisted.setDrawingKind.mockReset()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('adds the drawn polygon as a zone when the device proxy has no zones entry', async () => {
    render(<ZoneOverlay deviceId={1} />)
    await finishShape()
    expect(hoisted.addZone).toHaveBeenCalledTimes(1)
    const sent = hoisted.addZone.mock.calls[0]?.[0] as {
      zone: { kind: string; polygon: unknown[] }
    }
    expect(sent.zone.kind).toBe('polygon')
    expect(sent.zone.polygon).toHaveLength(3)
  })

  it('still adds the zone when crypto.randomUUID is unavailable (insecure context)', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    })
    render(<ZoneOverlay deviceId={1} />)
    await finishShape()
    expect(hoisted.addZone).toHaveBeenCalledTimes(1)
    const sent = hoisted.addZone.mock.calls[0]?.[0] as { zone: { id: string } }
    expect(sent.zone.id.length).toBeGreaterThan(0)
  })

  it('shows the error when the save is rejected', async () => {
    hoisted.addZone.mockRejectedValue(new Error('zones.addZone: boom'))
    render(<ZoneOverlay deviceId={1} />)
    await finishShape()
    expect(screen.getByRole('alert').textContent).toContain('boom')
  })
})
