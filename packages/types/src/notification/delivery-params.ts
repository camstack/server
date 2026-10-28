/**
 * Delivery parameters a notifier kind declares and a rule target carries (D938).
 *
 * Pure, shared by the dispatcher (what reaches `send`) and the rule editor
 * (what it offers), so the two cannot disagree about which keys exist.
 */
import type { DeliveryParam, DeliveryParamValue } from '../capabilities/notification-output.cap.js'

function valueFor(param: DeliveryParam, raw: unknown): DeliveryParamValue | undefined {
  switch (param.type) {
    case 'enum':
      return typeof raw === 'string' && (param.options ?? []).some((o) => o.value === raw)
        ? raw
        : undefined
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
      const floor = param.min ?? Number.NEGATIVE_INFINITY
      const ceil = param.max ?? Number.POSITIVE_INFINITY
      return Math.min(ceil, Math.max(floor, raw))
    }
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined
    case 'string':
      return typeof raw === 'string' && raw.length > 0 ? raw : undefined
  }
}

/**
 * The values a rule target's `params` contribute for a kind: only declared
 * keys, only valid values. `undefined` when nothing survives — a notifier that
 * declared nothing is never handed a `delivery` block.
 */
export function resolveDeliveryParams(
  declared: readonly DeliveryParam[] | undefined,
  params: Readonly<Record<string, unknown>> | undefined,
): Record<string, DeliveryParamValue> | undefined {
  if (declared === undefined || params === undefined) return undefined
  const out: Record<string, DeliveryParamValue> = {}
  for (const param of declared) {
    const value = valueFor(param, params[param.key])
    if (value !== undefined) out[param.key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** The union of several kinds' declarations; the first declaration of a key wins. */
export function deliveryParamsDeclaredBy(
  perKind: readonly (readonly DeliveryParam[] | undefined)[],
): readonly DeliveryParam[] {
  const seen = new Set<string>()
  const out: DeliveryParam[] = []
  for (const declared of perKind) {
    for (const param of declared ?? []) {
      if (seen.has(param.key)) continue
      seen.add(param.key)
      out.push(param)
    }
  }
  return out
}
