import type { ReactNode } from 'react'
import { SnapshotButton } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

// SnapshotButton owns no React-Query state — it takes a thin tRPC-shaped proxy
// exposing `snapshot.getSnapshot.query`. A stub is enough for the idle render.
const trpc = {
  snapshot: {
    getSnapshot: {
      query: async () =>
        ({ base64: '', contentType: 'image/jpeg' }) as {
          base64: string
          contentType: string
        },
    },
  },
}

export const Small = () => (
  <Frame>
    <div className="flex items-center gap-3">
      <span className="text-sm text-foreground-muted">Front Door</span>
      <SnapshotButton trpc={trpc} deviceId={12} deviceName="Front Door" size="sm" />
    </div>
  </Frame>
)

export const Medium = () => (
  <Frame>
    <SnapshotButton trpc={trpc} deviceId={31} deviceName="Backyard" size="md" />
  </Frame>
)

export const InHeader = () => (
  <Frame>
    <div className="flex items-center justify-between gap-4 rounded border border-border px-3 py-2 w-96">
      <div className="flex flex-col">
        <span className="text-sm font-medium text-foreground">Driveway</span>
        <span className="text-xs text-foreground-subtle">ONVIF · 1920×1080</span>
      </div>
      <SnapshotButton trpc={trpc} deviceId={7} deviceName="Driveway" size="sm" />
    </div>
  </Frame>
)
