import type { ReactNode } from 'react'
import { PipelineStep } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg" style={{ width: 480 }}>
    {children}
  </div>
)

const detectorSchema = {
  id: 'object-detection',
  name: 'Object Detection',
  slot: 'detector' as const,
  inputClasses: ['frame'],
  outputClasses: ['person', 'vehicle', 'animal'],
  childSlots: ['cropper'],
  models: [
    {
      id: 'yolov9-c',
      name: 'YOLOv9-C (accurate)',
      formats: { onnx: { downloaded: true, sizeMB: 102 } },
    },
    { id: 'yolov8n', name: 'YOLOv8-N (fast)', formats: { onnx: { downloaded: true, sizeMB: 12 } } },
  ],
  defaultModelId: 'yolov9-c',
  defaultConfidence: 0.4,
  configSchema: [
    {
      key: 'confidence',
      type: 'slider' as const,
      label: 'Confidence threshold',
      description: 'Minimum score for a detection to be kept',
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.4,
      showValue: true,
    },
    {
      key: 'classes',
      type: 'multiselect' as const,
      label: 'Tracked classes',
      options: [
        { value: 'person', label: 'Person' },
        { value: 'vehicle', label: 'Vehicle' },
        { value: 'animal', label: 'Animal' },
      ],
      default: ['person', 'vehicle'],
    },
  ],
}

const detectorStep = {
  addonId: 'object-detection',
  addonName: 'Object Detection',
  slot: 'detector' as const,
  inputClasses: ['frame'],
  outputClasses: ['person', 'vehicle', 'animal'],
  enabled: true,
  modelId: 'yolov9-c',
  children: [],
  settings: { confidence: 0.45, classes: ['person', 'vehicle'] },
}

const audioSchema = {
  id: 'audio-classifier',
  name: 'Audio Classifier',
  slot: 'audio-classifier' as const,
  inputClasses: ['audio-window'],
  outputClasses: ['sound-event'],
  childSlots: [],
  models: [{ id: 'yamnet', name: 'YAMNet', formats: { onnx: { downloaded: true, sizeMB: 16 } } }],
  defaultModelId: 'yamnet',
  defaultConfidence: 0.3,
  configSchema: [],
}

const audioStep = {
  addonId: 'audio-classifier',
  addonName: 'Audio Classifier',
  slot: 'audio-classifier' as const,
  inputClasses: ['audio-window'],
  outputClasses: ['sound-event'],
  enabled: true,
  modelId: 'yamnet',
  children: [],
  engine: { runtime: 'python' as const, backend: 'coreml', format: 'coreml' as const },
}

const empty = new Map()

export const Hero = () => (
  <Frame>
    <PipelineStep
      step={detectorStep}
      schema={detectorSchema}
      allSchemas={empty}
      onChange={() => {}}
    />
  </Frame>
)

export const Disabled = () => (
  <Frame>
    <PipelineStep
      step={{ ...detectorStep, enabled: false }}
      schema={detectorSchema}
      allSchemas={empty}
      onChange={() => {}}
    />
  </Frame>
)

export const AudioRuntime = () => (
  <Frame>
    <PipelineStep step={audioStep} schema={audioSchema} allSchemas={empty} onChange={() => {}} />
  </Frame>
)

export const ReadOnly = () => (
  <Frame>
    <PipelineStep
      step={detectorStep}
      schema={detectorSchema}
      allSchemas={empty}
      readOnly
      onChange={() => {}}
    />
  </Frame>
)
