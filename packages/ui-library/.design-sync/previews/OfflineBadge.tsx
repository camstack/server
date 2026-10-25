import type { ReactNode } from 'react'
import { OfflineBadge } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const Hero = () => (
  <Frame>
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-foreground">Backyard Camera</span>
      <OfflineBadge lastChangedAt={Date.now() - 5 * MIN} />
    </div>
  </Frame>
)

export const Durations = () => (
  <Frame>
    <div className="flex flex-col items-start gap-2">
      <OfflineBadge lastChangedAt={Date.now() - 10_000} />
      <OfflineBadge lastChangedAt={Date.now() - 12 * MIN} />
      <OfflineBadge lastChangedAt={Date.now() - 3 * HOUR} />
      <OfflineBadge lastChangedAt={Date.now() - 2 * DAY} />
    </div>
  </Frame>
)

export const NoTimestamp = () => (
  <Frame>
    <OfflineBadge />
  </Frame>
)
