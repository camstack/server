// @vitest-environment jsdom
/**
 * Cluster-owned admission knobs must not appear on the per-(node,device)
 * editor. The overlay would ignore a write here, which is a second store
 * dressed as a working slider.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { PipelineAddonSchema, DeviceStepConfig } from '@camstack/types'
import { AgentStepEditor } from '../agent-step-editor'

const FACE_EMBEDDING: PipelineAddonSchema = {
  id: 'face-embedding',
  name: 'Face Embedding',
  slot: 'classifier',
  inputClasses: ['face'],
  outputClasses: ['identity'],
  childSlots: [],
  models: [
    {
      id: 'arcface-r100',
      name: 'ArcFace R100',
      formats: { onnx: { downloaded: true, sizeMB: 250 } },
    },
  ],
  defaultModelId: 'arcface-r100',
  defaultConfidence: 0,
  configSchema: [
    {
      type: 'slider',
      key: 'minLandmarkFaceSize',
      label: 'Min face size for recognition (detection px)',
      min: 0,
      max: 64,
      step: 2,
      default: 24,
    },
  ],
}

const noPin: DeviceStepConfig = { settings: {} }

afterEach(() => {
  cleanup()
})

describe('AgentStepEditor — cluster-owned settings stay off this surface', () => {
  it('does not render minLandmarkFaceSize; points at Cluster → Settings instead', () => {
    render(<AgentStepEditor addon={FACE_EMBEDDING} agentDefault={noPin} engineFormat="onnx" />)
    expect(screen.queryByText('Min face size for recognition (detection px)')).toBeNull()
    expect(screen.getByText(/Pipeline → Cluster → Settings → Enrichment models/)).toBeTruthy()
  })
})
