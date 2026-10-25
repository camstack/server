const CAPABILITY_COLORS: Record<string, string> = {
  // detection / vision
  detection: 'bg-green-500/10 text-green-400',
  detector: 'bg-green-500/10 text-green-400',
  // streaming
  streaming: 'bg-blue-500/10 text-blue-400',
  decode: 'bg-blue-500/10 text-blue-400',
  decoder: 'bg-blue-500/10 text-blue-400',
  // recording
  recording: 'bg-orange-500/10 text-orange-400',
  recorder: 'bg-orange-500/10 text-orange-400',
  // transcoding
  transcoding: 'bg-purple-500/10 text-purple-400',
  transcoder: 'bg-purple-500/10 text-purple-400',
  transcode: 'bg-purple-500/10 text-purple-400',
  // restream
  restream: 'bg-cyan-500/10 text-cyan-400',
  restreamer: 'bg-cyan-500/10 text-cyan-400',
  // storage
  storage: 'bg-yellow-500/10 text-yellow-400',
  // notification
  notification: 'bg-pink-500/10 text-pink-400',
  notifier: 'bg-pink-500/10 text-pink-400',
  // faces
  faces: 'bg-indigo-500/10 text-indigo-400',
  // default
}

interface CapabilityBadgeProps {
  /** Capability name (string) or declaration object ({ name, mode }) */
  capability: string | { name: string; mode?: string }
  /** Optional mode label shown after a separator (overrides object mode) */
  mode?: string
  size?: 'sm' | 'xs'
}

export function CapabilityBadge({ capability, mode, size = 'xs' }: CapabilityBadgeProps) {
  const capName = typeof capability === 'string' ? capability : capability.name
  const capMode = mode ?? (typeof capability === 'object' ? capability.mode : undefined)
  const lower = capName.toLowerCase()
  const color = CAPABILITY_COLORS[lower] ?? 'bg-primary/10 text-primary'
  const textSize = size === 'sm' ? 'text-xs' : 'text-[10px]'

  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-medium gap-1 ${textSize} ${color}`}
    >
      {capName}
      {capMode && (
        <>
          <span className="opacity-40">·</span>
          <span className="opacity-70">{capMode}</span>
        </>
      )}
    </span>
  )
}
