import type { ReactNode } from 'react'
import { RadialGauge, ValueReadout } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Hero = () => (
  <Frame>
    <RadialGauge fraction={0.6} color="#f59e0b">
      <span className="text-2xl font-semibold text-foreground">60%</span>
      <span className="text-[11px] text-foreground-subtle">Brightness</span>
    </RadialGauge>
  </Frame>
)

export const FanSpeed = () => (
  <Frame>
    <RadialGauge fraction={0.33} color="#38bdf8">
      <span className="text-2xl font-semibold text-foreground">Low</span>
      <span className="text-[11px] text-foreground-subtle">Fan speed</span>
    </RadialGauge>
  </Frame>
)

export const Full = () => (
  <Frame>
    <RadialGauge fraction={1} color="#34d399">
      <ValueReadout value="100" unit="%" />
      <span className="text-[11px] text-foreground-subtle">Max</span>
    </RadialGauge>
  </Frame>
)

export const Min = () => (
  <Frame>
    <RadialGauge fraction={0.05} color="#f87171">
      <span className="text-2xl font-semibold text-foreground">5%</span>
      <span className="text-[11px] text-foreground-subtle">Dimmed</span>
    </RadialGauge>
  </Frame>
)
