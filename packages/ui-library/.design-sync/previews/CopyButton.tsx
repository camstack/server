import type { ReactNode } from 'react'
import { CopyButton } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const WithLabel = () => (
  <Frame>
    <div className="flex flex-col gap-3 w-96">
      <div className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
        <code className="text-xs text-foreground-muted truncate">
          rtsp://192.168.10.50:554/Front_Door
        </code>
        <CopyButton value="rtsp://192.168.10.50:554/Front_Door" label="Copy URL" />
      </div>
      <div className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
        <code className="text-xs text-foreground-muted truncate">tok_9f3a7c21bd84e0fa</code>
        <CopyButton value="tok_9f3a7c21bd84e0fa" label="Copy token" />
      </div>
    </div>
  </Frame>
)

export const IconOnly = () => (
  <Frame>
    <div className="flex items-center gap-3">
      <span className="text-xs text-foreground-muted">Stream key</span>
      <code className="text-xs text-foreground-subtle">sk_live_4b21…</code>
      <CopyButton value="sk_live_4b21f8e9a0c7" />
    </div>
  </Frame>
)

export const Disabled = () => (
  <Frame>
    <div className="flex items-center gap-3">
      <span className="text-xs text-foreground-subtle">No URL configured</span>
      <CopyButton value="" label="Copy URL" disabled />
    </div>
  </Frame>
)
