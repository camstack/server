/**
 * The words a shared composite shows, resolved by the HOST.
 *
 * Serves the strings of ui-library's OWN components (tables, pickers, badges
 * and the like). The strings of an addon's pages and widgets are served by
 * `createAddonI18n` / `useAddonT` in `../i18n`; both follow the admin language
 * (the admin sets `<html lang>` AND mounts `AdminUiTextProvider`).
 *
 * This package ships no catalogue and no i18n dependency. A composite asks
 * `useUiText()` for `t(key, english, vars?)`: the English text is the fallback
 * and the key is what the host's catalogue (the admin UI's `i18n/*.json`, under
 * `uiLibrary.*`) translates. Without a provider the English fallback is
 * rendered, `{{var}}` interpolated, so a spec or a standalone page needs no
 * set-up.
 *
 * - Plurals: pass `count` and a `{ one, other }` fallback; the host resolves
 *   `key_one` / `key_other`. Never build a plural with a ternary suffix.
 * - Sentences with inline elements: `<UiTrans uiKey fallback components />`,
 *   the fallback marks each element as `<0>…</0>`, `<1>…</1>` and the host
 *   translates the whole sentence. Never concatenate fragments around elements.
 */
import {
  cloneElement,
  createContext,
  Fragment,
  type ReactElement,
  type ReactNode,
  useContext,
} from 'react'

export type UiTextVars = Readonly<Record<string, string | number | boolean | null | undefined>>

/** The English fallback: one string, or `{ one, other }` for a counted noun. */
export type UiTextFallback = string | { readonly one: string; readonly other: string }

export interface UiTextOptions extends UiTextVars {
  readonly count?: number
}

export type UiTextFn = (key: string, fallback: UiTextFallback, vars?: UiTextOptions) => string

const VAR = /\{\{\s*(\w+)\s*\}\}/g

function pickFallback(fallback: UiTextFallback, count: number | undefined): string {
  if (typeof fallback === 'string') return fallback
  return count === 1 ? fallback.one : fallback.other
}

/** English fallback with `{{var}}` interpolation; what renders without a host. */
export const defaultUiText: UiTextFn = (_key, fallback, vars) => {
  const text = pickFallback(fallback, vars?.count)
  if (!vars) return text
  return text.replace(VAR, (whole, name: string) => {
    const value = vars[name]
    return value === undefined || value === null ? whole : String(value)
  })
}

const UiTextContext = createContext<UiTextFn>(defaultUiText)

export function UiTextProvider({
  t,
  children,
}: {
  readonly t: UiTextFn
  readonly children: ReactNode
}): ReactElement {
  return <UiTextContext.Provider value={t}>{children}</UiTextContext.Provider>
}

export function useUiText(): UiTextFn {
  return useContext(UiTextContext)
}

const TAG = /<(\d+)>([\s\S]*?)<\/\1>/g

/** Split `a <0>b</0> c` into text and `components[0]` wrapped around `b`. */
export function renderTagged(
  text: string,
  components: readonly ReactElement[],
): readonly ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(TAG)) {
    const start = m.index ?? 0
    if (start > last) out.push(text.slice(last, start))
    const slot = components[Number(m[1])]
    out.push(slot ? cloneElement(slot, undefined, m[2] ?? '') : (m[2] ?? ''))
    last = start + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export interface UiTransProps {
  readonly uiKey: string
  readonly fallback: UiTextFallback
  readonly components?: readonly ReactElement[]
  readonly values?: UiTextOptions
}

/** A translated sentence whose `<0>…</0>` spans are wrapped in `components[0]`. */
export function UiTrans({ uiKey, fallback, components = [], values }: UiTransProps): ReactElement {
  const t = useUiText()
  const text = t(uiKey, fallback, values)
  const nodes = renderTagged(text, components)
  return (
    <>
      {nodes.map((node, i) => (
        <Fragment key={i}>{node}</Fragment>
      ))}
    </>
  )
}
