// @vitest-environment jsdom
/**
 * Step 1 on screen: the pipeline's boxes open as DRAFTS — painted apart from
 * what the operator decided, with an Accept control, and a model-error path.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { boxLook } from '../lib/retrain-box-look'
import { seedEditor } from '../lib/retrain-editor'
import { fallbackKind } from '../lib/retrain-live-review'
import { RetrainAnnotationEditor } from '../RetrainAnnotationEditor'

const state = seedEditor(
  [
    {
      id: 'a',
      trackId: 't',
      deviceId: 101,
      mediaKey: 'f',
      bbox: { x: 0, y: 0, w: 0.2, h: 0.2 },
      macroClass: 'person',
      kind: 'subject',
      source: 'operator',
      createdAt: 1,
    },
  ],
  [
    {
      bbox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
      macroClass: 'person',
      trackId: 'other',
      basis: 'subject-box',
      deltaMs: 0,
      score: 0.61,
      modelId: 'yolov9m-320',
    },
  ],
)

describe('pipeline drafts on the Retrain page', () => {
  it('paints a pipeline draft differently from a confirmed subject', () => {
    const [confirmed, draft] = state.boxes
    const solid = boxLook(fallbackKind(confirmed!))
    const proposal = boxLook(fallbackKind(draft!))
    expect(solid.strokeStyle).toBe('solid')
    expect(proposal.strokeStyle).toBe('dashed')
    expect(proposal.stroke).not.toBe(solid.stroke)
    expect(proposal.stroke).toContain('--color-primary')
  })

  it('a model error is always the danger colour, draft or not', () => {
    const draft = state.boxes[1]!
    expect(boxLook(fallbackKind({ ...draft, draft: false, kind: 'model_error' })).stroke).toContain(
      '--color-danger',
    )
  })

  it('offers Accept on a draft only, and names its provenance', () => {
    const onAccept = vi.fn()
    const onToggleModelError = vi.fn()
    const draftKey = state.boxes[1]!.key
    render(
      <RetrainAnnotationEditor
        boxes={state.boxes}
        selectedKey={draftKey}
        onSelect={() => undefined}
        onChange={() => undefined}
        onAccept={onAccept}
        onToggleModelError={onToggleModelError}
        onDelete={() => undefined}
      />,
    )
    const accepts = screen.getAllByRole('button', { name: 'Accept this proposal' })
    expect(accepts).toHaveLength(1)
    expect(screen.getByText('pipeline · yolov9m-320 · 0.61')).toBeTruthy()
    fireEvent.click(accepts[0]!)
    expect(onAccept).toHaveBeenCalledWith(draftKey)
    fireEvent.click(screen.getByRole('button', { name: /Mark as model error/ }))
    expect(onToggleModelError).toHaveBeenCalledWith(draftKey)
  })

  it('a row is one line until it is selected: the edit fields appear on demand', () => {
    const common = {
      boxes: state.boxes,
      onSelect: () => undefined,
      onChange: () => undefined,
      onAccept: () => undefined,
      onToggleModelError: () => undefined,
      onDelete: () => undefined,
    }
    const { rerender } = render(<RetrainAnnotationEditor {...common} selectedKey={null} />)
    expect(screen.queryByLabelText('Label')).toBeNull()
    rerender(<RetrainAnnotationEditor {...common} selectedKey={state.boxes[0]!.key} />)
    expect(screen.getAllByLabelText('Label')).toHaveLength(1)
  })
})
