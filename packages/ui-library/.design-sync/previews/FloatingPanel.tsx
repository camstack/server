import type { ReactNode } from 'react'
import { FloatingPanel } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const noop = () => {}

// FloatingPanel (desktop) is `fixed` at left/top ~80px with a draggable title
// bar + resize handle. The host gives the card a footprint behind the panel.
const Host = ({ children }: { children: ReactNode }) => (
  <div className="relative h-80 w-full overflow-hidden rounded-md border border-border bg-background">
    {children}
  </div>
)

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between text-xs">
    <span className="text-foreground-subtle">{label}</span>
    <span className="font-mono text-foreground">{value}</span>
  </div>
)

export const Hero = () => (
  <Frame>
    <Host>
      <FloatingPanel title="Front Door · Pipeline" onClose={noop}>
        <div className="space-y-2 p-3">
          <Row label="Provider" value="ONVIF" />
          <Row label="Stream" value="WebRTC (restreamer)" />
          <Row label="Resolution" value="1920×1080" />
          <Row label="Detection" value="yolov9 · 0.45" />
          <div className="flex flex-wrap gap-1 pt-1">
            {['person', 'car', 'package'].map((c) => (
              <span
                key={c}
                className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary"
              >
                {c}
              </span>
            ))}
          </div>
        </div>
      </FloatingPanel>
    </Host>
  </Frame>
)

export const EventInspector = () => (
  <Frame>
    <Host>
      <FloatingPanel title="Detection · Backyard" onClose={noop} defaultWidth={320}>
        <div className="space-y-2 p-3">
          <div className="aspect-video w-full rounded bg-surface border border-border flex items-center justify-center text-[10px] text-foreground-subtle">
            snapshot · 12:04:31
          </div>
          <Row label="Object" value="person" />
          <Row label="Confidence" value="0.91" />
          <Row label="Zone" value="Driveway" />
        </div>
      </FloatingPanel>
    </Host>
  </Frame>
)
