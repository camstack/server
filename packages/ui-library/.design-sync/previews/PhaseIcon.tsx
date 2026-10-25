import type { ReactNode } from 'react'
import { PhaseIcon } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const phases: { phase: string; label: string; color: string }[] = [
  { phase: 'active', label: 'Active', color: 'text-success' },
  { phase: 'watching', label: 'Watching', color: 'text-emerald-400' },
  { phase: 'load-shed', label: 'Load-Shed', color: 'text-amber-500' },
  { phase: 'paused', label: 'Paused', color: 'text-gray-400' },
  { phase: 'idle', label: 'Idle', color: 'text-foreground-subtle' },
]

export const AllPhases = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-5">
      {phases.map((p) => (
        <div key={p.phase} className={`flex flex-col items-center gap-1 ${p.color}`}>
          <PhaseIcon phase={p.phase} size={22} />
          <span className="text-[11px]">{p.label}</span>
        </div>
      ))}
    </div>
  </Frame>
)

export const Sizes = () => (
  <Frame>
    <div className="flex items-end gap-4 text-success">
      <PhaseIcon phase="active" size={16} />
      <PhaseIcon phase="active" size={24} />
      <PhaseIcon phase="active" size={32} />
    </div>
  </Frame>
)

export const InPill = () => (
  <Frame>
    <div className="inline-flex items-center gap-1.5 rounded-md border border-success/40 bg-success/10 px-2 py-1 text-success">
      <PhaseIcon phase="active" size={14} />
      <span className="text-xs font-medium">Front Door · Active</span>
    </div>
  </Frame>
)
