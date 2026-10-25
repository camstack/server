import type { ReactNode } from 'react'
import { ProviderBadge } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const AllProviders = () => (
  <Frame>
    <div className="flex flex-col gap-2">
      <ProviderBadge provider="onvif" />
      <ProviderBadge provider="hikvision" />
      <ProviderBadge provider="reolink" />
      <ProviderBadge provider="homeAssistant" />
      <ProviderBadge provider="rtsp" />
    </div>
  </Frame>
)

export const DotsOnly = () => (
  <Frame>
    <div className="flex items-center gap-3">
      <ProviderBadge provider="onvif" showLabel={false} />
      <ProviderBadge provider="hikvision" showLabel={false} />
      <ProviderBadge provider="reolink" showLabel={false} />
      <ProviderBadge provider="homeAssistant" showLabel={false} />
      <ProviderBadge provider="rtsp" showLabel={false} />
    </div>
  </Frame>
)

export const InRow = () => (
  <Frame>
    <div className="flex items-center justify-between gap-3 rounded-lg bg-surface border border-border px-3 py-2 w-72">
      <div className="flex flex-col">
        <span className="text-sm text-foreground">Front Door</span>
        <span className="text-xs text-foreground-subtle">2560×1920 · H.264</span>
      </div>
      <ProviderBadge provider="onvif" />
    </div>
  </Frame>
)
