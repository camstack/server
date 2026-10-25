import type { ReactNode } from 'react'
import { IconAction } from '@camstack/ui-library'
import { Pencil, RefreshCw, Trash2, Settings, ExternalLink } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Hero = () => (
  <Frame>
    <div className="flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1">
      <IconAction icon={Pencil} label="Edit" onClick={() => {}} />
      <IconAction icon={RefreshCw} label="Reboot" onClick={() => {}} />
      <IconAction icon={Settings} label="Configure" onClick={() => {}} />
      <IconAction icon={Trash2} label="Delete" onClick={() => {}} danger />
    </div>
  </Frame>
)

export const Danger = () => (
  <Frame>
    <div className="flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1">
      <IconAction icon={Trash2} label="Delete device" onClick={() => {}} danger />
    </div>
  </Frame>
)

export const TableActionsCell = () => (
  <Frame>
    <div
      className="rounded-md border border-border bg-surface px-3 py-2 flex items-center justify-between"
      style={{ width: 260 }}
    >
      <span className="text-xs text-foreground truncate">Front Door · Reolink</span>
      <div className="flex items-center gap-0.5">
        <IconAction icon={ExternalLink} label="Open" onClick={() => {}} />
        <IconAction icon={Settings} label="Settings" onClick={() => {}} />
        <IconAction icon={Trash2} label="Remove" onClick={() => {}} danger />
      </div>
    </div>
  </Frame>
)
