/**
 * Provider discovery — the pure mapping behind the orchestrator's
 * `storage.listProviders` cap handler.
 *
 * Walks every registered `storage-provider`, collects each one's
 * `getProviderInfo()` blob, and projects it into the `storage` cap's
 * `listProviders` output shape (including the intrinsic disk-space
 * policy fields `shouldSaveDiskSpace` + `minFreePercent`). Errors from
 * individual providers are isolated via `onError` — a single misbehaving
 * driver never denies the whole list.
 *
 * Extracted from the addon handler so the projection is unit-testable
 * without booting a `BaseAddon`.
 */
import type { IStorageCapProvider, IStorageProviderImpl } from '@camstack/types'

/** One entry of the `storage.listProviders` output array. */
export type StorageProviderListEntry = Awaited<
  ReturnType<IStorageCapProvider['listProviders']>
>[number]

/**
 * Callback invoked when a provider's `getProviderInfo()` throws. The array
 * `index` is passed so the orchestrator can identify which provider failed —
 * `getProviderInfo()` itself threw, so there is no static id to log otherwise.
 */
export type ProviderInfoErrorHandler = (
  provider: IStorageProviderImpl,
  error: unknown,
  index: number,
) => void

export async function collectProviderInfos(
  providers: readonly IStorageProviderImpl[],
  onError: ProviderInfoErrorHandler,
): Promise<StorageProviderListEntry[]> {
  const out: StorageProviderListEntry[] = []
  for (const [index, p] of providers.entries()) {
    try {
      const info = await p.getProviderInfo()
      out.push(info)
    } catch (err: unknown) {
      onError(p, err, index)
    }
  }
  return out
}
