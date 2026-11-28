/**
 * TagStyleDialog — choose the colour and icon of one tag (D1054). Opened from
 * the tag input's suggestions and chips and from the filter menu; there is no
 * tags page. The colour is one of the tag-colour tokens, the icon a catalog
 * key; Save writes both in one `tags.setStyle` call.
 */
import {
  DEFAULT_TAG_ICON,
  type IconKey,
  TAG_COLOR_IDS,
  type TagColorId,
  type TagEntry,
} from '@dominevo/types'
import { Check, Tag as TagGlyph } from 'lucide-react'
import { type JSX, useEffect, useId, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../primitives/dialog'
import { ErrorBox } from '../error-box'
import { IconPicker } from '../icon-picker'
import { TAG_SWATCH_CLASS, TagChip } from './tag-chip'
import { tagStyleFor } from './tag-model'

export interface TagStyleDialogProps {
  /** The tag being styled; `null` keeps the dialog closed. */
  readonly name: string | null
  readonly entries: readonly TagEntry[] | undefined
  readonly onClose: () => void
  readonly onSave: (name: string, color: TagColorId, icon: IconKey) => Promise<void>
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function TagStyleDialog({
  name,
  entries,
  onClose,
  onSave,
}: TagStyleDialogProps): JSX.Element | null {
  const uiText = useUiText()
  const initial = name === null ? null : tagStyleFor(name, entries)
  const [color, setColor] = useState<TagColorId>(initial?.color ?? 'tag-a')
  const [icon, setIcon] = useState<IconKey>(initial?.icon ?? DEFAULT_TAG_ICON)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const colourLabelId = useId()

  // Re-seed whenever a different tag opens the dialog.
  useEffect(() => {
    if (name === null) return
    const seed = tagStyleFor(name, entries)
    setColor(seed.color)
    setIcon(seed.icon)
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new tag re-seeds; a registry refresh must not reset a choice in progress
  }, [name])

  const save = async (): Promise<void> => {
    if (name === null) return
    setSaving(true)
    setError(null)
    try {
      await onSave(name, color, icon)
      onClose()
    } catch (e: unknown) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  // Closed = not mounted: a closed native <dialog> still sits in the page, and
  // every tag input would otherwise add a hidden Save / Cancel pair to its form.
  if (name === null) return null

  return (
    <Dialog
      open={name !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent width="sm" placement="sheet-on-mobile">
        <DialogHeader>
          <DialogTitle>{uiText('uiLibrary.tags.styleTitle', 'Tag style')}</DialogTitle>
        </DialogHeader>
        {name !== null && (
          <DialogBody className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-foreground-subtle">
                {uiText('uiLibrary.tags.preview', 'Preview')}
              </span>
              <TagChip name={name} look={{ name, color, icon, styled: true }} />
            </div>
            <div className="space-y-1.5">
              <span className="text-xs font-medium" id={colourLabelId}>
                {uiText('uiLibrary.tags.colour', 'Colour')}
              </span>
              <div
                role="radiogroup"
                aria-labelledby={colourLabelId}
                className="flex flex-wrap gap-2"
              >
                {TAG_COLOR_IDS.map((id, index) => (
                  <button // ui-check-ok: a colour swatch radio (role=radio), not a push button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={color === id}
                    aria-label={uiText('uiLibrary.tags.colourN', 'Colour {{n}}', { n: index + 1 })}
                    onClick={() => setColor(id)}
                    className={cn(
                      'flex h-7 w-7 items-center justify-center rounded-full ring-offset-2 ring-offset-background',
                      TAG_SWATCH_CLASS[id],
                      color === id && 'ring-2 ring-foreground',
                    )}
                  >
                    {color === id && <Check className="h-3.5 w-3.5 text-background" />}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">{uiText('uiLibrary.tags.icon', 'Icon')}</span>
              <IconPicker
                value={icon}
                onPick={(key) => setIcon(key ?? DEFAULT_TAG_ICON)}
                fallbackGlyph={TagGlyph}
                labels={{
                  trigger: uiText('uiLibrary.tags.iconTrigger', 'Change the icon of {{name}}', {
                    name,
                  }),
                  panel: uiText('uiLibrary.tags.iconPanel', 'Icon for {{name}}', { name }),
                  searchPlaceholder: uiText('uiLibrary.tags.iconSearch', 'Search icons'),
                  clear: uiText('uiLibrary.tags.iconDefault', 'Default icon'),
                  noMatches: uiText('uiLibrary.tags.iconNoMatches', 'No icon matches that'),
                }}
                disabled={saving}
              />
            </div>
            {error !== null && <ErrorBox message={error} />}
          </DialogBody>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {uiText('uiLibrary.tags.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={saving || name === null}>
            {uiText('uiLibrary.tags.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
