import { UiTextProvider } from '@camstack/ui-library'
import { type ReactElement, type ReactNode, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { bridgeUiText } from './ui-text-bridge'

/**
 * Hands the shared composites of `@camstack/ui-library` (which carries no
 * catalogue) this app's translator: their `uiLibrary.*` keys resolve in
 * `en.json` / `it.json`, with the English fallback they ship as the default.
 */
export function AdminUiTextProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const { t: translate } = useTranslation()
  const t = useMemo(() => bridgeUiText(translate), [translate])
  return <UiTextProvider t={t}>{children}</UiTextProvider>
}
