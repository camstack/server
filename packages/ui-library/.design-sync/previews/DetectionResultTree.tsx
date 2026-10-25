import type { ReactNode } from 'react'
import { DetectionResultTree } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg" style={{ width: 460 }}>
    {children}
  </div>
)

const person = {
  id: 'det-person-1',
  kind: 'first-level' as const,
  macroClass: 'person',
  score: 0.94,
  bbox: { x: 412, y: 188, width: 240, height: 560 },
  labels: [
    { label: 'Marco', score: 0.88, detectionId: 'det-face-1' },
    { label: 'delivery', score: 0.71 },
  ],
  track: { trackId: 'trk-17', moving: true, zones: ['front-porch'] },
}

const face = {
  id: 'det-face-1',
  kind: 'detail' as const,
  macroClass: 'face',
  score: 0.91,
  parentId: 'det-person-1',
  bbox: { x: 470, y: 210, width: 96, height: 110 },
  labels: [{ label: 'Marco', score: 0.88 }],
  debug: {
    alternateLabels: {
      arcface: [
        { label: 'Marco', score: 0.882 },
        { label: 'Luca', score: 0.143 },
        { label: 'unknown', score: 0.061 },
      ],
    },
  },
}

const vehicle = {
  id: 'det-vehicle-1',
  kind: 'first-level' as const,
  macroClass: 'vehicle',
  score: 0.86,
  bbox: { x: 40, y: 520, width: 420, height: 300 },
  labels: [{ label: 'AB123CD', score: 0.79, detectionId: 'det-plate-1' }],
}

const plate = {
  id: 'det-plate-1',
  kind: 'detail' as const,
  macroClass: 'plate',
  score: 0.83,
  parentId: 'det-vehicle-1',
  bbox: { x: 180, y: 700, width: 150, height: 48 },
  labels: [{ label: 'AB123CD', score: 0.79 }],
}

const dog = {
  id: 'det-animal-1',
  kind: 'first-level' as const,
  macroClass: 'animal',
  score: 0.62,
  bbox: { x: 700, y: 640, width: 180, height: 140 },
  labels: [{ label: 'dog', score: 0.62 }],
  debug: { originalClass: 'dog', mask: 'AAAA', maskWidth: 64, maskHeight: 48 },
}

export const Hero = () => (
  <Frame>
    <DetectionResultTree detections={[person, face, vehicle, plate, dog]} />
  </Frame>
)

export const WithVisibilityToggles = () => (
  <Frame>
    <DetectionResultTree
      detections={[person, face, vehicle, plate]}
      hiddenKeys={new Set(['det-vehicle-1'])}
      onToggleVisibility={() => {}}
    />
  </Frame>
)

export const SingleLowConfidence = () => (
  <Frame>
    <DetectionResultTree detections={[dog]} />
  </Frame>
)

export const Empty = () => (
  <Frame>
    <DetectionResultTree detections={[]} />
  </Frame>
)
