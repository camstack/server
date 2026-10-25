import { INFRA_CAPABILITIES } from './infra-capabilities.js'

const INFRA_NAMES = new Set(INFRA_CAPABILITIES.map((c) => c.name))

/**
 * Isolated builtins are not one spawn wave.
 *
 * Snapshot (D123) persists behind `settings-store`, so it must boot AFTER
 * the in-process door. sqlite-settings IS the engine behind that door: spawn
 * it in the consumer wave and every in-process builtin initialises against a
 * missing store — the D44 empty-read failure, just with a fork in the way.
 *
 * `infra` = provides a capability in {@link INFRA_CAPABILITIES} → spawn
 * BEFORE in-process builtins. `consumer` = everything else → spawn AFTER.
 */
export interface CapabilityName {
  readonly name: string
}

export type IsolatedBuiltinPhase = 'infra' | 'consumer'

export function isolatedBuiltinPhase(
  capabilities: readonly CapabilityName[],
): IsolatedBuiltinPhase {
  return capabilities.some((c) => INFRA_NAMES.has(c.name)) ? 'infra' : 'consumer'
}

export interface IsolatedBuiltinWaves {
  readonly infra: readonly string[]
  readonly consumers: readonly string[]
}

export function partitionIsolatedBuiltinIds(
  ids: readonly string[],
  capabilitiesOf: (id: string) => readonly CapabilityName[],
): IsolatedBuiltinWaves {
  const infra: string[] = []
  const consumers: string[] = []
  for (const id of ids) {
    if (isolatedBuiltinPhase(capabilitiesOf(id)) === 'infra') infra.push(id)
    else consumers.push(id)
  }
  return { infra, consumers }
}

export interface WaitUntilReadyOptions {
  readonly timeoutMs: number
  readonly intervalMs: number
  readonly what: string
}

/**
 * Spawn of an infra isolate returns when the child process exists, not when
 * its UDS handshake has put the engine in the parent's `getCollection`.
 * In-process builtins that read the door before that handshake throw D44
 * ("nothing behind it") and are skipped for the rest of the boot.
 */
export async function waitUntilReady(
  isReady: () => boolean,
  options: WaitUntilReadyOptions,
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    if (isReady()) return
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${options.what}`)
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, options.intervalMs)
    })
  }
}

/**
 * Hub boot waves after the isolated sqlite engine exists as a process.
 *
 * Spawn of that engine returns when the child exists, not when
 * `data-store-provider` is in the parent's collection, and not when the
 * in-process `settings-store` door has booted. Forked addons that
 * `resolveConfig()` before both of those see constructor defaults — on
 * 2026-08-25 cloudflare-tunnel auto-started a quick tunnel and the named
 * hostname the notification centre still minted went Cloudflare 530.
 *
 * `waitUntilReady` yields via `setTimeout`; the 1.2.151 deadlock was the
 * engine's own `resolveConfig` waiting on a door that this sequence had
 * not built yet (fixed: sqlite skips that read), not this wait blocking
 * the UDS read. A timeout in the caller must still not throw.
 */
export interface HubAddonBootSteps {
  readonly spawnIsolatedInfra: () => Promise<void>
  readonly waitForDataStoreProvider: () => Promise<void>
  readonly bootInProcessInfra: () => Promise<void>
  readonly spawnForkedAddons: () => Promise<void>
  readonly bootInProcessConsumers: () => Promise<void>
  readonly spawnIsolatedConsumers: () => Promise<void>
}

export async function runHubAddonBoot(steps: HubAddonBootSteps): Promise<void> {
  await steps.spawnIsolatedInfra()
  await steps.waitForDataStoreProvider()
  await steps.bootInProcessInfra()
  await steps.spawnForkedAddons()
  await steps.bootInProcessConsumers()
  await steps.spawnIsolatedConsumers()
}
