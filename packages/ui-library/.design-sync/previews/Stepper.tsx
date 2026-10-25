import type { ReactNode } from 'react'
import { Stepper } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const noop = () => {}

export const Hero = () => (
  <Frame>
    <div style={{ width: 140 }}>
      <p className="mb-2 text-xs text-foreground-subtle">Thermostat target</p>
      <Stepper value={22} unit="°C" onDelta={noop} />
    </div>
  </Frame>
)

export const Percent = () => (
  <Frame>
    <div style={{ width: 140 }}>
      <Stepper value={60} unit="%" onDelta={noop} />
    </div>
  </Frame>
)

export const Seconds = () => (
  <Frame>
    <div style={{ width: 140 }}>
      <Stepper value={30} unit="s" onDelta={noop} />
    </div>
  </Frame>
)

export const NoUnit = () => (
  <Frame>
    <div style={{ width: 140 }}>
      <Stepper value="Auto" onDelta={noop} />
    </div>
  </Frame>
)
