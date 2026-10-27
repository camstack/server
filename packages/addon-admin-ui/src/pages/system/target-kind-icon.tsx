import type { TargetKind } from '@camstack/types'

/**
 * A kind descriptor augmented with the official brand-icon URL each provider
 * stamps. `iconUrl` is a structural pass-through field the cap builder forwards
 * verbatim but the `TargetKindSchema` (in `@camstack/types`) does not declare,
 * so the generated tRPC output type omits it — we re-attach it at the query
 * seam (documented type boundary, same shape as the `configSchema` tighten).
 * Absent/empty for kinds without a shipped icon (e.g. `homeassistant`).
 */
export type TargetKindWithIcon = TargetKind & { readonly iconUrl?: string }

/**
 * Render a kind's official brand icon when the provider shipped one, falling
 * back to the emoji glyph (`kind.icon`) otherwise. The icon route is
 * same-origin and admin-gated but served WITHOUT a bearer requirement (unlike
 * event-media), so a bare `<img>` renders it directly — no authed-media helper.
 * The SVGs carry varying viewBoxes (24–500), so the caller sizes via CSS.
 */
export function KindIcon({
  kind,
  imgClassName,
  fallbackClassName,
}: {
  readonly kind: TargetKindWithIcon | undefined
  readonly imgClassName: string
  readonly fallbackClassName: string
}) {
  if (kind?.iconUrl) {
    return (
      <img
        src={kind.iconUrl}
        alt={kind.label}
        className={imgClassName}
        loading="lazy"
        draggable={false}
      />
    )
  }
  return <span className={fallbackClassName}>{kind?.icon ?? '🔔'}</span>
}
