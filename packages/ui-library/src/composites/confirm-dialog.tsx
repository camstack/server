/**
 * The ONE modal dialog of the product — confirm, alert and prompt.
 *
 * ## Why all three live here
 *
 * The admin UI used to reach for `window.confirm` / `window.alert` /
 * `window.prompt` wherever a `useConfirm()` call was inconvenient. A native
 * dialog is wrong on three counts, and the operator hit the worst one on
 * Identity → Users: resetting a password opened `window.prompt`, which
 * **cannot mask its input**. A new password was typed in clear text, into a
 * box the browser may offer to remember. On top of that a native dialog
 * matches none of the product's visual language and the host can neither style
 * nor test it.
 *
 * So the fix is not "a password modal" — a second dialog component is the
 * defect, not the cure. The provider that already served every confirm in the
 * admin UI (and in the viewer, which documents its own copy as "deliberately
 * the same one `@camstack/ui-library` exposes to the admin UI") grew two more
 * intents. One provider, one backdrop, one visual language, one set of
 * keyboard rules.
 *
 * ## The three intents are NOT one control
 *
 * - `confirm` — a destructive yes/no. It names what is destroyed, and for the
 *   `danger` variant the destructive button is the NON-default: opening focus
 *   lands on Cancel, so a reflexive Enter cancels.
 * - `alert` — an error/notice with a single acknowledge.
 * - `prompt` — one text input with OK/Cancel. `inputType: 'password'` masks it
 *   (and opts out of autofill/remember); `readOnly` turns it into a readable,
 *   select-all-on-open field, which is the shape the copy-to-clipboard
 *   fallback needs — a password box would be actively wrong there.
 *
 * ## Why the surface is a native `<dialog>`
 *
 * These dialogs open OVER surfaces that are themselves native `<dialog>`s
 * opened with `showModal()` — the event detail panel, the similar-groups
 * modal. A `showModal()` dialog is promoted to the TOP LAYER and everything
 * outside it is inert, so a plain `fixed inset-0` overlay rendered at the app
 * root would be drawn behind that backdrop and could not be clicked at all.
 * Confirming a track delete from the detail panel would have been impossible.
 * So this surface is a `<dialog>` of its own: the top layer stacks, the newest
 * `showModal()` wins, and the confirm sits above the panel that asked for it.
 *
 * jsdom implements `<dialog>` but not `showModal()`, so the open falls back to
 * the `open` attribute there. Everything this component does — focus, keys,
 * resolution — is identical on both paths; only the top-layer promotion, which
 * jsdom cannot model at all, is missing. The fallback is asserted below.
 *
 * ## Focus, and why there is NO focus trap
 *
 * A `showModal()` dialog already scopes the tab ring to itself, and the
 * surfaces underneath (`SlideOverPanel`) implement no trap of their own. A
 * second, hand-rolled focus trap on top of that is how a page becomes
 * unescapable, so this component deliberately does not trap. What it does do:
 *
 * - focuses the input (prompt) or the DEFAULT button on open,
 * - restores focus to the previously focused element on close,
 * - handles Escape/Enter from a `keydown` on the dialog itself and calls
 *   `stopPropagation()`. React attaches its listeners at the root container, so
 *   stopping there keeps the event from reaching the `window` Escape listener
 *   of whatever modal is underneath: one Escape closes ONE dialog.
 */
import { useUiText } from '../contexts/ui-text'
import {
  type JSX,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createSharedContext } from '../lib/shared-context'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type DialogVariant = 'danger' | 'warning' | 'default'

export interface ConfirmOptions {
  readonly title: string
  readonly message: string
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  readonly variant?: DialogVariant
}

export interface AlertOptions {
  readonly title: string
  readonly message: string
  readonly acknowledgeLabel?: string
  readonly variant?: DialogVariant
}

export type PromptInputType = 'text' | 'password'

export interface PromptOptions {
  readonly title: string
  /** Explanatory paragraph above the field. */
  readonly message?: string
  /** Label rendered against the input. Defaults to the title. */
  readonly label?: string
  readonly defaultValue?: string
  /** `password` masks the value and opts out of autofill/remember. */
  readonly inputType?: PromptInputType
  readonly placeholder?: string
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  /**
   * A field the operator reads/copies rather than edits (the clipboard
   * fallback). Rendered unmasked, selected on open, with no validation.
   */
  readonly readOnly?: boolean
  /**
   * Returns an error message to REFUSE the value and keep the dialog open, or
   * `null` to accept. Runs on submit — the dialog is the validation surface, so
   * a refusal never needs a second `alert`.
   */
  readonly validate?: (value: string) => string | null
  /**
   * `danger` paints the affirmative button as destructive — a typed
   * confirmation ("type 17 to revoke 17 links") is a prompt whose OK destroys.
   * Focus still opens on the field. Default: `default`.
   */
  readonly variant?: DialogVariant
}

export interface DialogContextValue {
  readonly confirm: (options: ConfirmOptions) => Promise<boolean>
  readonly alert: (options: AlertOptions) => Promise<void>
  readonly prompt: (options: PromptOptions) => Promise<string | null>
}

const ConfirmContext = createSharedContext<DialogContextValue | null>(
  'camstack:confirm-dialog',
  null,
)

function useDialogContext(): DialogContextValue {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used within ConfirmDialogProvider')
  return ctx
}

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return useDialogContext().confirm
}

/** An error/notice with a single acknowledge. Replaces `window.alert`. */
export function useAlert(): (options: AlertOptions) => Promise<void> {
  return useDialogContext().alert
}

/** One text input with OK/Cancel. Replaces `window.prompt`. */
export function usePrompt(): (options: PromptOptions) => Promise<string | null> {
  return useDialogContext().prompt
}

// ---------------------------------------------------------------------------
// Internal state — one discriminated union, one open dialog at a time
// ---------------------------------------------------------------------------

interface ConfirmState {
  readonly kind: 'confirm'
  readonly options: ConfirmOptions
  readonly resolve: (value: boolean) => void
}

interface AlertState {
  readonly kind: 'alert'
  readonly options: AlertOptions
  readonly resolve: () => void
}

interface PromptState {
  readonly kind: 'prompt'
  readonly options: PromptOptions
  readonly resolve: (value: string | null) => void
}

type DialogState = ConfirmState | AlertState | PromptState

interface VariantStyle {
  readonly button: string
}

const VARIANT_STYLES: Record<DialogVariant, VariantStyle> = {
  // Semantic tokens only: `primary-foreground` is the theme's text-on-accent
  // colour (dark on the light dark-mode reds, white on the light-mode ones).
  danger: { button: 'bg-danger hover:bg-danger/90 text-primary-foreground' },
  warning: { button: 'bg-warning hover:bg-warning/90 text-primary-foreground' },
  default: { button: 'bg-primary hover:bg-primary/90 text-primary-foreground' },
}

const CANCEL_CLASS =
  'px-3 py-1.5 text-xs font-medium rounded-md border border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors'

function variantOf(state: DialogState): DialogVariant {
  return state.options.variant ?? 'default'
}

/**
 * Whether the affirmative button is the DEFAULT (initially focused) control.
 * A `danger` confirm says no: the destructive action must be deliberate.
 */
function affirmativeIsDefault(state: DialogState): boolean {
  return variantOf(state) !== 'danger'
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ConfirmDialogProvider({ children }: { children: ReactNode }): JSX.Element {
  const [dialog, setDialog] = useState<DialogState | null>(null)

  const confirm = useCallback(
    (options: ConfirmOptions): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        setDialog({ kind: 'confirm', options, resolve })
      }),
    [],
  )

  const alert = useCallback(
    (options: AlertOptions): Promise<void> =>
      new Promise<void>((resolve) => {
        setDialog({ kind: 'alert', options, resolve: () => resolve() })
      }),
    [],
  )

  const prompt = useCallback(
    (options: PromptOptions): Promise<string | null> =>
      new Promise<string | null>((resolve) => {
        setDialog({ kind: 'prompt', options, resolve })
      }),
    [],
  )

  const close = useCallback(() => setDialog(null), [])

  return (
    <ConfirmContext.Provider value={{ confirm, alert, prompt }}>
      {children}
      {dialog && <DialogSurface key={dialogKey(dialog)} state={dialog} onClose={close} />}
    </ConfirmContext.Provider>
  )
}

/**
 * A key that changes per OPENED dialog, so a second dialog opened while one is
 * showing remounts the surface (fresh input value, fresh focus) instead of
 * inheriting the previous one's state.
 */
function dialogKey(state: DialogState): string {
  return `${state.kind}:${state.options.title}`
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

interface DialogSurfaceProps {
  readonly state: DialogState
  readonly onClose: () => void
}

/**
 * Promotes `el` to the top layer. jsdom has `<dialog>` but no `showModal`, so
 * the attribute is the fallback — see the file docblock.
 */
export function openTopLayer(el: HTMLDialogElement): void {
  if (typeof el.showModal === 'function') el.showModal()
  else el.setAttribute('open', '')
}

function closeTopLayer(el: HTMLDialogElement): void {
  if (!el.open) return
  if (typeof el.close === 'function') el.close()
  else el.removeAttribute('open')
}

function DialogSurface({ state, onClose }: DialogSurfaceProps) {
  const t = useUiText()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const defaultButtonRef = useRef<HTMLButtonElement | null>(null)
  // One dialog resolves ONCE. Native `cancel` and our own key handler can both
  // fire for a single Escape; whichever lands first owns the answer.
  const settled = useRef(false)
  const [value, setValue] = useState(
    state.kind === 'prompt' ? (state.options.defaultValue ?? '') : '',
  )
  const [error, setError] = useState<string | null>(null)

  // Open, then focus; restore focus on close. No trap — see the file docblock.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const el = dialogRef.current
    if (el) openTopLayer(el)
    const input = inputRef.current
    if (input) {
      input.focus()
      if (state.kind === 'prompt' && state.options.readOnly === true) input.select()
    } else {
      defaultButtonRef.current?.focus()
    }
    return () => {
      if (el) closeTopLayer(el)
      previous?.focus()
    }
    // Focus is captured once, when this surface mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cancel = useCallback(() => {
    if (settled.current) return
    settled.current = true
    if (state.kind === 'confirm') state.resolve(false)
    else if (state.kind === 'prompt') state.resolve(null)
    else state.resolve()
    onClose()
  }, [state, onClose])

  const accept = useCallback(() => {
    if (settled.current) return
    if (state.kind === 'confirm') {
      settled.current = true
      state.resolve(true)
      onClose()
      return
    }
    if (state.kind === 'alert') {
      settled.current = true
      state.resolve()
      onClose()
      return
    }
    if (state.options.readOnly !== true) {
      const problem = state.options.validate?.(value) ?? null
      if (problem !== null) {
        setError(problem)
        inputRef.current?.focus()
        return
      }
    }
    settled.current = true
    state.resolve(state.options.readOnly === true ? null : value)
    onClose()
  }, [state, onClose, value])

  // Escape cancels, Enter takes the DEFAULT action. `stopPropagation` keeps the
  // key from also reaching the window listener of a modal underneath.
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDialogElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        cancel()
        return
      }
      if (e.key !== 'Enter') return
      // Inside the prompt input the form's submit already handles Enter.
      if (e.target === inputRef.current) return
      if (!affirmativeIsDefault(state)) return
      e.stopPropagation()
      e.preventDefault()
      accept()
    },
    [state, cancel, accept],
  )

  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      e.stopPropagation()
      accept()
    },
    [accept],
  )

  const style = VARIANT_STYLES[variantOf(state)]
  const titleId = 'camstack-dialog-title'

  const body =
    state.kind === 'prompt' ? (
      <PromptBody
        options={state.options}
        value={value}
        error={error}
        inputRef={inputRef}
        onChange={(next) => {
          setValue(next)
          setError(null)
        }}
      />
    ) : (
      // `pre-line`: a message may list items one per line (e.g. the nodes an
      // uninstall reaches); single-line messages render exactly as before.
      <p className="mt-2 text-xs text-foreground-subtle leading-relaxed whitespace-pre-line">
        {state.options.message}
      </p>
    )

  const footer =
    state.kind === 'alert' ? (
      <button
        type="button"
        ref={defaultButtonRef}
        onClick={accept}
        className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${style.button}`}
      >
        {state.options.acknowledgeLabel ?? t('uiLibrary.confirmDialog.ok', 'OK')}
      </button>
    ) : (
      <>
        <button
          type="button"
          ref={affirmativeIsDefault(state) ? null : defaultButtonRef}
          onClick={cancel}
          className={CANCEL_CLASS}
        >
          {state.options.cancelLabel ?? t('uiLibrary.confirmDialog.cancel', 'Cancel')}
        </button>
        {!(state.kind === 'prompt' && state.options.readOnly === true) && (
          <button
            type={state.kind === 'prompt' ? 'submit' : 'button'}
            ref={affirmativeIsDefault(state) ? defaultButtonRef : null}
            onClick={state.kind === 'prompt' ? undefined : accept}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${style.button}`}
          >
            {state.options.confirmLabel ??
              (state.kind === 'prompt'
                ? t('uiLibrary.confirmDialog.ok', 'OK')
                : t('uiLibrary.confirmDialog.confirm', 'Confirm'))}
          </button>
        )}
      </>
    )

  const inner = (
    <>
      <div className="px-5 pt-5 pb-4">
        <h3 id={titleId} className="text-sm font-semibold text-foreground">
          {state.options.title}
        </h3>
        {body}
      </div>
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-surface-hover/30">
        {footer}
      </div>
    </>
  )

  return (
    // Tailwind preflight zeroes the UA stylesheet's `dialog { margin: auto }`,
    // so a top-layer dialog is centred explicitly — the same arithmetic the
    // `DialogContent` primitive documents.
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        // Native Escape. We answer it ourselves so the promise resolves.
        e.preventDefault()
        cancel()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel()
      }}
      className="fixed left-1/2 top-1/2 z-50 m-0 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-surface p-0 text-foreground shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm [&:not([open])]:hidden"
    >
      {state.kind === 'prompt' ? <form onSubmit={onSubmit}>{inner}</form> : inner}
    </dialog>
  )
}

interface PromptBodyProps {
  readonly options: PromptOptions
  readonly value: string
  readonly error: string | null
  readonly inputRef: RefObject<HTMLInputElement | null>
  readonly onChange: (next: string) => void
}

function PromptBody({ options, value, error, inputRef, onChange }: PromptBodyProps) {
  const readOnly = options.readOnly === true
  // A masked field must also refuse autofill and the browser's save-password
  // offer — `new-password` is the value browsers honour for "this is not a
  // credential to remember".
  const isPassword = !readOnly && options.inputType === 'password'
  const inputId = 'camstack-dialog-input'

  return (
    <>
      {options.message !== undefined && (
        // `pre-line`, like the confirm body: a typed confirmation lists what it
        // is about to act on, one row per line.
        <p className="mt-2 max-h-48 overflow-y-auto text-xs text-foreground-subtle leading-relaxed whitespace-pre-line">
          {options.message}
        </p>
      )}
      <label
        htmlFor={inputId}
        className="mt-3 block text-[11px] font-medium text-foreground-subtle"
      >
        {options.label ?? options.title}
      </label>
      <input
        id={inputId}
        ref={inputRef}
        type={isPassword ? 'password' : 'text'}
        value={value}
        readOnly={readOnly}
        placeholder={options.placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={readOnly ? (e) => e.currentTarget.select() : undefined}
        autoComplete={isPassword ? 'new-password' : 'off'}
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary"
      />
      {error !== null && <p className="mt-1.5 text-[11px] text-danger">{error}</p>}
    </>
  )
}
