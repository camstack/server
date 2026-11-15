/**
 * TagChip — one operator tag (D1054): its icon and name on a tint of its
 * colour token. An unstyled tag shows the colour derived from its name and the
 * default icon. `onStyle` makes the chip itself the "style" affordance;
 * `onRemove` adds the small remove button an input needs.
 */
import type { TagColorId, TagEntry } from '@camstack/types'
import { Tag as TagGlyph, X } from 'lucide-react'
import type { JSX } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import { useDisplayIconResolver } from '../icon-glyphs'
import { type TagStyleView, tagStyleFor } from './tag-model'

/** Literal class strings per colour id, so the Tailwind scan sees every one. */
export const TAG_CHIP_CLASS: Readonly<Record<TagColorId, string>> = {
  'tag-a': 'bg-tag-a/15 text-tag-a border-tag-a/30',
  'tag-b': 'bg-tag-b/15 text-tag-b border-tag-b/30',
  'tag-c': 'bg-tag-c/15 text-tag-c border-tag-c/30',
  'tag-d': 'bg-tag-d/15 text-tag-d border-tag-d/30',
  'tag-e': 'bg-tag-e/15 text-tag-e border-tag-e/30',
  'tag-f': 'bg-tag-f/15 text-tag-f border-tag-f/30',
  'tag-g': 'bg-tag-g/15 text-tag-g border-tag-g/30',
  'tag-h': 'bg-tag-h/15 text-tag-h border-tag-h/30',
}

/** Solid swatch per colour id (the style dialog). */
export const TAG_SWATCH_CLASS: Readonly<Record<TagColorId, string>> = {
  'tag-a': 'bg-tag-a',
  'tag-b': 'bg-tag-b',
  'tag-c': 'bg-tag-c',
  'tag-d': 'bg-tag-d',
  'tag-e': 'bg-tag-e',
  'tag-f': 'bg-tag-f',
  'tag-g': 'bg-tag-g',
  'tag-h': 'bg-tag-h',
}

export interface TagChipProps {
  readonly name: string
  /** The registry's answer; `undefined` draws the derived style. Ignored when `look` is given. */
  readonly entries?: readonly TagEntry[] | undefined
  /** An explicit style (the style dialog's preview). */
  readonly look?: TagStyleView
  /** Makes the chip a button that opens the tag's style. */
  readonly onStyle?: () => void
  readonly onRemove?: () => void
  readonly className?: string
}

const BASE =
  'inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-0 text-[11px] leading-4'

export function TagChip({
  name,
  entries,
  look,
  onStyle,
  onRemove,
  className,
}: TagChipProps): JSX.Element {
  const uiText = useUiText()
  const resolve = useDisplayIconResolver()
  const view = look ?? tagStyleFor(name, entries)
  const Glyph = resolve(view.icon) ?? TagGlyph
  const body = (
    <>
      <Glyph className="h-3 w-3 flex-shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
    </>
  )
  return (
    <span className={cn(BASE, TAG_CHIP_CLASS[view.color], className)} data-tag={name}>
      {onStyle === undefined ? (
        body
      ) : (
        <button // ui-check-ok: the chip's own label inside the pill; Button chrome breaks the chip
          type="button"
          onClick={onStyle}
          className="inline-flex min-w-0 items-center gap-1"
          aria-label={uiText('uiLibrary.tags.styleNamed', 'Colour and icon of {{name}}', { name })}
        >
          {body}
        </button>
      )}
      {onRemove !== undefined && (
        <button // ui-check-ok: the in-pill remove glyph; an IconButton is taller than the chip
          type="button"
          onClick={onRemove}
          className="-mr-0.5 rounded-full opacity-70 hover:opacity-100"
          aria-label={uiText('uiLibrary.tags.removeNamed', 'Remove {{name}}', {
            name,
          })}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}

export interface TagChipListProps {
  readonly tags: readonly string[] | undefined
  readonly entries: readonly TagEntry[] | undefined
  readonly className?: string
}

/** The tags of one row, wrapped. Renders nothing for a row with no tags. */
export function TagChipList({ tags, entries, className }: TagChipListProps): JSX.Element | null {
  if (tags === undefined || tags.length === 0) return null
  return (
    <span className={cn('flex flex-wrap gap-1', className)}>
      {tags.map((tag) => (
        <TagChip key={tag} name={tag} entries={entries} />
      ))}
    </span>
  )
}
