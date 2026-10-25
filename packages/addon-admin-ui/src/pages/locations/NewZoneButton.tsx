/**
 * `+ New zone` — the ONE creation entry point for zones, rendered in the page
 * header. Same open-on-click pattern as `NewLocationButton`.
 */
import { Button, Input } from '@camstack/ui-library'
import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface NewZoneButtonProps {
  readonly busy: boolean
  readonly onCreate: (name: string) => void | Promise<void>
}

export function NewZoneButton({ busy, onCreate }: NewZoneButtonProps) {
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
      <Button size="sm" type="button" onClick={() => setOpen(true)} data-testid="new-zone-button">
        <Plus className="h-3.5 w-3.5" />
        {t('locations.newZoneButton.newZone', 'New zone')}
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
        placeholder={t('locations.newZoneButton.zonaGiornoZonaNotte', 'Zona giorno, Night zone…')}
        aria-label={t('locations.newZoneButton.newZoneName', 'New zone name')}
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
        aria-label={t('locations.newZoneButton.cancelNewZone', 'Cancel new zone')}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </form>
  )
}
