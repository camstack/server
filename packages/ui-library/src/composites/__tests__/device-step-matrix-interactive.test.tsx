// @vitest-environment jsdom
/**
 * D757 — the step matrix is THE view again, and an interactive one:
 *   - one Tab stop over step headers and cells; arrows / Home / End move it;
 *   - a cell click opens that (step, accelerator), saying whether the keyboard did it
 *     (the host then moves focus into its panel); a step header opens the step;
 *   - a "—" cell is focusable (the grid has no holes) but opens nothing;
 *   - a closing panel can hand focus back to its cell (`focusCell`);
 *   - each column header names the accelerator, its format, its elected model,
 *     and "off" for a switched-off one;
 *   - a docked panel's width becomes a trailing spacer — the grid itself never
 *     shrinks, so opening the panel reflows nothing.
 */
import { createRef } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DeviceStepMatrix,
  type DeviceStepMatrixHandle,
  type DeviceStepMatrixProps,
  nextGridPosition,
} from '../device-step-matrix'
import type { AgentColumn, CellState } from '../pipeline-matrix-shared'
import type { StepTreeNode } from '../step-tree'

const TREE: readonly StepTreeNode[] = [
  {
    addonId: 'object-detection',
    addonName: 'Object Detection',
    slot: 'detector',
    inputClasses: [],
    outputClasses: ['person'],
    children: [
      {
        addonId: 'face-detection',
        addonName: 'Face Detection',
        slot: 'cropper',
        inputClasses: ['person'],
        outputClasses: ['face'],
        children: [],
      },
    ],
  },
]

const AGENTS: readonly AgentColumn[] = [
  {
    agentNodeId: 'hub',
    nodeLabel: 'hub',
    engineLabel: 'openvino',
    deviceKey: 'openvino:gpu',
    deviceLabel: 'Intel iGPU',
    detail: 'yolov9m-320-int8',
  },
  {
    agentNodeId: 'hub',
    nodeLabel: 'hub',
    engineLabel: 'openvino',
    deviceKey: 'openvino:npu',
    deviceLabel: 'Intel NPU',
    detail: 'yolov9m-320-int8',
  },
  {
    agentNodeId: 'hub',
    nodeLabel: 'hub',
    engineLabel: 'onnx',
    deviceKey: 'cpu',
    deviceLabel: 'CPU',
    disabled: true,
  },
]

function cellState(addonId: string, a: AgentColumn): CellState {
  if (a.deviceKey === 'cpu' && addonId === 'face-detection') return { kind: 'na' }
  return { kind: 'enabled', modelId: `${addonId}@${a.deviceKey}` }
}

function setup(overrides: Partial<DeviceStepMatrixProps> = {}) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1400,
    height: 0,
    top: 0,
    left: 0,
    right: 1400,
    bottom: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
  const onCellClick = vi.fn()
  const onStepClick = vi.fn()
  const ref = createRef<DeviceStepMatrixHandle>()
  const utils = render(
    <DeviceStepMatrix
      ref={ref}
      tree={TREE}
      agents={AGENTS}
      getCellState={cellState}
      onCellClick={onCellClick}
      onStepClick={onStepClick}
      selectedCell={null}
      fallbackNodeId={null}
      onFallbackNodeChange={() => {}}
      {...overrides}
    />,
  )
  return { onCellClick, onStepClick, ref, ...utils }
}

const at = (r: number, c: number): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`)
  if (el === null) throw new Error(`no cell ${r}:${c}`)
  return el
}

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('DeviceStepMatrix — interactive table (D757)', () => {
  it('is a grid with ONE Tab stop that arrows, Home and End move', () => {
    setup()
    const grid = screen.getByRole('grid', { name: 'Detection steps' })
    expect(
      within(grid)
        .getAllByRole('button')
        .filter((b) => b.tabIndex === 0),
    ).toHaveLength(1)
    at(0, 0).focus()
    fireEvent.keyDown(at(0, 0), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(at(0, 1))
    fireEvent.keyDown(at(0, 1), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(at(1, 1))
    fireEvent.keyDown(at(1, 1), { key: 'End' })
    expect(document.activeElement).toBe(at(1, 3))
    fireEvent.keyDown(at(1, 3), { key: 'Home' })
    expect(document.activeElement).toBe(at(1, 0))
    expect(at(1, 0).tabIndex).toBe(0)
    expect(at(0, 0).tabIndex).toBe(-1)
  })

  it('a cell opens its (step, accelerator); a step header opens the step', () => {
    const { onCellClick, onStepClick } = setup()
    // A pointer click (detail 1) …
    fireEvent.click(at(0, 2), { detail: 1 })
    expect(onCellClick).toHaveBeenLastCalledWith('object-detection', AGENTS[1], false)
    // … and Enter / Space on the focused button (a click with detail 0).
    fireEvent.click(at(0, 2), { detail: 0 })
    expect(onCellClick).toHaveBeenLastCalledWith('object-detection', AGENTS[1], true)
    fireEvent.click(at(1, 0), { detail: 1 })
    expect(onStepClick).toHaveBeenLastCalledWith('face-detection', false)
  })

  it('a "—" cell is focusable but opens nothing', () => {
    const { onCellClick } = setup()
    const na = at(1, 3)
    expect(na.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(na)
    expect(onCellClick).not.toHaveBeenCalled()
  })

  it('focusCell hands focus back to a cell, or to the step header', () => {
    const { ref } = setup()
    ref.current?.focusCell('face-detection', 'hub::openvino:npu')
    expect(document.activeElement).toBe(at(1, 2))
    ref.current?.focusCell('object-detection', null)
    expect(document.activeElement).toBe(at(0, 0))
  })

  it('column headers name the accelerator, its format, its model, and "off"', () => {
    setup()
    const headers = screen.getAllByRole('columnheader')
    const text = headers.map((h) => h.textContent).join(' | ')
    expect(text).toMatch(/Intel iGPU/)
    expect(text).toMatch(/yolov9m-320-int8/)
    expect(text).toMatch(/CPU\s*off/)
  })

  it('a docked panel adds a trailing spacer; the grid keeps its columns', () => {
    const { container, rerender } = setup()
    const grid = screen.getByRole('grid')
    const template = grid.style.gridTemplateColumns
    expect(container.querySelector('[aria-hidden][style*="width: 432px"]')).toBeNull()
    rerender(
      <DeviceStepMatrix
        tree={TREE}
        agents={AGENTS}
        getCellState={cellState}
        onCellClick={() => {}}
        selectedCell={{
          addonId: 'object-detection',
          agentNodeId: 'hub',
          deviceKey: 'openvino:npu',
        }}
        fallbackNodeId={null}
        onFallbackNodeChange={() => {}}
        reserveRightPx={432}
      />,
    )
    expect(container.querySelector('[aria-hidden][style*="width: 432px"]')).not.toBeNull()
    expect(screen.getByRole('grid').style.gridTemplateColumns).toBe(template)
    expect(at(0, 2).getAttribute('aria-selected')).toBe('true')
  })
})

describe('nextGridPosition', () => {
  it('clamps at the edges and ignores other keys', () => {
    expect(nextGridPosition('ArrowLeft', { r: 0, c: 0 }, 3, 4)).toEqual({ r: 0, c: 0 })
    expect(nextGridPosition('ArrowDown', { r: 2, c: 1 }, 3, 4)).toEqual({ r: 2, c: 1 })
    expect(nextGridPosition('PageDown', { r: 0, c: 1 }, 3, 4)).toEqual({ r: 2, c: 1 })
    expect(nextGridPosition('a', { r: 0, c: 0 }, 3, 4)).toBeNull()
  })
})
