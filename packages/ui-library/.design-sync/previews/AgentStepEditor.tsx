import type { ReactNode } from 'react'
import { AgentStepEditor } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg" style={{ width: 460 }}>
    {children}
  </div>
)

const addon = {
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
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.4,
      showValue: true,
    },
  ],
}

const agentDefault = {
  enabled: true,
  modelId: 'yolov9-c',
  settings: { confidence: 0.45 },
}

export const AgentMode = () => (
  <Frame>
    <div className="text-xs font-medium text-foreground-subtle uppercase tracking-wide mb-3">
      Agent baseline · hub
    </div>
    <AgentStepEditor
      addon={addon}
      agentDefault={agentDefault}
      engineFormat="onnx"
      onChangeAgentConfig={() => {}}
    />
  </Frame>
)
