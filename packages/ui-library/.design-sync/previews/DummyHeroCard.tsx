import type { ReactNode } from 'react'
import { DummyHeroCard } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg" style={{ width: 360 }}>
    {children}
  </div>
)

// DummyHeroCard is a static placeholder for device types without an
// implemented hero control — it ignores trpc/deviceId and renders a
// muted "Controls coming soon" card.
const props = { trpc: {} as never, deviceId: 7, features: ['OnOff'] }

export const Hero = () => (
  <Frame>
    <div className="text-xs font-medium text-foreground-subtle uppercase tracking-wide mb-2">
      Garage Door · unsupported control
    </div>
    <DummyHeroCard {...props} />
  </Frame>
)

export const InContext = () => (
  <Frame>
    <div className="space-y-2">
      <div className="text-sm font-semibold text-foreground">Living Room Thermostat</div>
      <DummyHeroCard {...props} deviceId={12} features={['Thermostat']} />
      <p className="text-[11px] text-foreground-subtle">
        A hero control for this device type has not been implemented yet.
      </p>
    </div>
  </Frame>
)
