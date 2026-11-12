import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { CardIcon } from '../parts/CardIcon'

export type MediaArtworkKind = 'music' | 'tv' | 'blank'

export interface MediaArtworkProps {
  readonly kind: MediaArtworkKind
  /** Off: the tile goes quiet. */
  readonly on: boolean
  /** The cover the player reports; drawn in place of the tile. */
  readonly imageUrl?: string | null
  /** What a TV tile names (the input). */
  readonly caption?: string | null
}

const TILE = 'grid h-30 w-30 shrink-0 place-items-center overflow-hidden rounded-[14px] text-center'

/**
 * What is playing: the cover the player reports, else a tile — a note on the
 * accent for music, the input's name on a dark screen for a TV, nothing when
 * the content is not known. Quiet while the player is off.
 */
export function MediaArtwork({ kind, on, imageUrl, caption }: MediaArtworkProps): ReactElement {
  if (on && typeof imageUrl === 'string' && imageUrl.length > 0) {
    return (
      <img
        src={imageUrl}
        alt=""
        data-testid="dc-media-art"
        data-kind="image"
        className={cn(TILE, 'object-cover')}
      />
    )
  }
  const tone = !on
    ? 'bg-surface-hover text-foreground-muted'
    : kind === 'tv'
      ? 'bg-foreground text-background'
      : kind === 'music'
        ? 'bg-linear-135 from-primary to-info text-primary-foreground'
        : 'bg-surface-hover text-foreground-muted'
  return (
    <div data-testid="dc-media-art" data-kind={kind} aria-hidden className={cn(TILE, tone)}>
      {kind === 'tv' && on ? (
        <span className="px-2 text-base font-semibold">{caption ?? ''}</span>
      ) : kind === 'blank' ? null : (
        <CardIcon glyph={kind === 'tv' ? 'tv' : 'music'} className="h-10 w-10" />
      )}
    </div>
  )
}
