import type { ReactNode } from 'react'
import { ChildSectionAccordion } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const Row = ({ name, status }: { name: string; status: string }) => (
  <div className="flex items-center justify-between rounded-md bg-surface px-2 py-1.5 text-[11px]">
    <span className="text-foreground truncate">{name}</span>
    <span className="text-foreground-subtle">{status}</span>
  </div>
)

export const Hero = () => (
  <Frame>
    <div style={{ width: 280 }}>
      <ChildSectionAccordion title="Accessories" count={3}>
        <Row name="Front Door Chime" status="Online" />
        <Row name="Motion Sensor" status="Idle" />
        <Row name="Doorbell Button" status="Online" />
      </ChildSectionAccordion>
    </div>
  </Frame>
)

export const Collapsed = () => (
  <Frame>
    <div style={{ width: 280 }}>
      <ChildSectionAccordion title="Sensors" count={5} defaultOpen={false}>
        <Row name="Temperature" status="21°C" />
      </ChildSectionAccordion>
    </div>
  </Frame>
)

export const Stacked = () => (
  <Frame>
    <div className="space-y-2" style={{ width: 280 }}>
      <ChildSectionAccordion title="Cameras" count={2}>
        <Row name="Backyard" status="Recording" />
        <Row name="Driveway" status="Online" />
      </ChildSectionAccordion>
      <ChildSectionAccordion title="Lights" count={2} defaultOpen={false}>
        <Row name="Garage Light" status="Off" />
        <Row name="Porch Light" status="On" />
      </ChildSectionAccordion>
    </div>
  </Frame>
)
