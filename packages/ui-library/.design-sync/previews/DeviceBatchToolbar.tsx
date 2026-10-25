import type { ReactNode } from 'react'
import { DeviceBatchToolbar } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const noop = () => {}

export const Hero = () => (
  <Frame>
    <div style={{ width: 460 }}>
      <DeviceBatchToolbar
        selectedIds={new Set([101, 102, 103])}
        onClear={noop}
        remove={noop}
        disable={noop}
        enable={noop}
      />
    </div>
  </Frame>
)

export const SingleSelected = () => (
  <Frame>
    <div style={{ width: 460 }}>
      <DeviceBatchToolbar
        selectedIds={new Set([42])}
        onClear={noop}
        remove={noop}
        disable={noop}
        enable={noop}
      />
    </div>
  </Frame>
)

export const ManySelected = () => (
  <Frame>
    <div style={{ width: 460 }}>
      <DeviceBatchToolbar
        selectedIds={new Set([1, 2, 3, 4, 5, 6, 7, 8])}
        onClear={noop}
        remove={noop}
        disable={noop}
        enable={noop}
      />
    </div>
  </Frame>
)
