import type { UiTextFn } from '@camstack/ui-library'
import type { TFunction } from 'i18next'
import i18n from './index'

/** Adapts an i18next translator to the `(key, englishFallback, vars)` shape the ui-library speaks. */
export function bridgeUiText(translate: TFunction): UiTextFn {
  return (key, fallback, vars) => {
    const plural =
      typeof fallback === 'string'
        ? { defaultValue: fallback }
        : { defaultValue_one: fallback.one, defaultValue_other: fallback.other }
    return translate(key, { ...plural, ...vars })
  }
}

/** For plain functions (no hook): the app's live translator, in the ui-library's shape. */
export const adminUiText: UiTextFn = (key, fallback, vars) =>
  bridgeUiText(i18n.t.bind(i18n))(key, fallback, vars)
