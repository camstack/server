import type { ReactNode } from 'react'
import { Breadcrumb } from '@camstack/ui-library'

// CamStack is dark-first; render every story in the dark canvas so DS tokens resolve.
const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const DeviceTrail = () => (
  <Frame>
    <Breadcrumb
      items={[
        { label: 'Integrations', onClick: () => {} },
        { label: 'ONVIF NVR', onClick: () => {} },
        { label: 'Front Door' },
      ]}
    />
  </Frame>
)

export const SettingsTrail = () => (
  <Frame>
    <Breadcrumb
      items={[
        { label: 'Settings', href: '#' },
        { label: 'Recording Nodes', href: '#' },
        { label: 'hub-01' },
      ]}
    />
  </Frame>
)

export const TwoLevel = () => (
  <Frame>
    <Breadcrumb items={[{ label: 'Cameras', onClick: () => {} }, { label: 'Backyard' }]} />
  </Frame>
)

export const InHeader = () => (
  <Frame>
    <div className="rounded-lg bg-surface border border-border px-4 py-3 w-96">
      <Breadcrumb
        items={[
          { label: 'Pipelines', onClick: () => {} },
          { label: 'Object Detection', onClick: () => {} },
          { label: 'arcface · stage 3' },
        ]}
      />
      <h1 className="mt-2 text-sm font-semibold text-foreground">arcface · stage 3</h1>
    </div>
  </Frame>
)
