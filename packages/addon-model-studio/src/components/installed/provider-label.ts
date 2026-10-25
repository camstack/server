/**
 * The provider name shown on an Installed row / filter. The keys are the
 * stored provider ids; the labels name the mechanism. "custom" follows the
 * language.
 */
import type { ModelProviderId } from '@camstack/types'
import type { useT } from '../../i18n/index.js'

type ProviderT = ReturnType<typeof useT>['t']

const PRODUCT_NAME: Readonly<Record<string, string>> = {
  camstack: 'CamStack',
  scrypted: 'plugin catalog',
  frigate: 'plus catalog',
}

export function providerLabel(provider: ModelProviderId | string, t: ProviderT): string {
  if (provider === 'custom') return t('providers.custom')
  return PRODUCT_NAME[provider] ?? provider
}
