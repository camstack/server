import {
  cloneElement,
  Fragment,
  type ReactElement,
  type ReactNode,
  useCallback,
  useSyncExternalStore,
} from 'react'
import {
  addonI18nSnapshot,
  currentAddonLanguage,
  interpolate,
  normalizeLanguage,
  registerAddonBundle,
  subscribeAddonI18n,
  type TranslationKey,
  type TranslationTree,
  type TranslationVars,
  translateAddonKey,
} from './addon-i18n'

/** Translate one key of the namespace this function was made for. */
export type AddonTFunction<K extends string = string> = (key: K, vars?: TranslationVars) => string

export interface AddonT<K extends string = string> {
  readonly t: AddonTFunction<K>
  /** The language in effect (`en`, `it`, ...). */
  readonly lang: string
}

/** Re-render when the host switches language or a bundle is (re)registered. */
function useI18nSnapshot(): string {
  return useSyncExternalStore(subscribeAddonI18n, addonI18nSnapshot, addonI18nSnapshot)
}

/**
 * `t` for one addon namespace. The language is the host's; `langOverride` is
 * for a widget the host hands an explicit language (the pre-auth login page).
 * Prefer the typed `useT` that
 * {@link createAddonI18n} returns; this is the untyped form behind it.
 */
export function useAddonT<K extends string = string>(ns: string, langOverride?: string): AddonT<K> {
  const snapshot = useI18nSnapshot()
  const hostLang = snapshot.slice(0, snapshot.indexOf('#'))
  const lang = langOverride === undefined ? hostLang : normalizeLanguage(langOverride)
  const t = useCallback<AddonTFunction<K>>(
    (key, vars) => translateAddonKey(ns, lang, key, vars),
    // `snapshot` is the cache key: a new bundle changes answers without changing `lang`.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
    [ns, lang, snapshot],
  )
  return { t, lang }
}

const TAG = /<(\/?)([A-Za-z][\w-]*)(\s*\/)?>/g

interface OpenTag {
  readonly name: string
  readonly children: ReactNode[]
}

function wrap(
  components: Readonly<Record<string, ReactElement>>,
  name: string,
  children: readonly ReactNode[],
  key: string,
): ReactNode {
  const component = components[name]
  if (component === undefined) return <Fragment key={key}>{children}</Fragment>
  return cloneElement(component, { key }, ...children)
}

/**
 * Render a message that mixes text with inline elements. The message marks them
 * with named tags (`Delete <b>{{name}}</b>?`); `components` maps each tag name
 * to the element that wraps its content. Placeholders are interpolated into
 * the text nodes only, so a value containing `<` can never become markup.
 */
export function renderMarkup(
  message: string,
  components: Readonly<Record<string, ReactElement>>,
  vars: TranslationVars | undefined,
): ReactNode[] {
  const root: OpenTag = { name: '', children: [] }
  const stack: OpenTag[] = [root]
  let cursor = 0
  let counter = 0
  const top = (): OpenTag => stack[stack.length - 1] ?? root
  const pushText = (text: string): void => {
    if (text !== '') top().children.push(interpolate(text, vars))
  }
  for (const match of message.matchAll(TAG)) {
    pushText(message.slice(cursor, match.index))
    cursor = match.index + match[0].length
    const closing = match[1] === '/'
    const name = match[2] ?? ''
    counter += 1
    if (match[3] !== undefined) {
      top().children.push(wrap(components, name, [], `k${counter}`))
    } else if (!closing) {
      stack.push({ name, children: [] })
    } else if (stack.length > 1 && top().name === name) {
      const done = stack.pop()
      if (done) top().children.push(wrap(components, name, done.children, `k${counter}`))
    }
  }
  pushText(message.slice(cursor))
  while (stack.length > 1) {
    const done = stack.pop()
    if (done) top().children.push(...done.children)
  }
  return root.children
}

export interface AddonTransProps<K extends string> {
  readonly i18nKey: K
  readonly values?: TranslationVars
  /** Tag name used in the message -> the element wrapping that tag's content. */
  readonly components?: Readonly<Record<string, ReactElement>>
}

export interface AddonI18n<K extends string> {
  readonly ns: string
  /** Typed `t` bound to this addon's namespace. */
  readonly useT: (langOverride?: string) => AddonT<K>
  /**
   * `t` outside React (a class component, a helper that builds an error
   * message): answers in the language in effect NOW, does not re-render.
   */
  readonly translate: AddonTFunction<K>
  /** A sentence with inline elements; never concatenate translated fragments. */
  readonly Trans: (props: AddonTransProps<K>) => ReactElement
}

export type AddonBundles<T extends TranslationTree> = { readonly en: T } & Readonly<
  Record<string, TranslationTree>
>

/**
 * Register an addon's bundled JSON under its namespace and return the hooks its
 * components use. The bundles are only the INITIAL content of the registry: a
 * later hub-served bundle replaces them through `registerAddonBundle` and no
 * call site changes.
 *
 * ```ts
 * import en from './en.json'
 * import it from './it.json'
 * export const { useT, Trans } = createAddonI18n('model-studio', { en, it })
 * ```
 */
export function createAddonI18n<T extends TranslationTree>(
  ns: string,
  bundles: AddonBundles<T>,
): AddonI18n<TranslationKey<T>> {
  for (const [lang, tree] of Object.entries(bundles)) registerAddonBundle(ns, lang, tree)
  const useT = (langOverride?: string): AddonT<TranslationKey<T>> =>
    useAddonT<TranslationKey<T>>(ns, langOverride)
  const Trans = (props: AddonTransProps<TranslationKey<T>>): ReactElement => {
    const { t } = useAddonT<TranslationKey<T>>(ns)
    // Only `count` goes to the lookup (it picks the plural form); every other
    // placeholder is filled by the markup pass, into text nodes only.
    const count = props.values?.['count']
    const message = t(props.i18nKey, typeof count === 'number' ? { count } : undefined)
    return <>{renderMarkup(message, props.components ?? {}, props.values)}</>
  }
  const translate: AddonTFunction<TranslationKey<T>> = (key, vars) =>
    translateAddonKey(ns, currentAddonLanguage(), key, vars)
  return { ns, useT, Trans, translate }
}
