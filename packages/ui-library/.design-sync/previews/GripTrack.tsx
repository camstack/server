import type { ReactNode } from 'react'
import { GripTrack } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div style={{ width: 260 }}>
    <div className="mb-2 flex items-center justify-between text-xs text-foreground-subtle">
      <span>{label}</span>
    </div>
    {children}
  </div>
)

export const Hero = () => (
  <Frame>
    <Row label="Brightness — 60%">
      <GripTrack fraction={0.6} />
    </Row>
  </Frame>
)

export const Levels = () => (
  <Frame>
    <div className="flex flex-col gap-5">
      <Row label="Volume — 15%">
        <GripTrack fraction={0.15} />
      </Row>
      <Row label="Brightness — 50%">
        <GripTrack fraction={0.5} />
      </Row>
      <Row label="Playback position — 90%">
        <GripTrack fraction={0.9} />
      </Row>
    </div>
  </Frame>
)

export const Colored = () => (
  <Frame>
    <Row label="Warm white — 75%">
      <GripTrack fraction={0.75} color="#f59e0b" />
    </Row>
  </Frame>
)
