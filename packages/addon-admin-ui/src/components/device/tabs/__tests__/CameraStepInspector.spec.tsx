/// <reference types="@testing-library/jest-dom" />
/**
 * Device → Detection pipeline → Steps (D927): one camera's step tree.
 *
 * A model is chosen by the accelerator that runs it; a camera only turns steps
 * on or off:
 *   - the tree is the catalog hierarchy, with On / Off / Auto on each row;
 *   - no accelerator columns and no model names;
 *   - a line links to Pipeline › Nodes, where models are chosen;
 *   - the panel edits camera-semantic settings only, and says so when a step
 *     has none;
 *   - a confidence floor is not offered on a camera;
 *   - an off ancestor idles its descendants;
 *   - the root-detector pick still gates the tree.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  type FakeHubState,
  freshState,
  makeFakeHub,
  NMS,
  PERSON,
  renderWithHub,
  V9,
} from '../../../pipeline/step-inspector/__tests__/fake-hub'
import { CameraStepInspector } from '../CameraStepInspector'

expect.extend(jestDomMatchers)

async function mount(
  seed?: (s: FakeHubState) => void,
  url = '/devices/101?tab=detection&step=object-detection',
) {
  const state = freshState()
  seed?.(state)
  const hub = makeFakeHub(state)
  render(renderWithHub(<CameraStepInspector deviceId={101} />, hub.link, url))
  await screen.findByRole('list', { name: /detection steps of this camera/i })
  return { state, hub }
}

function row(step: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-step="${step}"]`)
  if (el === null) throw new Error(`no step ${step}`)
  return el
}

function field(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-field-key="${key}"]`)
  if (el === null) throw new Error(`no field ${key}`)
  return el
}

describe('CameraStepInspector', () => {
  it('lists steps with On / Off / Auto and no model names', async () => {
    await mount((s) => {
      s.camera = { stepToggles: { 'plate-detection': false } }
    }, '/devices/101?tab=detection')
    expect(screen.queryByRole('complementary', { name: 'Step settings' })).toBeNull()
    const plate = row('plate-detection')
    expect(within(plate).getByRole('radio', { name: 'Off' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(within(plate).getByText('cropper')).toBeTruthy()
    expect(plate.textContent).toMatch(/vehicle/)
    expect(screen.queryByText(V9)).toBeNull()
    expect(screen.queryByText(/yunet/i)).toBeNull()
    expect(document.querySelector('[data-col]')).toBeNull()
  })

  it('points at Pipeline › Nodes and has no model box (D927)', async () => {
    await mount()
    expect(screen.queryByRole('region', { name: 'Model' })).toBeNull()
    expect(screen.getByTestId('accelerator-only-thresholds').textContent).toMatch(
      /confidence thresholds/i,
    )
    const link = screen.getByRole('link', { name: /pipeline › nodes/i })
    expect(link.getAttribute('href')).toBe('/system/pipeline?view=nodes')
    expect(screen.getByText(/chosen by the accelerators that run this camera/i)).toBeTruthy()
  })

  it('a child of an off step stays off because its parent is off', async () => {
    await mount((s) => {
      s.camera = { stepToggles: { 'object-detection': false, 'face-detection': true } }
    }, '/devices/101?tab=detection')
    const face = row('face-detection')
    expect(face).toHaveAttribute('data-runs', 'no')
    expect(face).toHaveTextContent(/off because its parent is off/i)
    expect(within(face).getByRole('radio', { name: 'On' })).toHaveAttribute('aria-checked', 'true')
  })

  it('a camera-wide edit is ONE field-level write of a camera-semantic field', async () => {
    const { state, hub } = await mount()
    const footer = screen.getByRole('button', { name: 'Save' }).closest('footer')
    expect(footer).toHaveTextContent('Applies to: all accelerators of this camera.')
    fireEvent.change(within(field(NMS)).getByRole('slider'), { target: { value: '0.6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(hub.calls).toHaveLength(1))
    expect(hub.calls[0]?.path).toBe('pipelineOrchestrator.setCameraStepSettings')
    expect(state.camera.stepSettings?.['object-detection']).toEqual({ [NMS]: 0.6 })
  })

  it("a confidence floor is not offered on a camera — it is the accelerator's (D927)", async () => {
    await mount()
    expect(document.querySelector(`[data-field-key="${PERSON}"]`)).toBeNull()
    expect(screen.getByTestId('accelerator-only-thresholds')).toBeInTheDocument()
  })

  it('names the layer of each value and the level below it', async () => {
    await mount((s) => {
      s.camera = { stepSettings: { 'object-detection': { [NMS]: 0.6 } } }
    })
    expect(within(field(NMS)).getByTestId('setting-source')).toHaveTextContent('This camera')
    expect(within(field(NMS)).getByTestId('setting-levels')).toHaveTextContent('Node 0.5')
  })

  it('the gate is written at once', async () => {
    const { hub } = await mount()
    const gate = within(row('object-detection')).getByRole('radiogroup', {
      name: /runs on this camera/i,
    })
    fireEvent.click(within(gate).getByRole('radio', { name: 'Off' }))
    await waitFor(() => expect(hub.calls[0]?.path).toBe('pipelineOrchestrator.setCameraStepToggle'))
    expect(hub.calls[0]?.input).toMatchObject({ addonId: 'object-detection', enabled: false })
  })

  it('a step with no camera settings says so — no model row', async () => {
    await mount(undefined, '/devices/101?tab=detection&step=face-embedding')
    const region = screen.getByRole('region', { name: 'Face Embedding · this camera' })
    expect(region).toHaveTextContent(/no settings on this camera/i)
    expect(within(region).queryByRole('region', { name: 'Model' })).toBeNull()
    expect(screen.queryByRole('button', { name: /change model for/i })).toBeNull()
  })

  it('a step offers no "This accelerator" scope — a camera has one layer', async () => {
    await mount()
    expect(screen.queryByRole('radio', { name: 'This accelerator' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Apply to all accelerators' })).toBeNull()
  })
})

/**
 * The root-detector pick lives at the top of the Steps editor, and the steps
 * under it follow it: this node → every step applies; the camera's own
 * detector → the root step is idle (its inference never runs) and the steps
 * below stay editable; none → nothing is detected, so every step under the root
 * is idle. A camera with no onboard detector shows no control at all.
 */
describe('CameraStepInspector — root detector', () => {
  it('a camera with no onboard detector has no control and every step runs', async () => {
    await mount()
    expect(screen.queryByRole('radiogroup', { name: 'Root detector' })).toBeNull()
    expect(row('object-detection')).toHaveAttribute('data-runs', 'yes')
  })

  it('this node: the pick is shown and no step is idle', async () => {
    await mount((s) => {
      s.detectionSource = 'pipeline'
    })
    const group = await screen.findByRole('radiogroup', { name: 'Root detector' })
    expect(within(group).getByRole('radio', { name: 'This node' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(row('object-detection')).toHaveAttribute('data-runs', 'yes')
    expect(screen.queryByText('Camera AI')).toBeNull()
  })

  it('camera onboard AI: the root step is idle with a reason, the steps below stay', async () => {
    await mount((s) => {
      s.detectionSource = 'onboard'
    })
    await screen.findByRole('radiogroup', { name: 'Root detector' })
    await waitFor(() => expect(row('object-detection')).toHaveAttribute('data-runs', 'no'))
    expect(row('object-detection')).toHaveTextContent('Camera AI')
    expect(row('face-detection')).toHaveAttribute('data-runs', 'yes')
    expect(screen.queryByText(/yunet/i)).toBeNull()
    fireEvent.click(screen.getByText('Camera AI'))
    expect(await screen.findByRole('note')).toHaveTextContent(
      /this node's root step is never asked/i,
    )
    expect(document.querySelector('[data-field-key]')).not.toBeNull()
  })

  it('none: every step under the root is idle', async () => {
    await mount((s) => {
      s.detectionSource = 'none'
    })
    await screen.findByRole('radiogroup', { name: 'Root detector' })
    await waitFor(() => expect(row('object-detection')).toHaveTextContent('No root'))
    for (const step of ['face-detection', 'plate-detection', 'face-embedding']) {
      expect(row(step)).toHaveAttribute('data-runs', 'no')
      expect(row(step)).toHaveTextContent('Idle')
    }
  })

  it('picking writes through the orchestrator cap, once, and the steps follow', async () => {
    const { state, hub } = await mount((s) => {
      s.detectionSource = 'pipeline'
    })
    const group = await screen.findByRole('radiogroup', { name: 'Root detector' })
    fireEvent.click(within(group).getByRole('radio', { name: 'Camera onboard AI' }))
    await waitFor(() => expect(row('object-detection')).toHaveAttribute('data-runs', 'no'))
    expect(
      hub.calls.filter((c) => c.path === 'pipelineOrchestrator.setCameraDetectionSource'),
    ).toEqual([
      {
        path: 'pipelineOrchestrator.setCameraDetectionSource',
        input: { deviceId: 101, source: 'onboard' },
      },
    ])
    expect(state.detectionSource).toBe('onboard')
  })

  it('keeps the picked value on screen until the server has been re-read', async () => {
    let release: () => void = () => undefined
    const { state } = await mount((s) => {
      s.detectionSource = 'pipeline'
    })
    const group = await screen.findByRole('radiogroup', { name: 'Root detector' })
    state.readGate = new Promise<void>((resolve) => {
      release = resolve
    })
    fireEvent.click(within(group).getByRole('radio', { name: 'Camera onboard AI' }))
    await waitFor(() => expect(state.detectionSource).toBe('onboard'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(within(group).getByRole('radio', { name: 'Camera onboard AI' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(within(group).getByRole('radio', { name: 'This node' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    release()
    await waitFor(() =>
      expect(within(group).getByRole('radio', { name: 'Camera onboard AI' })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    )
  })

  it('a refused write puts the old pick back and says why', async () => {
    await mount((s) => {
      s.detectionSource = 'pipeline'
      s.refuseDetectionSource = 'the camera did not answer'
    })
    const group = await screen.findByRole('radiogroup', { name: 'Root detector' })
    fireEvent.click(within(group).getByRole('radio', { name: 'Camera onboard AI' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('the camera did not answer')
    await waitFor(() =>
      expect(within(group).getByRole('radio', { name: 'This node' })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    )
  })
})
