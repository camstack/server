/**
 * Provider discovery — the pure collection behind the storage location instances' provider select
 * and form.
 *
 * Walks every registered `storage-provider` and collects each one's `getProviderInfo()` blob (its
 * config schema and the intrinsic disk-space policy fields `shouldSaveDiskSpace` +
 * `minFreePercent`). Errors from individual providers are isolated via `onError` — a single
 * misbehaving driver never denies the whole list.
 *
 * Extracted from the addon so the collection is unit-testable without booting a `BaseAddon`.
 */
import type { IStorageProviderImpl } from '@camstack/types'

/** One provider's `getProviderInfo()` answer. */
export type StorageProviderListEntry = Awaited<ReturnType<IStorageProviderImpl['getProviderInfo']>>

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
