/**
 * The annotation editor — a modal that takes (nearly) the whole viewport.
 *
 * It stays a modal, but its body NEVER scrolls: the dialog is a fixed-height
 * flex column, the body is `overflow-hidden`, and the workbench inside fits the
 * frame into whatever space is left (object-fit contain). Only the subject list
 * scrolls, on its own.
 *
 * Closing (the close control, Escape) is guarded: with unsaved edits the
 * operator is asked first. The native `cancel` of the `<dialog>` is intercepted
 * for that — letting it through would close the element behind the guard's back.
 */
import type { RetrainFrame } from '@camstack/types'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@camstack/ui-library'
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { useT } from '../../i18n/index.js'
import { RetrainWorkbench } from './RetrainWorkbench.js'
import { useUnsavedGuard } from './use-unsaved-guard.js'

/**
 * The dialog's size, spelled in full (Tailwind reads class names literally).
 * `DialogContent` is `md:h-auto` for a `scroll="body"` dialog — a short card on
 * desktop — so the height is restated at `md:` too: this one is the whole safe
 * viewport at every width.
 */
const DIALOG_CLASS =
  'flex h-[calc(100dvh-1rem-2*max(env(safe-area-inset-top),env(safe-area-inset-bottom)))] ' +
  'max-h-[calc(100dvh-1rem-2*max(env(safe-area-inset-top),env(safe-area-inset-bottom)))] ' +
  'md:h-[calc(100dvh-1rem-2*max(env(safe-area-inset-top),env(safe-area-inset-bottom)))] ' +
  'md:max-h-[calc(100dvh-1rem-2*max(env(safe-area-inset-top),env(safe-area-inset-bottom)))] ' +
  'w-[calc(100vw-1rem)] max-w-none flex-col gap-0 overflow-hidden p-0'

export interface CorpusAnnotateOverlayProps {
  readonly open: boolean
  readonly frames: readonly RetrainFrame[]
  readonly activeFrameId: string
  readonly framePosition: string
  readonly canStep: (step: 1 | -1) => boolean
  readonly onStep: (step: 1 | -1) => void
  readonly onClose: () => void
  readonly onFramesChanged: () => Promise<unknown>
  readonly onSaved?: () => Promise<unknown>
}

export function CorpusAnnotateOverlay({
  open,
  frames,
  activeFrameId,
  framePosition,
  canStep,
  onStep,
  onClose,
  onFramesChanged,
  onSaved,
}: CorpusAnnotateOverlayProps): JSX.Element {
  const { t } = useT()
  const [notice, setNotice] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const guard = useUnsavedGuard(dirty)

  useEffect(() => {
    setNotice(null)
  }, [activeFrameId])

  const requestClose = useCallback(() => {
    void guard(onClose)
  }, [guard, onClose])

  // Escape raises the dialog's native `cancel`, which would close the element
  // behind the guard's back: take it over.
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = dialogRef.current
    if (el === null) return undefined
    const onCancel = (event: Event): void => {
      event.preventDefault()
      requestClose()
    }
    el.addEventListener('cancel', onCancel)
    return () => {
      el.removeEventListener('cancel', onCancel)
    }
  }, [requestClose, open])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose()
      }}
    >
      <DialogContent
        width="lg"
        scroll="body"
        placement="center"
        aria-label={t('annotate.title')}
        data-testid="corpus-annotate-overlay"
        ref={dialogRef}
        className={DIALOG_CLASS}
      >
        <DialogHeader className="mb-0 shrink-0 border-b border-border py-2 pl-4 pr-12">
          <div className="min-w-0">
            <DialogTitle>{t('annotate.title')}</DialogTitle>
            {notice !== null ? (
              <p className="mt-0.5 truncate text-[11px] text-foreground-muted" role="status">
                {notice}
              </p>
            ) : null}
          </div>
        </DialogHeader>
        <DialogBody className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
          <RetrainWorkbench
            frames={frames}
            activeFrameId={activeFrameId}
            framePosition={framePosition}
            canStep={canStep}
            onStep={onStep}
            onFramesChanged={onFramesChanged}
            onSaved={onSaved}
            onDirtyChange={setDirty}
            setNotice={setNotice}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
