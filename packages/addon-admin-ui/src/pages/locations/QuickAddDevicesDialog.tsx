/**
 * Quick multi-add: the library {@link DevicePicker} in a dialog, for adding
 * several devices at once — to a camera's links, or to a room.
 *
 * Nothing is pre-selected (D356: a link is only what the operator picked).
 * Devices already in are drawn checked and disabled (`lockedIds`). A short
 * "suggested" group may sit above the list; its entries are toggles into the
 * SAME selection, never ticked on their own.
 */
import {
  Button,
  CHIP_ACTIVE,
  CHIP_BASE,
  CHIP_INACTIVE,
  type DeviceListState,
  DevicePicker,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  type PickerItem,
  TEXT_SECTION_LABEL,
} from '@camstack/ui-library'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface QuickAddSuggestions {
  readonly heading: string
  readonly ids: readonly number[]
}

export interface QuickAddDevicesDialogProps {
  readonly open: boolean
  readonly title: string
  readonly items: readonly PickerItem<number>[]
  readonly listState: DeviceListState
  /** Already in: shown checked and disabled. */
  readonly lockedIds: readonly number[]
  readonly lockedNote: string
  readonly suggestions?: QuickAddSuggestions | null
  readonly busy?: boolean
  readonly onConfirm: (ids: readonly number[]) => void
  readonly onClose: () => void
}

export function QuickAddDevicesDialog({
  open,
  title,
  items,
  listState,
  lockedIds,
  lockedNote,
  suggestions = null,
  busy = false,
  onConfirm,
  onClose,
}: QuickAddDevicesDialogProps) {
  const { t } = useTranslation()
  const [picked, setPicked] = useState<readonly number[]>([])

  useEffect(() => {
    if (!open) setPicked([])
  }, [open])

  const nameOf = new Map(items.map((item) => [item.id, item.name]))
  const suggested = (suggestions?.ids ?? []).filter(
    (id) => nameOf.has(id) && !lockedIds.includes(id),
  )
  const toggle = (id: number): void =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body" aria-label={title}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
          {/* Only while open: a closed dialog element still renders its children, and the picker reads site zones. */}
          {open && suggestions !== null && suggested.length > 0 && (
            <section aria-label={suggestions.heading} className="flex flex-col gap-1">
              <h3 className={TEXT_SECTION_LABEL}>{suggestions.heading}</h3>
              <div className="flex flex-wrap gap-1">
                {suggested.map((id) => (
                  <button // ui-check-ok: CHIP_* toggle pill, as the Customize picker's kind chips
                    key={id}
                    type="button"
                    aria-pressed={picked.includes(id)}
                    className={`${CHIP_BASE} ${picked.includes(id) ? CHIP_ACTIVE : CHIP_INACTIVE}`}
                    onClick={() => toggle(id)}
                  >
                    {nameOf.get(id)}
                  </button>
                ))}
              </div>
            </section>
          )}
          {open && (
            <DevicePicker
              devices={items}
              listState={listState}
              value={picked}
              onChange={(next) => setPicked(next)}
              noun="device"
              emptyLabel={t('locations.addDialog.nonePicked')}
              showAll
              lockedIds={lockedIds}
              lockedNote={lockedNote}
              testId="quick-add-picker"
            />
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('locations.addDialog.cancel')}
          </Button>
          <Button disabled={picked.length === 0 || busy} onClick={() => onConfirm(picked)}>
            {t('locations.addDialog.confirm', { count: picked.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
