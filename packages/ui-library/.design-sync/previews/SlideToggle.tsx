import type { ReactNode } from 'react'
import { SlideToggle } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const noop = () => {}

export const Hero = () => (
  <Frame>
    <div style={{ width: 260 }}>
      <p className="mb-2 text-xs text-foreground-subtle">Slide to unlock</p>
      <SlideToggle on={false} targetLabel="Slide to unlock" onConfirm={noop} />
    </div>
  </Frame>
)

export const Locked = () => (
  <Frame>
    <div style={{ width: 260 }}>
      <SlideToggle on={false} targetLabel="Garage Door — locked" onConfirm={noop} />
    </div>
  </Frame>
)

export const Unlocked = () => (
  <Frame>
    <div style={{ width: 260 }}>
      <SlideToggle on targetLabel="Front Door — unlocked" onConfirm={noop} />
    </div>
  </Frame>
)
