/** The consumables the device already has (`default-consumables.ts`), read live. */
import { useLiveValue } from './assignments/use-live-value'
import {
  CONSUMABLE_ITEMS_PATH,
  CONSUMABLES_CAP,
  type DefaultConsumable,
  defaultConsumables,
} from './default-consumables'
import type { Known } from './known'
import type { WireableCatalog } from './source-picker-model'

export function useDefaultConsumables(
  deviceId: number,
  nativeCaps: Known<ReadonlySet<string>>,
  catalog: Known<WireableCatalog>,
): Known<readonly DefaultConsumable[]> {
  const hasNativeItems = nativeCaps.kind === 'known' && nativeCaps.value.has(CONSUMABLES_CAP)
  const items = useLiveValue(
    hasNativeItems ? { deviceId, cap: CONSUMABLES_CAP, path: CONSUMABLE_ITEMS_PATH } : null,
  )
  return defaultConsumables(nativeCaps, catalog, hasNativeItems ? items : null)
}
