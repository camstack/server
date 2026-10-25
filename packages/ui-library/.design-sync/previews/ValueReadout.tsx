import type { ReactNode } from 'react'
import { ValueReadout } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-center justify-between" style={{ width: 200 }}>
    <span className="text-xs text-foreground-subtle">{label}</span>
    {children}
  </div>
)

export const Hero = () => (
  <Frame>
    <div className="flex flex-col gap-2">
      <Row label="Temperature">
        <ValueReadout value="22" unit="°C" />
      </Row>
      <Row label="Brightness">
        <ValueReadout value="60" unit="%" />
      </Row>
      <Row label="Recording length">
        <ValueReadout value="30" unit="s" />
      </Row>
    </div>
  </Frame>
)

export const WithUnit = () => (
  <Frame>
    <ValueReadout value="1920×1080" unit="px" />
  </Frame>
)

export const NoUnit = () => (
  <Frame>
    <ValueReadout value="Auto" />
  </Frame>
)
