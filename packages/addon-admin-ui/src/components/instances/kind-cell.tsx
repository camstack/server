import { type ReactElement, useState } from 'react'
import { useAddonIconUrl } from '../../contexts/addon-icons-context'

/** What a Kind cell shows: the providing addon, the kind's label and, when it declares one, its icon. */
export interface KindCellProps {
  readonly addonId: string
  readonly label: string
  /** The kind's own icon (`IntegrationInstanceKind.iconUrl`); absent → the addon's icon. */
  readonly iconUrl?: string
}

/**
 * The Kind cell of every instances table: the kind's declared icon, else the
 * provider's, then the kind label. An icon that is absent (or fails to load)
 * falls back to the next one, and with none the label stands alone — no
 * placeholder tile.
 */
export function KindCell({ addonId, label, iconUrl }: KindCellProps): ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5 text-foreground-muted">
      <KindIcon addonId={addonId} {...(iconUrl !== undefined ? { iconUrl } : {})} />
      {label}
    </span>
  )
}

interface KindIconProps {
  readonly addonId: string
  readonly iconUrl?: string
}

/** The first icon of (kind, addon) that loads; null when neither does. */
export function KindIcon({ addonId, iconUrl }: KindIconProps): ReactElement | null {
  const addonIcon = useAddonIconUrl(addonId)
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set())
  const src = [iconUrl, addonIcon].find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate !== '' && !broken.has(candidate),
  )
  if (src === undefined) return null
  return (
    <img
      src={src}
      alt=""
      className="h-4 w-4 shrink-0 rounded"
      onError={() => setBroken((prev) => new Set([...prev, src]))}
    />
  )
}
