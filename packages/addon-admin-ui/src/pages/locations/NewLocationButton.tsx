/**
 * `+ New location`, which OPENS the input — the page never opens on an empty
 * field.
 *
 * Creating a room is the rarest action on this page (16 rooms, 1 022 devices);
 * a form pinned above the content made the first thing on screen the thing
 * least often needed, and pushed the rooms below the fold.
 */
import { Button, Input } from '@camstack/ui-library'
import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface NewLocationButtonProps {
  readonly busy: boolean
  readonly onCreate: (name: string) => void | Promise<void>
}

export function NewLocationButton({ busy, onCreate }: NewLocationButtonProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  const close = (): void => {
    setDraft('')
    setOpen(false)
  }

  const submit = async (): Promise<void> => {
    const name = draft.trim()
    if (name.length === 0) return
    await onCreate(name)
    close()
  }

  if (!open) {
    return (
      <Button
        size="sm"
        type="button"
        onClick={() => setOpen(true)}
        data-testid="new-location-button"
      >
        <Plus className="h-3.5 w-3.5" />
        {t('locations.newLocationButton.newLocation', 'New location')}
      </Button>
    )
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
        }}
        placeholder={t(
          'locations.newLocationButton.frontDoorHallKitchen',
          'Front door, Hall, Kitchen…',
        )}
        aria-label={t('locations.newLocationButton.newLocationName', 'New location name')}
        className="min-w-[12rem] flex-1"
        autoFocus
      />
      <Button size="sm" type="submit" disabled={draft.trim().length === 0 || busy}>
        <Plus className="h-3.5 w-3.5" />
        {t('common.add', 'Add')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        type="button"
        onClick={close}
        aria-label={t('locations.newLocationButton.cancelNewLocation', 'Cancel new location')}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </form>
  )
}
