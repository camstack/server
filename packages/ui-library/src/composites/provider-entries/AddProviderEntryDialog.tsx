/**
 * AddProviderEntryDialog — create one credential entry for a provider type.
 *
 * The host supplies the creatable types (`describeTypes`); the dialog never
 * invents them. Submit hands `{ typeId, name }` to `onCreate` — credentials
 * and settings live on the entry body after create (Task 11).
 */
import { useEffect, useId, useState, type JSX } from 'react'
import { Loader2 } from 'lucide-react'

import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../primitives/dialog'
import { Input } from '../../primitives/input'
import { Label } from '../../primitives/label'
import { Select } from '../../primitives/select'

export interface ProviderEntryTypeOption {
  readonly typeId: string
  readonly label: string
  readonly iconUrl: string | null
}

export interface AddProviderEntryCreateInput {
  readonly typeId: string
  readonly name: string
}

export interface AddProviderEntryDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly types: readonly ProviderEntryTypeOption[]
  readonly onCreate: (input: AddProviderEntryCreateInput) => void | Promise<void>
  /** When true, Create is disabled and shows a spinner. */
  readonly submitting?: boolean
  readonly title?: string
  readonly description?: string
}

export function AddProviderEntryDialog({
  open,
  onOpenChange,
  types,
  onCreate,
  submitting = false,
  title: titleProp,
  description: descriptionProp,
}: AddProviderEntryDialogProps): JSX.Element {
  const t = useUiText()
  const title = titleProp ?? t('uiLibrary.addProviderEntryDialog.title', 'Add provider entry')
  const description =
    descriptionProp ??
    t(
      'uiLibrary.addProviderEntryDialog.description',
      'Pick a provider type and name this credential set.',
    )
  const typeFieldId = useId()
  const nameFieldId = useId()
  const [typeId, setTypeId] = useState('')
  const [name, setName] = useState('')

  useEffect(() => {
    if (!open) return
    setTypeId(types[0]?.typeId ?? '')
    setName('')
  }, [open, types])

  const canSubmit = typeId !== '' && name.trim().length > 0 && !submitting && types.length > 0

  const handleSubmit = (): void => {
    if (!canSubmit) return
    void onCreate({ typeId, name: name.trim() })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent width="sm" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {types.length === 0 ? (
            <p className="text-xs text-foreground-subtle">
              {t(
                'uiLibrary.addProviderEntryDialog.noTypes',
                'No provider types are available yet. Install a training provider addon first.',
              )}
            </p>
          ) : (
            <>
              <div className="space-y-1">
                <Label htmlFor={typeFieldId}>
                  {t('uiLibrary.addProviderEntryDialog.providerType', 'Provider type')}
                </Label>
                <div className="flex items-center gap-2">
                  <TypeIcon
                    url={types.find((option) => option.typeId === typeId)?.iconUrl ?? null}
                  />
                  <Select
                    id={typeFieldId}
                    aria-label={t('uiLibrary.addProviderEntryDialog.providerType', 'Provider type')}
                    className="flex-1"
                    value={typeId}
                    onChange={(event) => setTypeId(event.target.value)}
                    options={types.map((option) => ({ value: option.typeId, label: option.label }))}
                    disabled={submitting}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor={nameFieldId}>
                  {t('uiLibrary.addProviderEntryDialog.name', 'Name')}
                </Label>
                <Input
                  id={nameFieldId}
                  aria-label={t('uiLibrary.addProviderEntryDialog.name', 'Name')}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('uiLibrary.addProviderEntryDialog.namePlaceholder', 'Production')}
                  disabled={submitting}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      handleSubmit()
                    }
                  }}
                />
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {t('uiLibrary.addProviderEntryDialog.cancel', 'Cancel')}
          </Button>
          <Button type="button" size="sm" disabled={!canSubmit} onClick={handleSubmit}>
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            {t('uiLibrary.addProviderEntryDialog.create', 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TypeIcon({ url }: { readonly url: string | null }): JSX.Element {
  if (url === null) {
    return (
      <span
        className={cn(
          'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          'border border-border bg-surface text-[10px] text-foreground-subtle',
        )}
        aria-hidden
      >
        ?
      </span>
    )
  }
  return (
    <img
      src={url}
      alt=""
      className="h-7 w-7 shrink-0 rounded-md border border-border bg-surface object-contain p-0.5"
    />
  )
}
