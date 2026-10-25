/**
 * The routing facts a parent reads OUT OF a cap call's args.
 *
 * `LocalChildRegistry` routes a child's `cap-call-out` on things it used to
 * read straight out of `args`: an inline `nodeId` (the historical per-call
 * node pin — `extractNodeId`), an `addonId` selector on a global collection
 * cap (`addonPinOf`), and — since D595 — the `provider` pin of a DEVICE
 * collection with the `deviceId` it applies to (`devicePinOf`). Under
 * raw-forward the parent never decodes `args`, so the SENDER lifts these
 * fields into the envelope, and the parent routes on the lifted copy in both
 * modes — one code path, whichever way the args travelled.
 *
 * ## Why `provider` and `deviceId` had to join them
 *
 * A field this envelope does not carry is a field the routing DECISION cannot
 * see, and that decision runs BEFORE `onUnownedCall`. D594 taught
 * `onUnownedCall` to honour a `{ provider }` pin on `videoclips` and wired
 * `isAddonPinnedCall` to recognise it — but `isAddonPinnedCall` is handed
 * THESE hints, not the args, so the predicate saw `{}`, answered false, and
 * the call was short-circuited to a sibling before the handler it was written
 * for could run. Correct and unreachable: the exact failure `addonPinOf`'s
 * own docblock records for the first attempt at the `addonId` fix, reproduced
 * a month later on the same shape (2026-09-22).
 *
 * `deviceId` rides along because a device pin is meaningless without it —
 * `provider` alone cannot say WHICH device's sources to narrow, and a pin that
 * cannot be resolved is not a pin.
 *
 * Only top-level scalar fields are lifted, which is exactly what the readers
 * ever looked at. Nothing else about the args is visible to the parent under
 * raw-forward, and that is the point.
 */
export interface CapRoutingHints {
  readonly nodeId?: string
  readonly addonId?: string
  /** The `{ provider }` pin of a device-collection cap (D554, D594). */
  readonly provider?: string
  /** The device that pin applies to. Lifted with it, never without it. */
  readonly deviceId?: number
}

/** Lift {@link CapRoutingHints} from a call's args. Never throws. */
export function liftRoutingHints(args: unknown): CapRoutingHints {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return {}
  const nodeId: unknown = Reflect.get(args, 'nodeId')
  const addonId: unknown = Reflect.get(args, 'addonId')
  const provider: unknown = Reflect.get(args, 'provider')
  const deviceId: unknown = Reflect.get(args, 'deviceId')
  return {
    ...(typeof nodeId === 'string' && nodeId.length > 0 ? { nodeId } : {}),
    ...(typeof addonId === 'string' && addonId.length > 0 ? { addonId } : {}),
    ...(typeof provider === 'string' && provider.length > 0 ? { provider } : {}),
    ...(typeof deviceId === 'number' && Number.isFinite(deviceId) ? { deviceId } : {}),
  }
}
