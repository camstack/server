/**
 * Where the pickers get their choices — and why none of them is a list kept in
 * this repo by hand.
 *
 *  - **Devices** come from `deviceManager.listAll`, slim: the editor needs a
 *    name, a numeric id and a `stableId`, and nothing that a full projection
 *    would spend a per-device settings read to produce.
 *  - **A device's capabilities** come from its OWN bindings, exactly as the
 *    notification-rule action editor does it. A cap typed by hand is a step that
 *    fails at actuation time, minutes later, in a log.
 *  - **A capability's methods** come from `METHOD_ACCESS_MAP`, which codegen
 *    writes from the cap files. Device-scoped and non-`view` only: an automation
 *    action actuates, and offering a query as an action produces a step that
 *    "succeeds" having changed nothing.
 *  - **A capability's fields** come from `deviceManager.getWireableFields`,
 *    which also reports each field's kind — the input to
 *    `operatorsForFieldKind`.
 */

import { isDoPickerDeviceType, METHOD_ACCESS_MAP } from '@camstack/types'
import { useDeviceManagerListAll, useSystem } from '@camstack/ui-library'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { WireableCap } from './recipe-parts'

/** What a picker needs to name a device. `stableId` is here because an
 *  expression binding addresses a device by it — a numeric id is reissued on
 *  re-adoption and would silently re-point the binding at something else. */
export interface AutomationDevice {
  readonly id: number
  readonly name: string
  readonly stableId: string
  readonly type?: string
  readonly location?: string | null
}

/** Catalogs change when a device is added, not while a form is open. */
const CATALOG_STALE_MS = 60_000

/**
 * The device picker's choices, off the SHARED fleet query.
 *
 * `slim` was already right; the client was not. This was a raw
 * `trpcClient.deviceManager.listAll.query()` under the private key
 * `['automation','devices']` with its own 60 s window — invisible to the D274
 * registration (which matches the tRPC key prefix `[['deviceManager','listAll']]`)
 * and to the ~20 `[['deviceManager']]` invalidations, so a device renamed or
 * adopted while the editor was open never appeared. Reads `id`, `name`,
 * `stableId`; slim carries all three.
 */
export function useAutomationDevices(): readonly AutomationDevice[] {
  const fleet = useDeviceManagerListAll({ projection: 'slim' })
  return useMemo(
    (): readonly AutomationDevice[] =>
      (fleet.data ?? [])
        // Containers are parent grouping nodes — never automation targets.
        .filter((d) => isDoPickerDeviceType(String(d.type)))
        .map((d) => ({
          id: d.id,
          name: d.name,
          stableId: d.stableId,
          type: String(d.type),
          location: d.location ?? null,
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    [fleet.data],
  )
}

/** Bound caps for one device — shared hook with NC Sequences / Do. */
export { useDeviceBoundCaps as useDeviceCaps } from '../../../components/device-do-action/use-device-bound-caps'

export function useWireableFields(deviceId: number): UseQueryResult<readonly WireableCap[]> {
  const system = useSystem()
  return useQuery({
    queryKey: ['automation', 'wireable-fields', deviceId],
    enabled: deviceId > 0,
    staleTime: CATALOG_STALE_MS,
    queryFn: async (): Promise<readonly WireableCap[]> => {
      const res = await system.trpcClient.deviceManager.getWireableFields.query({ deviceId })
      return res.caps
    },
  })
}

/** The fields of one capability, or nothing when that cap reports none. */
export function fieldsOfCap(caps: readonly WireableCap[], cap: string): WireableCap['fields'] {
  return caps.find((c) => c.cap === cap)?.fields ?? []
}

/**
 * Every device-scoped capability the installation knows about.
 *
 * The fallback for an action whose target is `{$var}` — the device that fired
 * the trigger, which has no id at authoring time and therefore no bindings to
 * read. Offering the full device vocabulary is honest about that: the action
 * runner still refuses at run time if the device that arrives does not have the
 * cap, and it says so.
 */
export function allDeviceCapNames(): readonly string[] {
  const caps = new Set<string>()
  for (const record of Object.values(METHOD_ACCESS_MAP)) {
    if (record.capScope === 'device') caps.add(record.capName)
  }
  return [...caps].sort((a, b) => a.localeCompare(b))
}

/**
 * Every method an automation may call on a capability.
 *
 * Derived from the generated access map rather than listed: `view` methods are
 * excluded because an action that reads is an action that does nothing, and
 * system-scoped caps are excluded because the action runner refuses them — a
 * choice the operator can make and the runner then rejects is worse than no
 * choice at all.
 */
export function actuatableMethodsForCap(cap: string): readonly string[] {
  if (cap === '') return []
  const methods = new Set<string>()
  for (const [path, record] of Object.entries(METHOD_ACCESS_MAP)) {
    if (record.capName !== cap) continue
    if (record.capScope !== 'device') continue
    if (record.access === 'view') continue
    const method = path.slice(path.indexOf('.') + 1)
    if (method !== '') methods.add(method)
  }
  return [...methods].sort((a, b) => a.localeCompare(b))
}
