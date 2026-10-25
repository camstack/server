/**
 * Map a provider type/entry `iconAsset` (path under the addon package) to the
 * hub-served URL the pill / Add dialog `<img>` can load.
 */
import { hubPath } from '@camstack/ui-library'

export function providerIconUrl(addonId: string, iconAsset: string): string | null {
  const trimmed = iconAsset.trim()
  if (trimmed.length === 0 || trimmed.includes('..')) return null
  return hubPath(`/api/addon-assets/${encodeURIComponent(addonId)}/${trimmed}`)
}
