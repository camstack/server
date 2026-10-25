/**
 * A keychain-stored secret in a settings form (D787, D789) — drawn as ONE
 * password input with an eye.
 *
 * The form never holds the value. It receives the field's VIEW —
 * `{ $secret, v, set: true }` when something is stored, `null` when nothing
 * is — and sends back exactly one of three things:
 *
 *  - the view, unchanged ........ KEEP (an untouched field sends nothing, so
 *                                 the hydrated view stays the value; a revealed
 *                                 value left as it was sends the view again);
 *  - a non-empty typed string ... CHANGE (the owner stores it in the keychain);
 *  - `{ $secretClear: true }` ... CLEAR — only when the operator emptied a box
 *                                 that showed a value they revealed or typed.
 *
 * `''` is never sent for "remove": the save path reads it as KEEP, because an
 * empty string is what a defaults fallback writes back. An untouched field
 * looks empty (a masked placeholder) and so can never clear by accident.
 *
 * The eye on an untouched stored secret asks the host's audited
 * `keychain-admin.reveal` (provided with {@link SecretRevealProvider}) for the
 * value; a host that provides none, or a pre-keychain inline value (no ref),
 * cannot reveal — the eye then only shows what the operator types.
 */
import {
  type ConfigField,
  isSecretClear,
  isSecretFieldView,
  SECRET_CLEAR,
  type SecretFieldView,
} from '@camstack/types'
import { type ReactNode, useContext, useEffect, useState, type JSX } from 'react'
import { createSharedContext } from '../lib/shared-context'
import { PasswordInput } from '../primitives/password-input'
import { useUiText, type UiTextFn } from '../contexts/ui-text'

/** Returns the stored value of a ref (audited by the host). */
export type SecretRevealFn = (ref: string) => Promise<string>

/** How long the System → Secrets page shows a revealed value. */
export const SECRET_REVEAL_MS = 10_000

/** What an untouched stored secret shows in place of its value. */
export const SECRET_MASK_PLACEHOLDER = '••••••••'

/** How long a refused reveal's reason stays on the eye. */
const REVEAL_ERROR_MS = 5_000

const SecretRevealContext = createSharedContext<SecretRevealFn | null>(
  'camstack:secret-reveal',
  null,
)

export function SecretRevealProvider({
  reveal,
  children,
}: {
  readonly reveal: SecretRevealFn
  readonly children: ReactNode
}): JSX.Element {
  return <SecretRevealContext.Provider value={reveal}>{children}</SecretRevealContext.Provider>
}

/** Does this value belong to the keychain rendering (a view, or "not set")? */
export function isKeychainFieldValue(value: unknown): boolean {
  return value === null || isSecretFieldView(value) || isSecretClear(value)
}

/**
 * What the operator has done to the field. `untouched` shows nothing and
 * sends nothing; `visible` holds text the operator can see — revealed (then
 * `revealed` is the stored value) or typed.
 */
export type SecretEntry =
  | { readonly kind: 'untouched' }
  | { readonly kind: 'visible'; readonly text: string; readonly revealed: string | null }

/**
 * The value the form sends for an entry. `stored` — something is stored (or
 * already marked for removal) — is what makes an emptied box a CLEAR.
 */
export function secretSubmitValue(
  entry: SecretEntry,
  original: SecretFieldView | null,
  stored: boolean,
): unknown {
  if (entry.kind === 'untouched') return original
  if (entry.text.length === 0) return stored ? SECRET_CLEAR : original
  return entry.text === entry.revealed ? original : entry.text
}

function initialEntry(value: unknown): SecretEntry {
  if (typeof value === 'string' && value.length > 0) {
    return { kind: 'visible', text: value, revealed: null }
  }
  if (isSecretClear(value)) return { kind: 'visible', text: '', revealed: null }
  return { kind: 'untouched' }
}

function placeholderFor(
  entry: SecretEntry,
  stored: boolean,
  fallback: string,
  t: UiTextFn,
): string {
  if (entry.kind === 'untouched') return stored ? SECRET_MASK_PLACEHOLDER : fallback
  return entry.text.length === 0 && stored
    ? t('uiLibrary.configSecretField.removedOnSave', 'Removed on save')
    : fallback
}

export interface SecretFieldProps {
  readonly field: ConfigField
  /** The view (or null) the form was hydrated with, or what the operator has done since. */
  readonly value: unknown
  readonly onChange: (value: unknown) => void
  readonly disabled?: boolean
  /** Multi-line entry (a PEM key). */
  readonly multiline?: boolean
}

export function SecretFieldControl({
  field,
  value,
  onChange,
  disabled,
  multiline,
}: SecretFieldProps): JSX.Element {
  const t = useUiText()
  const reveal = useContext(SecretRevealContext)
  // The view the form was hydrated with: KEEP is "send this back".
  const [original] = useState<SecretFieldView | null>(() =>
    isSecretFieldView(value) ? value : null,
  )
  const [stored] = useState(() => isSecretFieldView(value) || isSecretClear(value))
  const [entry, setEntry] = useState<SecretEntry>(() => initialEntry(value))
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (error === null) return
    const timer = setTimeout(() => setError(null), REVEAL_ERROR_MS)
    return () => clearTimeout(timer)
  }, [error])

  const ref = original?.$secret ?? null
  const mustReveal = entry.kind === 'untouched' && stored
  const canReveal = ref !== null && reveal !== null
  const blockedReason =
    mustReveal && !canReveal
      ? t(
          'uiLibrary.configSecretField.cannotReveal',
          'This stored value cannot be revealed here — type to replace it',
        )
      : null

  const edit = (text: string): void => {
    const next: SecretEntry = {
      kind: 'visible',
      text,
      revealed: entry.kind === 'visible' ? entry.revealed : null,
    }
    setError(null)
    setEntry(next)
    onChange(secretSubmitValue(next, original, stored))
  }

  const pressEye = (): void => {
    if (!mustReveal) {
      setShown((s) => !s)
      return
    }
    if (ref === null || reveal === null) return
    setError(null)
    setBusy(true)
    reveal(ref).then(
      (plain) => {
        setBusy(false)
        // Seeing the value is not changing it: nothing is sent.
        setEntry({ kind: 'visible', text: plain, revealed: plain })
        setShown(true)
      },
      (err: unknown) => {
        setBusy(false)
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  const label = 'label' in field ? field.label : ''
  const fallbackPlaceholder =
    'placeholder' in field && typeof field.placeholder === 'string' ? field.placeholder : ''

  return (
    <div data-secret-field={'key' in field ? field.key : undefined}>
      <PasswordInput
        aria-label={label}
        value={entry.kind === 'visible' ? entry.text : ''}
        onValueChange={edit}
        placeholder={placeholderFor(entry, stored, fallbackPlaceholder, t)}
        shown={shown}
        onToggleShown={pressEye}
        busy={busy}
        error={error}
        toggleBlockedReason={blockedReason}
        disabled={disabled}
        multiline={multiline}
      />
    </div>
  )
}
