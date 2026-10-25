/**
 * Read a device-proxy state slice, refreshing ONLY when it has never loaded.
 *
 * Both zone readers used to spell this out as:
 *
 *   const cached = proxy.state.X.value?.list
 *   if (cached && cached.length > 0) return cached
 *   await proxy.state.X.refresh()
 *
 * which cannot cache an EMPTY answer. A camera with no zones and a camera whose
 * slice has not loaded are indistinguishable under that test, so every device
 * that legitimately has none paid a `refresh()` round-trip on EVERY call,
 * forever — a cache miss no amount of warming can satisfy.
 *
 * Measured cost of that: `listEventKindsBatch` over 16 cameras took 4190 ms
 * cold / 1197 ms warm, because 15 of the 16 have no package-zone rule and so
 * re-fetched their slice on each pass. `resolveDeviceZones` has the same shape
 * and sits on the per-frame detection path.
 *
 * `SliceHandle.value` already answers the real question — its contract is
 * "`undefined` if neither a `refresh()` nor a push event has happened" — and
 * once loaded the slice is kept current by push plus the reconcile timer (D8).
 * So `undefined` is the ONLY state that warrants a fetch; a loaded-but-empty
 * slice is a real answer and is returned as one.
 */

import type { SliceHandle } from '@camstack/types'

/**
 * The loaded slice, or `undefined` when it has never loaded and the one
 * permitted refresh also failed to produce it.
 *
 * A failing refresh is swallowed deliberately: every caller degrades to "no
 * zones / no rules", and a zone read must never take down the frame that asked.
 */
export async function readSliceOnce<T>(handle: SliceHandle<T>): Promise<T | undefined> {
  // Loaded — including loaded-and-empty. Never re-fetch on this path.
  const loaded = handle.value
  if (loaded !== undefined) return loaded

  await handle.refresh().catch(() => undefined)
  return handle.value
}
