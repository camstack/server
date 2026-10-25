// @vitest-environment jsdom
/**
 * The two assist engines on screen, over stubbed cap hooks (no model is ever
 * called): the teacher runs on the camera's detection node with the larger
 * model, the AI's boxes and reviews land as drafts and flags, and a cloud
 * profile asks before the frame leaves the house — every run.
 */
import type {
  PipelineSchema,
  RetrainAssistProfile,
  RetrainFrame,
  RetrainLlmAssistResult,
} from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { seedEditor } from '../lib/retrain-editor'

const FRAME: RetrainFrame = {
  frameId: 'retrain:rec:101:abcd',
  deviceId: 101,
  origin: 'recording',
  sourceKind: 'fullFrame',
  sizeBytes: 1,
  width: 1920,
  height: 1080,
  copiedAt: 1,
  complete: false,
}

const SCHEMA: PipelineSchema = {
  availableEngines: [],
  selectedEngine: { runtime: 'python', backend: 'coreml', format: 'coreml' },
  slots: [
    {
      id: 'detector',
      label: 'Detector',
      priority: 0,
      parentSlot: null,
      addons: [
        {
          id: 'object-detection',
          name: 'Object Detection',
          slot: 'detector',
          inputClasses: [],
          outputClasses: ['person'],
          childSlots: [],
          defaultModelId: 'yolo26n',
          defaultConfidence: 0.5,
          models: [
            {
              id: 'yolov9m-320',
              name: 'YOLOv9m',
              formats: { coreml: { downloaded: true, sizeMB: 40 } },
            },
            {
              id: 'yolo26l',
              name: 'YOLO26 Large',
              formats: { coreml: { downloaded: false, sizeMB: 48 } },
            },
          ],
        },
      ],
    },
  ],
}

let profiles: readonly RetrainAssistProfile[] = []
const teacherCall = vi.fn(async (_input: Record<string, unknown>) => ({
  kind: 'proposed' as const,
  modelId: 'yolo26l',
  stepId: 'object-detection',
  minScore: 0.25,
  belowThreshold: 0,
  proposals: [
    {
      bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.4 },
      macroClass: 'person' as const,
      kind: 'subject' as const,
      source: 'assist' as const,
      assistModelId: 'yolo26l',
      assistScore: 0.41,
    },
  ],
}))
const llmCall = vi.fn(
  async (input: { boxes: ReadonlyArray<{ ref: string }> }): Promise<RetrainLlmAssistResult> => ({
    kind: 'proposed',
    profileId: 'p',
    model: 'qwen3-vl',
    leftHouse: false,
    proposals: [
      {
        bbox: { x: 0.6, y: 0.6, w: 0.1, h: 0.2 },
        macroClass: 'person',
        kind: 'subject',
        source: 'llm',
        assistModelId: 'qwen3-vl',
        assistScore: 0.7,
        reason: 'someone by the hedge',
      },
    ],
    reviews: input.boxes.map((b) => ({ ref: b.ref, verdict: 'not-an-object', reason: 'a plant' })),
    rejected: 0,
  }),
)

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    usePipelineAnalyticsListRetrainAssistProfiles: () => ({ data: profiles, isError: false }),
    usePipelineAnalyticsProposeRetrainAnnotations: () => ({
      mutateAsync: (input: Record<string, unknown>) => teacherCall(input),
      isPending: false,
    }),
    usePipelineAnalyticsProposeRetrainAnnotationsWithLlm: () => ({
      mutateAsync: (input: { boxes: ReadonlyArray<{ ref: string }> }) => llmCall(input),
      isPending: false,
    }),
  }
})

const { RetrainAssistPanel } = await import('../RetrainAssistPanel')
const { useRetrainEditorHistory } = await import('../use-retrain-editor-history')

let latest = seedEditor([], [])

function Harness() {
  const history = useRetrainEditorHistory(() => seedEditor([], []))
  latest = history.editor
  return (
    <RetrainAssistPanel
      frame={FRAME}
      history={history}
      detector={{ kind: 'resolved', nodeId: 'mac-mini', modelId: 'yolov9m-320', minScore: 0.5 }}
      schema={SCHEMA}
      setNotice={() => undefined}
    />
  )
}

beforeEach(() => {
  profiles = [
    { id: 'p', name: 'Mac Qwen', model: 'qwen3-vl', kind: 'openai-compatible', leavesHouse: false },
  ]
  teacherCall.mockClear()
  llmCall.mockClear()
  latest = seedEditor([], [])
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.open = false
  }
})

describe('RetrainAssistPanel', () => {
  it('runs the larger detector on the camera’s node, as drafts', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    await waitFor(() => {
      expect(teacherCall).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 101,
          frameId: FRAME.frameId,
          subject: { kind: 'objects', modelId: 'yolo26l', minScore: 0.25 },
          nodeId: 'mac-mini',
        }),
      )
    })
    await waitFor(() => {
      expect(latest.boxes.map((b) => [b.source, b.draft])).toEqual([['assist', true]])
    })
  })

  it('both: the AI reviews the teacher’s boxes, and its own boxes arrive as llm drafts', async () => {
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('Assist engine'), { target: { value: 'both' } })
    fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    await waitFor(() => {
      expect(llmCall).toHaveBeenCalledTimes(1)
    })
    const sent = llmCall.mock.calls[0]?.[0]
    expect(sent?.boxes).toHaveLength(1)
    expect(sent).toMatchObject({ allowCloud: false, profileId: 'p' })
    await waitFor(() => {
      expect(latest.boxes.map((b) => b.source)).toEqual(['assist', 'llm'])
    })
    expect(latest.boxes[0]?.flag).toMatchObject({ verdict: 'not-an-object', by: 'qwen3-vl' })
    expect(latest.boxes[1]?.note).toBe('qwen3-vl: someone by the hedge')
    expect(latest.boxes.every((b) => b.draft)).toBe(true)
  })

  it('a cloud profile is named, and the run asks before the frame leaves', async () => {
    profiles = [{ id: 'p', name: 'Cloud', model: 'vision', kind: 'anthropic', leavesHouse: true }]
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('Assist engine'), { target: { value: 'llm' } })
    expect(screen.getByText(/sends the frame outside your home/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    expect(llmCall).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Send this frame' }))
    await waitFor(() => {
      expect(llmCall).toHaveBeenCalledWith(expect.objectContaining({ allowCloud: true }))
    })
  })
})
