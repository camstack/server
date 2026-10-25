import type { ReactNode } from 'react'
import { ControlColumn, Stepper, ValueReadout, TapToggle } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const noop = () => {}

const DeviceRow = ({ name, children }: { name: string; children: ReactNode }) => (
  <div className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2">
    <span className="text-sm text-foreground">{name}</span>
    {children}
  </div>
)

export const Hero = () => (
  <Frame>
    <div className="flex flex-col gap-2" style={{ width: 320 }}>
      <DeviceRow name="Thermostat">
        <ControlColumn align="fill">
          <Stepper value={22} unit="°C" onDelta={noop} />
        </ControlColumn>
      </DeviceRow>
      <DeviceRow name="Living Room Light">
        <ControlColumn align="right">
          <TapToggle on busy={false} onToggle={noop} />
        </ControlColumn>
      </DeviceRow>
      <DeviceRow name="Recording length">
        <ControlColumn align="center">
          <ValueReadout value="30" unit="s" />
        </ControlColumn>
      </DeviceRow>
    </div>
  </Frame>
)

export const FillFull = () => (
  <Frame>
    <DeviceRow name="Fan speed">
      <ControlColumn align="fill">
        <Stepper value="Auto" onDelta={noop} />
      </ControlColumn>
    </DeviceRow>
  </Frame>
)

export const RightFlush = () => (
  <Frame>
    <DeviceRow name="Motion">
      <ControlColumn align="right">
        <TapToggle on={false} busy={false} onToggle={noop} />
      </ControlColumn>
    </DeviceRow>
  </Frame>
)

export const FitNatural = () => (
  <Frame>
    <DeviceRow name="Garage Door">
      <ControlColumn align="fit">
        <ValueReadout value="Closed" />
      </ControlColumn>
    </DeviceRow>
  </Frame>
)
