import { useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  useOsdManagerCopyDeviceConfiguration,
} from '@camstack/ui-library'
import { useT } from '../i18n/index.js'

interface DuplicateIntoActionProps {
  readonly source: { readonly id: number; readonly name: string }
  /** Every other OSD-capable camera — the source itself must never appear here. */
  readonly destinations: readonly { readonly id: number; readonly name: string }[]
  /** Called after a successful copy so the destination row (and the table) refresh. */
  readonly onDuplicated: (destinationId: number) => void
}

/**
 * "Duplicate into…" — the reverse of the old per-card "copy from" control.
 * The camera whose editor is expanded is unambiguously the SOURCE; the
 * operator picks the DESTINATION and confirms in a dialog, so a slip of the
 * mouse can't silently overwrite the wrong camera. Reuses the same
 * `copyDeviceConfiguration` backend call the previous "copy from" flow used —
 * only the direction the operator reasons about changed.
 */
export function DuplicateIntoAction({
  source,
  destinations,
  onDuplicated,
}: DuplicateIntoActionProps) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [destinationId, setDestinationId] = useState<number | undefined>(undefined)
  const [result, setResult] = useState<string | undefined>(undefined)
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
  const copyConfiguration = useOsdManagerCopyDeviceConfiguration()

  if (destinations.length === 0) return null

  function reset() {
    setDestinationId(undefined)
    setErrorMessage(undefined)
    setResult(undefined)
    copyConfiguration.reset?.()
  }

  async function handleConfirm() {
    if (destinationId === undefined) return
    const target = destinationId
    setErrorMessage(undefined)
    try {
      const copyResult = await copyConfiguration.mutateAsync({
        sourceDeviceId: source.id,
        targetDeviceId: target,
      })
      const name =
        destinations.find((d) => d.id === target)?.name ??
        t('duplicate.cameraFallback', { id: target })
      setResult(
        copyResult.skipped > 0
          ? t('duplicate.copiedSkipped', {
              count: copyResult.copied,
              name,
              skipped: copyResult.skipped,
            })
          : t('duplicate.copied', { count: copyResult.copied, name }),
      )
      onDuplicated(target)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t('duplicate.failed'))
    }
  }

  // Portal out of the DataTable cell — fill/overflow stacking stole clicks
  // from the native Select when the dialog lived inside the row.
  const dialog =
    open && typeof document !== 'undefined'
      ? createPortal(
          <Dialog
            open
            onOpenChange={(next) => {
              setOpen(next)
              if (!next) reset()
            }}
          >
            <DialogContent
              width="sm"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <DialogHeader>
                <DialogTitle className="break-words">
                  {t('duplicate.title', { name: source.name })}
                </DialogTitle>
                <DialogDescription>{t('duplicate.description')}</DialogDescription>
              </DialogHeader>

              {result === undefined ? (
                <Select
                  aria-label={t('duplicate.destinationAria')}
                  value={destinationId === undefined ? '' : String(destinationId)}
                  options={[
                    { value: '', label: t('duplicate.selectDestination') },
                    ...destinations.map((d) => ({ value: String(d.id), label: d.name })),
                  ]}
                  onChange={(e) => {
                    setDestinationId(e.target.value === '' ? undefined : Number(e.target.value))
                  }}
                />
              ) : (
                <p className="break-words text-xs text-success" role="status">
                  {result}
                </p>
              )}

              {(errorMessage ?? copyConfiguration.error?.message) && (
                <p className="mt-2 break-words text-xs text-danger" role="alert">
                  {errorMessage ?? copyConfiguration.error?.message}
                </p>
              )}

              <DialogFooter>
                {result !== undefined ? (
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => {
                      setOpen(false)
                      reset()
                    }}
                  >
                    {t('common.close')}
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={copyConfiguration.isPending}
                      onClick={() => {
                        setOpen(false)
                        reset()
                      }}
                    >
                      {t('common.cancel')}
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      disabled={destinationId === undefined || copyConfiguration.isPending}
                      onClick={() => void handleConfirm()}
                    >
                      {t('duplicate.confirm')}
                    </Button>
                  </>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>,
          document.body,
        )
      : null

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={(event) => {
          event.stopPropagation()
          reset()
          setOpen(true)
        }}
      >
        {t('duplicate.trigger')}
      </Button>
      {dialog}
    </>
  )
}
