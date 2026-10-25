/**
 * useDevice — React Query hooks for the deviceManager tRPC router (device registry).
 *
 * Every hook takes the numeric `deviceId: number`. The hub's boot-time
 * storage sanitization guarantees every persisted device has a numeric
 * id, and the URL now carries it directly (`/devices/<numericId>`), so
 * the historical `stableId → numericId` translation layer is gone.
 * `stableId` is RESERVED for external linkage only (autodiscovery +
 * persistence row mapping); every internal hook below routes by the
 * canonical numeric `deviceId`.
 */
import {
  useDeviceManagerGetChildren,
  useDeviceManagerGetConfigSchema,
  useDeviceManagerGetDevice,
  useDeviceManagerListAll,
  useDeviceManagerUpdateConfig,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'

// ── Types inferred from device-manager cap output schemas ──────────────

/**
 * Mirror of `DeviceInfoSchema` (packages/types/src/capabilities/device-manager.cap.ts).
 * Phase-4 numeric-id world: `id` is the canonical handle; `parentDeviceId`
 * is numeric. `stableId` survives for display + the discovery flow only.
 */
export interface Device {
  id: number
  stableId: string
  addonId: string
  type: string
  /** Optional semantic role — `DeviceRole` string. `null` for top-level
   *  devices. Children carry this so the UI can pick the right icon
   *  / color without re-deriving from `type` + name. */
  role?: string | null
  name: string
  parentDeviceId: number | null
  online: boolean
  features: readonly string[]
  isCamera: boolean
  config: Record<string, unknown>
}

export interface DeviceConfigEntry {
  key: string
  value?: unknown
  description?: string
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/**
 * List all devices, optionally filtered by addonId.
 *
 * `slim` (no `config`/`metadata`, no per-device settings read) — every
 * current caller (the pipeline "Cameras" roster + assignment tables) only
 * reads id/name/isCamera.
 *
 * No query options: the 30 s caching window is registered once on the query
 * client (`applyFleetQueryDefaults`, D274), because `staleTime` is a
 * per-OBSERVER setting — a single one of the 26 `listAll` observers leaving it
 * at the app-wide default of 0 refetches the whole fleet on mount no matter
 * what the other 25 passed.
 */
export function useDeviceList(addonId?: string) {
  return useDeviceManagerListAll({ addonId, projection: 'slim' })
}

/** Get a single device by numeric id. */
export function useDevice(deviceId: number) {
  return useDeviceManagerGetDevice({ deviceId }, { enabled: Number.isFinite(deviceId) })
}

/** Get children of a device (devices whose parent id matches).
 *
 *  Cold-mount race defense: on a hard reload of the device-detail page,
 *  the FIRST query goes out before the WS auth handshake fully settles
 *  → silent empty/error response cached. Without route change there's
 *  no signal to refetch. Same defensive pattern we use for addon-pages:
 *
 *  - `staleTime: 0` + `refetchOnMount: 'always'` — every mount triggers
 *    a fresh round-trip
 *  - boot-window poll while empty (2s for 30s) — covers the post-boot
 *    moment when the WS just connected but hasn't fully resolved.
 *
 *  Steady state after the boot window: an empty result is honoured (no
 *  children = legitimate state — a top-level non-hub device).
 */
const DEVICE_CHILDREN_BOOT_WINDOW_MS = 30_000
const DEVICE_CHILDREN_POLL_INTERVAL_MS = 2_000

export function useDeviceChildren(parentDeviceId: number) {
  // Track per-hook-instance mount time so the poll only fires for THIS
  // device-detail page mount window, not globally.
  const mountedAtRef = useRef<number>(0)
  if (mountedAtRef.current === 0) mountedAtRef.current = Date.now()

  return useDeviceManagerGetChildren(
    { parentDeviceId },
    {
      enabled: Number.isFinite(parentDeviceId),
      staleTime: 0,
      refetchOnMount: 'always',
      refetchInterval: (query) => {
        const data = query.state.data
        if (data && data.length > 0) return false
        const elapsed = Date.now() - mountedAtRef.current
        if (elapsed >= DEVICE_CHILDREN_BOOT_WINDOW_MS) return false
        return DEVICE_CHILDREN_POLL_INTERVAL_MS
      },
    },
  )
}

/** Get serialized config entries (key, value, description) for a device. */
export function useDeviceConfig(deviceId: number) {
  return useDeviceManagerGetConfigSchema({ deviceId }, { enabled: Number.isFinite(deviceId) })
}

/**
 * Mutation to update config values on a device.
 *
 * Invalidates EVERY `deviceManager.*` query on success — narrow
 * invalidations (just `getDevice`/`getConfigSchema`) leave the
 * integration page's `listAll` snapshot stale, so a rename made on
 * the device detail page wouldn't propagate to the integration grid
 * card title without a hard refresh. The catch-all invalidation is
 * cheap (deviceManager queries are small + few) and the only
 * coherent option until we wire a `device.settings-updated` event
 * subscription on the relevant lists.
 *
 * TWO prefixes, because the UI has two key families and this hook was only
 * reaching one of them:
 *
 *  - `[['deviceManager']]` — the GENERATED tRPC hooks. A tRPC v11 key is
 *    `[[path…], { input, type }]`, so its first element is an ARRAY, and
 *    `partialMatchKey` compares element-wise. The single-nested
 *    `['deviceManager']` this used to pass compares a string against that
 *    array and matches nothing, so a config edit invalidated no `listAll`,
 *    no `getDevice`, no `getDeviceAggregate` — the exact staleness the
 *    docblock above claims to prevent. It read as verification.
 *  - `['deviceManager']` — hand-written `useQuery` keys that happen to start
 *    with the same string (`NotificationHistory.tsx:89`). The old form did
 *    reach these, so dropping it to "fix" the nesting would have traded one
 *    silent gap for another.
 */
export function useUpdateDeviceConfig(_deviceId: number) {
  const queryClient = useQueryClient()
  return useDeviceManagerUpdateConfig({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
      void queryClient.invalidateQueries({ queryKey: ['deviceManager'] })
    },
  })
}
