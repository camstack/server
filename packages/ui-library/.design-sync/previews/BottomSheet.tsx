import type { ReactNode } from 'react'
import { BottomSheet } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const noop = () => {}

// BottomSheet is `fixed inset-x-0 bottom-0` — it pins to the viewport. A
// `relative` host can't contain a fixed child, but the open sheet still paints;
// the host gives the card a sensible footprint behind the backdrop.
const Host = ({ children }: { children: ReactNode }) => (
  <div className="relative h-72 w-full overflow-hidden rounded-md border border-border bg-background">
    {children}
  </div>
)

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between py-2 text-xs border-b border-border-subtle last:border-0">
    <span className="text-foreground-subtle">{label}</span>
    <span className="font-mono text-foreground">{value}</span>
  </div>
)

export const Hero = () => (
  <Frame>
    <Host>
      <BottomSheet open onClose={noop} title="Front Door">
        <div className="space-y-0">
          <Row label="Status" value="Recording" />
          <Row label="Provider" value="ONVIF" />
          <Row label="Resolution" value="1920×1080" />
          <Row label="Last motion" value="12:04:31" />
        </div>
      </BottomSheet>
    </Host>
  </Frame>
)

export const ActionList = () => (
  <Frame>
    <Host>
      <BottomSheet open onClose={noop} title="Camera actions">
        <div className="space-y-1 pt-1">
          {['View live stream', 'Open clips', 'Edit zones', 'Snapshot now'].map((a) => (
            <button
              key={a}
              className="w-full rounded-md px-3 py-2 text-left text-sm text-foreground hover:bg-surface-hover"
            >
              {a}
            </button>
          ))}
        </div>
      </BottomSheet>
    </Host>
  </Frame>
)
