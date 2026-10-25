/// <reference types="@testing-library/jest-dom" />
/**
 * Pipeline → node → Pipeline (D757): the node's base for each step — the
 * steps × accelerators TABLE, and the clicked cell's settings in a docked panel.
 *
 *   - the panel is about what was clicked: a cell = that step on THAT
 *     accelerator (its title says so, one model row, no accelerator picker);
 *     a step header = the step on the node, models read-only;
 *   - a model change writes ONLY that accelerator's pin, and Save keeps the
 *     selection (the slide-over closed on save);
 *   - settings (D927): node-wide content is ONE write of the node layer
 *     (`setNodeStepSettings`); a confidence floor is the clicked accelerator's
 *     own, written on its entry alone — a sibling entry is never read;
 *   - the search finds a step by a field label, and a cluster-owned knob links
 *     to where it is edited;
 *   - the selection lives in the URL.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NodeStepInspector } from '../NodeStepInspector'
import {
  currentSearch,
  type FakeHubState,
  freshState,
  makeFakeHub,
  NMS,
  PERSON,
  renderWithHub,
  Y26,
} from './fake-hub'

expect.extend(jestDomMatchers)

async function mount(url = '/system/pipeline?node=hub', seed?: (s: FakeHubState) => void) {
  const state = freshState()
  seed?.(state)
  const hub = makeFakeHub(state)
  render(renderWithHub(<NodeStepInspector nodeId="hub" nodeName="hub" />, hub.link, url))
  await screen.findByRole('grid', { name: 'Detection steps' })
  return { state, hub }
}

/** The matrix cell of (step, column) — `col` = `${node}::${deviceKey}`, '' = the step header. */
function cell(step: string, col: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-step="${step}"][data-col="${col}"]`)
  if (el === null) throw new Error(`no cell ${step} ${col}`)
  return el
}

/** Open Object Detection on the NPU, the way an operator does: click its cell. */
const NPU_TITLE = 'Object Detection · hub · Intel NPU'

async function openDetectorOnNpu(): Promise<void> {
  fireEvent.click(cell('object-detection', 'hub::openvino:npu'))
  await screen.findByRole('region', { name: NPU_TITLE })
}

function inspector(): HTMLElement {
  return screen.getByRole('region', { name: /^(object detection|face|plate)/i })
}

describe('NodeStepInspector', () => {
  it('the matrix shows one column per ENABLED accelerator; the toggle adds the disabled ones', async () => {
    await mount()
    const headers = screen
      .getAllByRole('columnheader')
      .map((h) => h.textContent ?? '')
      .join(' | ')
    expect(headers).toMatch(/Intel iGPU/)
    expect(headers).toMatch(/Intel NPU/)
    expect(headers).not.toMatch(/CPU/)
    fireEvent.click(screen.getByRole('checkbox', { name: /show disabled accelerators \(1\)/i }))
    const after = screen
      .getAllByRole('columnheader')
      .map((h) => h.textContent ?? '')
      .join(' | ')
    expect(after).toMatch(/CPU\s*off/)
  })

  it('a cell opens its step on its accelerator, docked; Escape closes and returns to the cell', async () => {
    await mount()
    await openDetectorOnNpu()
    expect(currentSearch).toMatch(/step=object-detection/)
    expect(currentSearch).toMatch(/acc=hub%2Fopenvino%3Anpu/)
    expect(screen.getByRole('complementary', { name: 'Step settings' })).toBeInTheDocument()
    // The grid did not change under the panel: every column is still there.
    expect(cell('object-detection', 'hub::openvino:gpu')).toBeInTheDocument()
    fireEvent.keyDown(inspector(), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('region', { name: NPU_TITLE })).toBeNull())
    expect(currentSearch).not.toMatch(/step=/)
    await waitFor(() =>
      expect(document.activeElement).toBe(cell('object-detection', 'hub::openvino:npu')),
    )
  })

  it('a step header opens the STEP on the node: no accelerator, models read-only', async () => {
    await mount('/system/pipeline?node=hub&acc=hub%2Fopenvino%3Anpu')
    fireEvent.click(cell('plate-detection', ''))
    const region = await screen.findByRole('region', { name: 'Plate Detection · hub' })
    // A stale `acc` does not survive the step view.
    expect(currentSearch).not.toMatch(/acc=/)
    const model = within(region).getByRole('region', { name: 'Model' })
    expect(within(model).getByTestId('effective-models')).toBeInTheDocument()
    expect(within(model).getByText(/hub · Intel iGPU/)).toBeInTheDocument()
    expect(within(model).getByText(/hub · Intel NPU/)).toBeInTheDocument()
    expect(within(model).queryByRole('button', { name: /change model/i })).toBeNull()
  })

  it('a cell is about THAT accelerator only: its title, one model row, no accelerator picker', async () => {
    await mount()
    await openDetectorOnNpu()
    const region = inspector()
    expect(within(region).getByRole('heading', { level: 2 })).toHaveTextContent(NPU_TITLE)
    expect(within(region).queryByRole('tablist', { name: 'Accelerator' })).toBeNull()
    const model = within(region).getByRole('region', { name: 'Model' })
    expect(
      within(model).getByRole('button', { name: /change model for hub · Intel NPU/i }),
    ).toBeInTheDocument()
    expect(within(model).queryByText(/hub · Intel iGPU/)).toBeNull()
    expect(within(model).queryByText(/CPU/)).toBeNull()
    // Settings on a node are node-wide, and say so in one line.
    expect(within(region).getByTestId('settings-scope')).toHaveTextContent(
      'Node-wide: these settings apply on every accelerator of hub.',
    )
  })

  it('a model change writes only that accelerator, and Save keeps the step open', async () => {
    const { state, hub } = await mount()
    await openDetectorOnNpu()
    fireEvent.click(screen.getByRole('button', { name: /change model for hub · Intel NPU/i }))
    fireEvent.change(await screen.findByDisplayValue('YOLOv9 M 320'), { target: { value: Y26 } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(hub.calls).toHaveLength(1))
    const npu = state.devices.hub?.find((d) => d.key === 'openvino:npu')
    const gpu = state.devices.hub?.find((d) => d.key === 'openvino:gpu')
    expect(npu?.steps?.['object-detection']?.modelId).toBe(Y26)
    expect(gpu?.steps?.['object-detection']?.modelId).toBeUndefined()
    // The step stays selected, the save bar says so.
    expect(inspector()).toHaveTextContent(NPU_TITLE)
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })

  it('node-wide settings are ONE write of the node layer — no device entry touched', async () => {
    const { state, hub } = await mount()
    await openDetectorOnNpu()
    const settings = within(inspector()).getByRole('region', { name: 'Settings' })
    const nms = settings.querySelector<HTMLElement>(`[data-field-key="${NMS}"]`)
    if (nms === null) throw new Error('no NMS field')
    expect(within(nms).getByTestId('setting-source')).toHaveTextContent('Node')
    fireEvent.change(within(nms).getByRole('slider'), { target: { value: '0.6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(hub.calls).toHaveLength(1))
    expect(hub.calls[0]?.path).toBe('pipelineOrchestrator.setNodeStepSettings')
    expect(state.nodeStepSettings.hub?.['object-detection']).toEqual({ [NMS]: 0.6 })
    expect(
      (state.devices.hub ?? []).filter(
        (d) => d.steps?.['object-detection']?.settings !== undefined,
      ),
    ).toEqual([])
  })

  it("a confidence floor is the clicked accelerator's own — written on its entry alone", async () => {
    const { state, hub } = await mount()
    await openDetectorOnNpu()
    const floor = document.querySelector<HTMLElement>(`[data-field-key="${PERSON}"]`)
    if (floor === null) throw new Error('no person floor')
    fireEvent.change(within(floor).getByRole('slider'), { target: { value: '0.75' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(hub.calls).toHaveLength(1))
    expect(hub.calls[0]?.path).toBe('pipelineOrchestrator.setAgentInferenceDevices')
    const holders = (state.devices.hub ?? []).filter(
      (d) => d.steps?.['object-detection']?.settings !== undefined,
    )
    expect(holders.map((d) => d.key)).toEqual(['openvino:npu'])
    expect(holders[0]?.steps?.['object-detection']?.settings).toMatchObject({ [PERSON]: 0.75 })
  })

  it('the step view sets no floor — it says floors are per accelerator', async () => {
    await mount('/system/pipeline?node=hub&step=object-detection')
    expect(document.querySelector(`[data-field-key="${PERSON}"]`)).toBeNull()
    expect(screen.getByTestId('accelerator-settings-hint')).toBeInTheDocument()
  })

  it('the filter finds a step by a field label, and a cluster-owned knob links to its page', async () => {
    await mount()
    const search = screen.getByRole('searchbox', { name: /filter steps or settings/i })
    fireEvent.change(search, { target: { value: 'face size' } })
    // Rows narrow to the hit and the steps above it.
    expect(document.querySelector('[data-step="plate-detection"]')).toBeNull()
    expect(cell('face-embedding', '')).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'Enter' })
    const region = await screen.findByRole('region', { name: 'Face Embedding · hub' })
    const [link] = within(region).getAllByRole('link', { name: /cluster → settings/i })
    if (link === undefined) throw new Error('no link to Cluster → Settings')
    expect(link.getAttribute('href')).toMatch(/ctab=settings/)
    // The face encoder and its size floor are edited on the Faces & recognition card.
    expect(link.getAttribute('href')).toMatch(/section=faces/)
    expect(currentSearch).toMatch(/step=face-embedding/)
  })

  it('opens the step and accelerator the URL names', async () => {
    await mount('/system/pipeline?node=hub&step=plate-detection&acc=hub%2Fopenvino%3Anpu')
    expect(
      screen.getByRole('region', { name: 'Plate Detection · hub · Intel NPU' }),
    ).toBeInTheDocument()
    expect(cell('plate-detection', 'hub::openvino:npu').getAttribute('aria-selected')).toBe('true')
  })

  it('arrows move across the cells; Enter opens into the panel; Escape on the cell closes it', async () => {
    await mount()
    const first = cell('object-detection', '')
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    fireEvent.keyDown(document.activeElement ?? first, { key: 'ArrowRight' })
    const npu = cell('object-detection', 'hub::openvino:npu')
    expect(document.activeElement).toBe(npu)
    // Enter on a native button is a click with detail 0: focus follows into the panel.
    fireEvent.click(npu, { detail: 0 })
    const region = await screen.findByRole('region', { name: NPU_TITLE })
    await waitFor(() =>
      expect(document.activeElement).toBe(within(region).getByRole('heading', { level: 2 })),
    )
    // A pointer click keeps focus on the matrix; Escape there closes the panel.
    fireEvent.click(cell('face-detection', 'hub::openvino:npu'), { detail: 1 })
    await screen.findByRole('region', { name: 'Face Detection · hub · Intel NPU' })
    fireEvent.keyDown(cell('face-detection', 'hub::openvino:npu'), { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /^Face Detection/ })).toBeNull(),
    )
  })
})
