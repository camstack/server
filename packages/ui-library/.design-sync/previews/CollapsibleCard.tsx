import type { ReactNode } from 'react'
import { CollapsibleCard, Badge, Switch } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const noop = () => {}

const Header = ({ title, badge }: { title: string; badge?: string }) => (
  <div className="flex flex-1 items-center justify-between">
    <span className="text-sm font-medium">{title}</span>
    {badge && <Badge variant="info">{badge}</Badge>}
  </div>
)

export const Expanded = () => (
  <Frame>
    <div className="w-72">
      <CollapsibleCard
        expanded
        onExpandedChange={noop}
        header={<Header title="Object Detection" badge="ONVIF" />}
      >
        <div className="flex flex-col gap-3 text-sm">
          <Switch checked onCheckedChange={noop} label="Detect person" />
          <Switch checked={false} onCheckedChange={noop} label="Detect car" />
          <div className="text-xs text-foreground-muted">Min confidence: 0.65</div>
        </div>
      </CollapsibleCard>
    </div>
  </Frame>
)

export const Collapsed = () => (
  <Frame>
    <div className="flex w-72 flex-col gap-2">
      <CollapsibleCard
        expanded={false}
        onExpandedChange={noop}
        header={<Header title="Recording" badge="Continuous" />}
      />
      <CollapsibleCard
        expanded={false}
        onExpandedChange={noop}
        header={<Header title="Notifications" badge="3 rules" />}
      />
    </div>
  </Frame>
)

export const Dimmed = () => (
  <Frame>
    <div className="w-72">
      <CollapsibleCard
        expanded={false}
        dimmed
        onExpandedChange={noop}
        header={<Header title="Audio Detection" badge="Disabled" />}
      />
    </div>
  </Frame>
)
