import type { ReactNode } from 'react'
import { Switch } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const noop = () => {}

export const Hero = () => (
  <Frame>
    <div className="flex flex-col gap-3">
      <Switch checked onCheckedChange={noop} label="Continuous recording" />
      <Switch checked={false} onCheckedChange={noop} label="Audio enabled" />
      <Switch checked onCheckedChange={noop} label="Object detection" />
    </div>
  </Frame>
)

export const States = () => (
  <Frame>
    <div className="flex flex-col gap-3">
      <Switch checked onCheckedChange={noop} label="On" />
      <Switch checked={false} onCheckedChange={noop} label="Off" />
      <Switch checked disabled onCheckedChange={noop} label="On (disabled)" />
      <Switch checked={false} disabled onCheckedChange={noop} label="Off (disabled)" />
    </div>
  </Frame>
)
