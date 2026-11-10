import { METHOD_DEVICE_SELECTORS, type HeroCall } from '@camstack/types'

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

/** The method names the device in its input: only then does the call carry `deviceId`. */
export function methodTakesDevice(call: HeroCall): boolean {
  const refs = METHOD_DEVICE_SELECTORS[`${capRouterName(call.cap)}.${call.method}`]
  return refs !== undefined && refs.some((ref) => ref.name === 'deviceId')
}

/**
 * The input a hero call sends. The generated device selectors say whether the method
 * addresses a device; a method that does not (a singleton cap, a void-input method) gets
 * no `deviceId`, and one with nothing to send gets no input at all.
 */
export function heroCallInput(
  call: HeroCall,
  deviceId: number,
  nodeId: string | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const input = {
    ...call.args,
    ...(methodTakesDevice(call) ? { deviceId } : {}),
    ...(nodeId === undefined ? {} : { nodeId }),
  }
  return Object.keys(input).length === 0 ? undefined : input
}

/**
 * Run the cap method an action of the hero model names, on the hero's device.
 * The model carries only `{ cap, method, args }`; the renderer adds the device id
 * when the method addresses a device and, when the binding pins the cap to a node, that node.
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
  return leaf.mutate(heroCallInput(call, deviceId, nodeId))
}
