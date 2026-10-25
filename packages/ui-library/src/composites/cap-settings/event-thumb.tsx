import { useState, type JSX } from 'react'
import { Box, Volume2, Activity } from 'lucide-react'

// Shared per-event thumbnail used by the recording timeline drill-down strip.
// Renders a browser-native <img> from the data-plane mediaUrl (browser-cached),
// falling back to a kind icon when no URL exists or the image fails to load.

export type ClipKind = 'motion' | 'object' | 'audio'

interface EventThumbProps {
  readonly mediaUrl?: string
  readonly kind: ClipKind
}

export function EventThumb({ mediaUrl, kind }: EventThumbProps): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (mediaUrl && !failed) {
    return (
      <img
        src={mediaUrl}
        alt=""
        className="h-full w-full object-cover"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <div className="flex h-full w-full items-center justify-center text-white/30">
      <EventKindIcon kind={kind} large />
    </div>
  )
}

export function EventKindIcon({
  kind,
  large = false,
}: {
  readonly kind: ClipKind
  readonly large?: boolean
}): JSX.Element {
  const cls = large ? 'h-7 w-7' : 'h-3.5 w-3.5 text-foreground-subtle'
  if (kind === 'object') return <Box className={cls} />
  if (kind === 'audio') return <Volume2 className={cls} />
  return <Activity className={cls} />
}
