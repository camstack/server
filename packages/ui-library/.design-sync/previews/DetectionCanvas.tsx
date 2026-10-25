import type { ReactNode } from 'react'
import { DetectionCanvas } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg" style={{ width: 560 }}>
    {children}
  </div>
)

// Synthetic "camera frame" as an inline SVG data URL (1920x1080 driveway scene).
const SCENE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#1e293b"/><stop offset="1" stop-color="#334155"/>
        </linearGradient>
      </defs>
      <rect width="1920" height="1080" fill="url(#sky)"/>
      <rect y="720" width="1920" height="360" fill="#1f2937"/>
      <rect x="40" y="520" width="420" height="300" rx="24" fill="#475569"/>
      <rect x="760" y="180" width="240" height="560" rx="40" fill="#64748b"/>
      <circle cx="1280" cy="700" r="70" fill="#3f3f46"/>
      <text x="40" y="60" fill="#94a3b8" font-family="monospace" font-size="34">Driveway · 02:41:07</text>
    </svg>`,
  )

const detections = [
  {
    id: 'p1',
    kind: 'first-level' as const,
    macroClass: 'person',
    score: 0.93,
    bbox: { x: 760, y: 180, width: 240, height: 560 },
    labels: [{ label: 'Marco', score: 0.88 }],
  },
  {
    id: 'f1',
    kind: 'detail' as const,
    macroClass: 'face',
    score: 0.9,
    parentId: 'p1',
    bbox: { x: 818, y: 210, width: 110, height: 130 },
    labels: [{ label: 'Marco', score: 0.88 }],
  },
  {
    id: 'v1',
    kind: 'first-level' as const,
    macroClass: 'vehicle',
    score: 0.86,
    bbox: { x: 40, y: 520, width: 420, height: 300 },
    labels: [{ label: 'AB123CD', score: 0.79 }],
  },
  {
    id: 'pl1',
    kind: 'detail' as const,
    macroClass: 'plate',
    score: 0.82,
    parentId: 'v1',
    bbox: { x: 150, y: 730, width: 200, height: 60 },
    labels: [{ label: 'AB123CD', score: 0.79 }],
  },
  {
    id: 'a1',
    kind: 'first-level' as const,
    macroClass: 'animal',
    score: 0.58,
    bbox: { x: 1210, y: 630, width: 150, height: 140 },
    labels: [{ label: 'dog', score: 0.58 }],
  },
]

export const Hero = () => (
  <Frame>
    <DetectionCanvas
      src={SCENE}
      imageWidth={1920}
      imageHeight={1080}
      detections={detections}
      aspectRatio="16/9"
    />
  </Frame>
)

export const ConfidenceFiltered = () => (
  <Frame>
    <DetectionCanvas
      src={SCENE}
      imageWidth={1920}
      imageHeight={1080}
      detections={detections}
      minConfidence={0.8}
      borderWidth={3}
    />
  </Frame>
)

export const NoLabels = () => (
  <Frame>
    <DetectionCanvas
      src={SCENE}
      imageWidth={1920}
      imageHeight={1080}
      detections={detections}
      showConfidence={false}
    />
  </Frame>
)

export const NoImage = () => (
  <Frame>
    <DetectionCanvas
      src={null}
      imageWidth={1920}
      imageHeight={1080}
      placeholder="Waiting for snapshot…"
    />
  </Frame>
)
