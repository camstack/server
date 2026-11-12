import { useState, type ReactElement } from 'react'
import { useAddonIconUrl } from '../../contexts/addon-icons-context'

/**
 * The Kind cell of every instances table: the provider's declared icon, then
 * the kind label. An addon with no icon (or an asset that fails to load)
 * shows the label alone — no placeholder tile.
 */
export function KindCell({
  addonId,
  label,
}: {
  readonly addonId: string
  readonly label: string
}): ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5 text-foreground-muted">
      <KindIcon addonId={addonId} />
      {label}
    </span>
  )
}

function KindIcon({ addonId }: { readonly addonId: string }): ReactElement | null {
  const src = useAddonIconUrl(addonId)
  const [broken, setBroken] = useState(false)
  if (!src || broken) return null
  return (
    <img src={src} alt="" className="h-4 w-4 shrink-0 rounded" onError={() => setBroken(true)} />
  )
}
