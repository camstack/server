import type { ReactNode } from 'react'
import { VersionBadge } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const StableVsPreRelease = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-3">
      <VersionBadge version="v0.14.1" />
      <VersionBadge version="v0.15.0-beta.2" />
      <VersionBadge version="v1.0.0-rc.1" />
      <VersionBadge version="v0.2.0" />
    </div>
  </Frame>
)

export const ForcedPreRelease = () => (
  <Frame>
    <div className="flex items-center gap-3">
      <VersionBadge version="v2.3.0" preRelease />
      <VersionBadge version="v0.16.0-canary.7" />
    </div>
  </Frame>
)

export const InRow = () => (
  <Frame>
    <div className="flex items-center justify-between gap-3 rounded-lg bg-surface border border-border px-3 py-2 w-72">
      <span className="text-sm text-foreground">ONVIF NVR</span>
      <VersionBadge version="v0.14.1" />
    </div>
  </Frame>
)
