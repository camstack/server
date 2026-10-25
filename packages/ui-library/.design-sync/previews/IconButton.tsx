import type { ReactNode } from 'react'
import { IconButton } from '@camstack/ui-library'
import { Play, Pause, Mic, Settings, Maximize2, Trash2, Camera, Volume2 } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Variants = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-2">
      <IconButton variant="primary" icon={Play} aria-label="Play" />
      <IconButton variant="secondary" icon={Settings} aria-label="Settings" />
      <IconButton variant="ghost" icon={Maximize2} aria-label="Fullscreen" />
      <IconButton variant="outline" icon={Camera} aria-label="Snapshot" />
      <IconButton variant="danger" icon={Trash2} aria-label="Delete" />
    </div>
  </Frame>
)

export const Sizes = () => (
  <Frame>
    <div className="flex items-center gap-2">
      <IconButton size="sm" variant="primary" icon={Play} aria-label="Play small" />
      <IconButton size="md" variant="primary" icon={Play} aria-label="Play medium" />
      <IconButton size="lg" variant="primary" icon={Play} aria-label="Play large" />
    </div>
  </Frame>
)

export const Toolbar = () => (
  <Frame>
    <div className="inline-flex items-center gap-1 rounded-md border border-border bg-surface p-1">
      <IconButton variant="ghost" icon={Pause} aria-label="Pause" />
      <IconButton variant="ghost" icon={Mic} aria-label="Talk" />
      <IconButton variant="ghost" icon={Volume2} aria-label="Audio" />
      <IconButton variant="ghost" icon={Maximize2} aria-label="Fullscreen" />
    </div>
  </Frame>
)

export const Disabled = () => (
  <Frame>
    <div className="flex items-center gap-2">
      <IconButton variant="primary" icon={Mic} aria-label="Talk disabled" disabled />
      <IconButton variant="outline" icon={Camera} aria-label="Snapshot disabled" disabled />
    </div>
  </Frame>
)
