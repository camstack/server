/**
 * Resolve the secret VIEWS a form sends as action input (D789).
 *
 * A settings form knows a stored secret only as `{ $secret: ref, set: true }`.
 * An action that reads one from the form (`paramsFromForm`, e.g. "list my
 * Cloudflare zones with the stored token") therefore receives the view. The
 * owner's process swaps each view for its value before the action's input
 * schema runs — through the owner's own `ctx.secrets`, so a view naming
 * another addon's ref resolves to nothing (owner-checked by the keychain).
 *
 * A view that cannot be resolved (pre-keychain inline value, missing,
 * unavailable, forbidden) and an explicit clear instruction are DROPPED: the
 * action sees the parameter as absent, never as an object it would mis-read.
 */
import { isSecretClear, isSecretMarkerLike } from './secret-marker.js'
import type { SecretsAccess } from './secrets-access.js'

function viewRef(value: unknown): string | null {
  if (!isSecretMarkerLike(value)) return null
  const ref: unknown = Reflect.get(value as object, '$secret')
  return typeof ref === 'string' && ref.length > 0 ? ref : null
}

function collect(value: unknown, out: Set<string>): boolean {
  if (isSecretClear(value) || isSecretMarkerLike(value)) {
    const ref = viewRef(value)
    if (ref !== null) out.add(ref)
    return true
  }
  let found = false
  if (Array.isArray(value)) {
    for (const item of value) found = collect(item, out) || found
  } else if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) found = collect(child, out) || found
  }
  return found
}

export async function resolveSecretViewsIn(
  args: unknown,
  secrets: SecretsAccess | undefined,
): Promise<unknown> {
  const refs = new Set<string>()
  if (!collect(args, refs)) return args
  const answers = secrets !== undefined && refs.size > 0 ? await secrets.resolve([...refs]) : {}
  const swap = (value: unknown): { readonly keep: boolean; readonly value: unknown } => {
    if (isSecretClear(value) || isSecretMarkerLike(value)) {
      const ref = viewRef(value)
      const answer = ref !== null ? answers[ref] : undefined
      return answer?.kind === 'value'
        ? { keep: true, value: answer.value }
        : { keep: false, value: undefined }
    }
    if (Array.isArray(value)) {
      const items: unknown[] = []
      for (const item of value) {
        const s = swap(item)
        if (s.keep) items.push(s.value)
      }
      return { keep: true, value: items }
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, child] of Object.entries(value)) {
        const s = swap(child)
        if (s.keep) out[k] = s.value
      }
      return { keep: true, value: out }
    }
    return { keep: true, value }
  }
  return swap(args).value
}
