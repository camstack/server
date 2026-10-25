import type { ReactNode } from 'react'
import { TapToggle } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const noop = () => {}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-center justify-between" style={{ width: 220 }}>
    <span className="text-sm text-foreground">{label}</span>
    {children}
  </div>
)

export const Hero = () => (
  <Frame>
    <div className="flex flex-col gap-3">
      <Row label="Living Room Light">
        <TapToggle on busy={false} onToggle={noop} />
      </Row>
      <Row label="Garage Fan">
        <TapToggle on={false} busy={false} onToggle={noop} />
      </Row>
    </div>
  </Frame>
)

export const On = () => (
  <Frame>
    <TapToggle on busy={false} onToggle={noop} />
  </Frame>
)

export const Off = () => (
  <Frame>
    <TapToggle on={false} busy={false} onToggle={noop} />
  </Frame>
)

export const Busy = () => (
  <Frame>
    <Row label="Switching…">
      <TapToggle on busy onToggle={noop} />
    </Row>
  </Frame>
)
