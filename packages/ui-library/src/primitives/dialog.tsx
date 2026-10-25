import { useUiText } from '../contexts/ui-text'
import {
  type JSX,
  type HTMLAttributes,
  type ReactNode,
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cva } from 'class-variance-authority'
import { X } from 'lucide-react'
import { cn } from '../lib/cn'
import { IconButton } from './icon-button'

interface DialogContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  contentId: string
}

const DialogContext = createContext<DialogContextValue | null>(null)

function useDialogContext() {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('Dialog compound components must be used within <Dialog>')
  return ctx
}

/* ── Root ── */

interface DialogProps {
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function Dialog({ children, open: controlledOpen, onOpenChange }: DialogProps): JSX.Element {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const contentId = useId()

  const setOpen = useCallback(
    (next: boolean) => {
      onOpenChange?.(next)
      if (controlledOpen === undefined) setUncontrolledOpen(next)
    },
    [controlledOpen, onOpenChange],
  )

  return (
    <DialogContext.Provider value={{ open, setOpen, contentId }}>{children}</DialogContext.Provider>
  )
}

/* ── Trigger ── */

export function DialogTrigger({
  children,
  ...props
}: HTMLAttributes<HTMLButtonElement>): JSX.Element {
  const { setOpen } = useDialogContext()
  return (
    <button type="button" onClick={() => setOpen(true)} {...props}>
      {children}
    </button>
  )
}

/* ── Content ── */

/**
 * A native <dialog> opened with showModal() is promoted to the top layer, so
 * ancestor transform/overflow can't clip it — but it relies on the UA
 * stylesheet's `dialog { margin: auto }` for modal centering. Tailwind's
 * preflight resets `margin: 0` on every element, which defeats that centering
 * and pins the modal to the top-left. We therefore center deterministically:
 * a top-layer dialog with `position: fixed` is viewport-relative, and a
 * self-transform is fine, so `fixed left-1/2 top-1/2 -translate-x-1/2
 * -translate-y-1/2 m-0` always centers regardless of any margin reset. Width
 * is capped to the viewport (`w-[calc(100vw-2rem)]`) rather than a bare
 * `w-full` (which would overflow/clip a centered dialog); the per-variant
 * `max-w-*` keeps small dialogs small while the cap prevents overflow.
 *
 * Height is capped against the SAFE viewport, not the raw one. A top-layer
 * `fixed` dialog is viewport-relative, and under `viewport-fit=cover` the
 * viewport extends behind the iOS notch/Dynamic Island and home indicator —
 * so a dialog tall enough to hit its `max-h` put its header under the clock.
 * Because the box is centred on the viewport (not on the safe area), the cap
 * has to subtract TWICE the LARGER of the two insets for the box to clear
 * both edges; using each inset once would still overflow the taller side
 * whenever they are asymmetric (they are: ~59px top vs ~34px bottom). Every
 * term collapses to the previous `100dvh - 2rem` where the insets are 0.
 */
const contentVariants = cva(
  // `text-foreground` pairs with `bg-background-elevated`: a surface that sets a
  // background MUST set the matching foreground, or its subtree inherits from
  // outside the dialog (a `<dialog>` is top-layer) and any child without an
  // explicit colour renders invisible on one of the two themes.
  'relative fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 m-0 w-[calc(100vw-2rem)] bg-background-elevated text-foreground border border-border rounded-lg p-4 backdrop:bg-black/50 backdrop:backdrop-blur-sm max-h-[calc(100dvh-2rem-2*max(env(safe-area-inset-top),env(safe-area-inset-bottom)))] [&:not([open])]:hidden',
  {
    variants: {
      width: {
        sm: 'max-w-sm',
        md: 'max-w-md',
        lg: 'max-w-lg',
        /** Wide editors (scripts, long forms). */
        xl: 'max-w-4xl',
      },
      /**
       * WHICH box scrolls when the content is taller than the height cap.
       *
       * `content` (default) scrolls the whole dialog: the title, any tab strip
       * and the Save/Cancel row travel with the fields. That is fine for a
       * short form and wrong for a long one — the operator scrolls to the
       * bottom of a rule editor and the buttons are somewhere above him, the
       * tab strip is gone, and the only way back to either is to scroll the
       * form he was reading.
       *
       * `body` makes the dialog a flex column that does not scroll at all and
       * hands the scrolling to `<DialogBody>`. The chrome around the body —
       * header, tab strip, footer — stays put at every height. The dialog
       * keeps its own padding either way, so `sheet-on-mobile`'s
       * safe-area bottom padding still applies to the footer.
       *
       * `body` also takes a DEFINITE height below `md` — see the
       * `scroll: 'body'` compound variants. That is not a style choice; the
       * flex chain does not resolve without it on iOS Safari.
       */
      scroll: {
        content: 'overflow-y-auto',
        body: 'flex flex-col overflow-hidden',
      },
      placement: {
        center: '',
        // Mobile: pin to the bottom edge as a full-width sheet (overrides the
        // base centering + the width variant's max-w-*). md+: re-center as an
        // ordinary modal via the md: breakpoint set, restoring the rounded
        // corners the sheet drops on its flush bottom edge.
        //
        // The sheet is flush with the bottom viewport edge, which under
        // `viewport-fit=cover` is BEHIND the iOS home indicator — so it pads
        // its own bottom by that inset (the flush edge must stay flush, so
        // this is padding, not an offset). The md: re-centred form takes the
        // same safe-viewport height cap as the base variant.
        'sheet-on-mobile':
          'bottom-0 left-0 right-0 top-auto w-full max-w-full translate-x-0 translate-y-0 rounded-b-none max-h-[92dvh] pb-[calc(1rem+env(safe-area-inset-bottom))] md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg md:bottom-auto md:pb-4 md:max-h-[calc(100dvh-2rem-2*max(env(safe-area-inset-top),env(safe-area-inset-bottom)))]',
      },
    },
    // sheet-on-mobile's own `w-full max-w-full` (unprefixed) beats the `width`
    // variant's `max-w-*` under twMerge (later class wins within a conflict
    // group) — that is intentional on mobile (full-width sheet regardless of
    // size) but leaves desktop UNBOUNDED-width once the md: breakpoint kicks
    // in, since nothing re-caps it there. Reactivate the width cap at `md:`
    // per width value, mirroring the working reference in
    // FaceDetailPanel.tsx (`md:w-[calc(100vw-2rem)] md:max-w-xl`).
    compoundVariants: [
      {
        placement: 'sheet-on-mobile',
        width: 'sm',
        class: 'md:w-[calc(100vw-2rem)] md:max-w-sm',
      },
      {
        placement: 'sheet-on-mobile',
        width: 'md',
        class: 'md:w-[calc(100vw-2rem)] md:max-w-md',
      },
      {
        placement: 'sheet-on-mobile',
        width: 'lg',
        class: 'md:w-[calc(100vw-2rem)] md:max-w-lg',
      },
      {
        placement: 'sheet-on-mobile',
        width: 'xl',
        class: 'md:w-[calc(100vw-2rem)] md:max-w-4xl',
      },
      /*
       * A `scroll="body"` dialog needs a RESOLVED height below `md`, not just
       * a cap. This is the third time this repo has paid for it.
       *
       * A native top-layer `<dialog>` laid out as a flex column with only a
       * `max-height` has an AUTO height — it shrinks to fit its content, and
       * its content height is the sum of its items' contributions. A
       * `flex-1 min-h-0` body has a flex basis of `0%`, and iOS Safari
       * contributes that basis (0) rather than the body's content. So the
       * container sizes itself to header + footer, the body resolves to zero,
       * and every engine that instead contributes the content size — desktop
       * Chrome, desktop Safari — renders it correctly. Shipping it therefore
       * looks fine right up to the moment an operator opens it on a phone.
       *
       * What that produced on an iPhone at 390px on 2026-08-14: a rule editor
       * whose body was EMPTY and whose Save/Cancel row painted on top of the
       * tab strip — the tab strip's own `<Tabs>` wrapper had collapsed to zero
       * too, so its children overflowed a box that occupied no space, and the
       * footer was laid out straight over them.
       *
       * `EventDetailPanel` and `PlateDetailPanel` each hit this and each fixed
       * it locally with `h-[92dvh] md:h-auto`; neither fed it back here, so
       * the primitive shipped the same defect a third time. It lives in the
       * primitive now. Those two still carry their own copy — they override
       * the whole class set rather than using `scroll="body"`, so folding them
       * in is a migration, not a deletion, and has not been done.
       *
       * `md:h-auto` restores the grow-to-content + cap behaviour on desktop,
       * where the box is a centred card and full height would be wrong.
       */
      {
        scroll: 'body',
        placement: 'sheet-on-mobile',
        class: 'h-[92dvh] md:h-auto',
      },
      {
        scroll: 'body',
        placement: 'center',
        // The same expression as the base `max-h`, so cap and height agree.
        // A `scroll="body"` dialog is one that declared its content is long;
        // below `md` it is worth the whole safe viewport.
        class:
          'h-[calc(100dvh-2rem-2*max(env(safe-area-inset-top),env(safe-area-inset-bottom)))] md:h-auto',
      },
    ],
    defaultVariants: { width: 'md', placement: 'center', scroll: 'content' },
  },
)

export interface DialogContentProps extends HTMLAttributes<HTMLDialogElement> {
  width?: 'sm' | 'md' | 'lg' | 'xl'
  scroll?: 'content' | 'body'
  placement?: 'center' | 'sheet-on-mobile'
}

export type DialogPlacement = NonNullable<DialogContentProps['placement']>

export const DialogContent: ForwardRefExoticComponent<
  DialogContentProps & RefAttributes<HTMLDialogElement>
> = forwardRef<HTMLDialogElement, DialogContentProps>(
  ({ className, width, placement, scroll, children, ...props }, ref) => {
    const { open, setOpen, contentId } = useDialogContext()
    const t = useUiText()
    const innerRef = useRef<HTMLDialogElement>(null)
    const dialogRef = (ref as React.RefObject<HTMLDialogElement>) ?? innerRef

    useEffect(() => {
      const el = dialogRef.current
      if (!el) return
      if (open && !el.open) el.showModal()
      if (!open && el.open) el.close()
    }, [open, dialogRef])

    // Backdrop / outside clicks must NOT dismiss. An accidental click on the
    // dimmed chrome used to close long editors (rules, targets) and the URL
    // restore race then made Cancel feel like it needed two presses. Escape
    // still closes via the native `cancel` → `close` path below.
    return (
      <dialog
        ref={dialogRef}
        id={contentId}
        className={cn(contentVariants({ width, placement, scroll }), className)}
        onClose={() => setOpen(false)}
        {...props}
      >
        <IconButton
          type="button"
          variant="ghost"
          size="sm"
          icon={X}
          aria-label={t('uiLibrary.dialog.close', 'Close')}
          className="absolute right-4 top-4 z-10 shrink-0"
          onClick={() => setOpen(false)}
        />
        {children}
      </dialog>
    )
  },
)

DialogContent.displayName = 'DialogContent'

/* ── Header / Body / Footer / Title / Description ── */

/** `shrink-0` is inert outside a flex column and load-bearing inside one:
 *  under `scroll="body"` the header must keep its height while the body gives
 *  ground, or a long form squeezes its own title to nothing. */
export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('flex flex-col gap-1 mb-3 shrink-0 pr-10', className)} {...props} />
}

/**
 * The scrolling middle of a `scroll="body"` dialog.
 *
 * `min-h-0` is what makes it work: a flex item's default `min-height: auto`
 * refuses to shrink below its content, so without it the body pushes the
 * footer out of the dialog instead of scrolling — the exact failure this
 * variant exists to remove. Anything sticky INSIDE a dialog body pins against
 * this element, since it is the scroll container.
 *
 * It only bounds a scroll area if every ancestor up to the dialog has a
 * resolved height. `DialogContent` supplies the top of that chain (see the
 * `scroll: 'body'` compound variants); an intermediate wrapper between them —
 * a `<Tabs>` that owns the tab strip, say — must carry `flex-1 min-h-0` too,
 * or it collapses and takes the body with it.
 */
export function DialogBody({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('flex-1 min-h-0 overflow-y-auto', className)} {...props} />
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('flex justify-end gap-2 mt-4 shrink-0', className)} {...props} />
}

export function DialogTitle({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>): JSX.Element {
  return <h2 className={cn('text-sm font-semibold text-foreground', className)} {...props} />
}

export function DialogDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>): JSX.Element {
  return <p className={cn('text-xs text-foreground-muted', className)} {...props} />
}
