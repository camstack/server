import type { ReactNode } from 'react'
import { ConfigSchemaField } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg" style={{ width: 420 }}>
    {children}
  </div>
)

const step = {
  addonId: 'object-detection',
  addonName: 'Object Detection',
  slot: 'detector' as const,
  inputClasses: ['frame'],
  outputClasses: ['person'],
  enabled: true,
  modelId: 'yolov9-c',
  children: [],
  settings: {
    confidence: 0.55,
    classes: ['person', 'vehicle'],
    mode: 'balanced',
    debug: true,
    label: 'Front Door detector',
  },
}

const sliderField = {
  key: 'confidence',
  type: 'slider' as const,
  label: 'Confidence threshold',
  description: 'Minimum score for a detection to be kept',
  min: 0,
  max: 1,
  step: 0.05,
  default: 0.4,
  showValue: true,
}

const selectField = {
  key: 'mode',
  type: 'select' as const,
  label: 'Inference mode',
  options: [
    { value: 'fast', label: 'Fast' },
    { value: 'balanced', label: 'Balanced' },
    { value: 'accurate', label: 'Accurate' },
  ],
  default: 'balanced',
}

const multiField = {
  key: 'classes',
  type: 'multiselect' as const,
  label: 'Tracked classes',
  description: 'Which macro classes to keep',
  options: [
    { value: 'person', label: 'Person' },
    { value: 'vehicle', label: 'Vehicle' },
    { value: 'animal', label: 'Animal' },
  ],
  default: ['person'],
}

const booleanField = {
  key: 'debug',
  type: 'boolean' as const,
  label: 'Emit debug overlays',
  default: false,
}

const textField = {
  key: 'label',
  type: 'text' as const,
  label: 'Display name',
  placeholder: 'e.g. Front Door detector',
}

const fields = [sliderField, selectField, multiField, booleanField, textField]

const One = ({ field }: { field: (typeof fields)[number] }) => (
  <ConfigSchemaField
    field={field}
    allFields={fields}
    step={step}
    disabled={false}
    onChange={() => {}}
  />
)

export const Hero = () => (
  <Frame>
    <div className="space-y-4">
      <One field={sliderField} />
      <One field={selectField} />
      <One field={multiField} />
    </div>
  </Frame>
)

export const SliderField = () => (
  <Frame>
    <One field={sliderField} />
  </Frame>
)

export const MultiSelectField = () => (
  <Frame>
    <One field={multiField} />
  </Frame>
)

export const BooleanAndText = () => (
  <Frame>
    <div className="space-y-4">
      <One field={booleanField} />
      <One field={textField} />
    </div>
  </Frame>
)

export const Disabled = () => (
  <Frame>
    <ConfigSchemaField
      field={selectField}
      allFields={fields}
      step={step}
      disabled
      onChange={() => {}}
    />
  </Frame>
)
