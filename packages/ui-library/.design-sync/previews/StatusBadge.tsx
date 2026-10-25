import type { ReactNode } from 'react'
import { StatusBadge } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const AllStatuses = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-4">
      <StatusBadge status="online" />
      <StatusBadge status="degraded" />
      <StatusBadge status="offline" />
      <StatusBadge status="unknown" />
    </div>
  </Frame>
)

export const Sizes = () => (
  <Frame>
    <div className="flex items-center gap-4">
      <StatusBadge status="online" size="sm" />
      <StatusBadge status="online" size="md" />
    </div>
  </Frame>
)

export const DotOnly = () => (
  <Frame>
    <div className="flex items-center gap-4">
      <StatusBadge status="online" showLabel={false} />
      <StatusBadge status="degraded" showLabel={false} />
      <StatusBadge status="offline" showLabel={false} />
    </div>
  </Frame>
)

export const InRow = () => (
  <Frame>
    <div className="flex items-center justify-between gap-3 rounded-lg bg-surface border border-border px-3 py-2 w-72">
      <div className="flex flex-col">
        <span className="text-sm text-foreground">Garage</span>
        <span className="text-xs text-foreground-subtle">Reolink · 2560×1920</span>
      </div>
      <StatusBadge status="online" />
    </div>
  </Frame>
)
