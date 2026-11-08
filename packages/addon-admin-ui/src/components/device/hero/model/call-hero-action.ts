import type { HeroCall } from '@camstack/types'

/** `media-player` -> `mediaPlayer`: the router name the generated client gives a capability. */
export function capRouterName(cap: string): string {
  return cap.replace(/-([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase())
}

interface MutationLeaf {
  readonly mutate: (input: unknown) => Promise<unknown>
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
}

function isMutationLeaf(value: unknown): value is MutationLeaf {
  return isRecord(value) && typeof value['mutate'] === 'function'
}

/**
 * Run the cap method an action of the hero model names, on the hero's device.
 * The model carries only `{ cap, method, args }`; the renderer adds the device id
 * and, when the device's binding pins the cap to a node, that node.
 */
export function callHeroAction(
  client: unknown,
  call: HeroCall,
  deviceId: number,
  nodeId: string | undefined,
): Promise<unknown> {
  const router = capRouterName(call.cap)
  const cap = isRecord(client) ? client[router] : undefined
  const leaf = isRecord(cap) ? cap[call.method] : undefined
  if (!isMutationLeaf(leaf)) {
    return Promise.reject(new Error(`tRPC client has no mutation '${router}.${call.method}'`))
  }
  const input =
    nodeId === undefined ? { ...call.args, deviceId } : { ...call.args, deviceId, nodeId }
  return leaf.mutate(input)
}
