/**
 * Process-wide holder for the {@link LogChannelRegistry}.
 *
 * Three call sites that never meet need the SAME instance: the hot paths that
 * declare a gate at module scope, the `log-channels` provider that enumerates
 * the declarations for the hub, and the same provider applying the windows the
 * document hands down. A registry built inside any one of them would be
 * refreshed and collected — the shape of a knob that never does anything.
 *
 * Same idiom as `logging-gate.singleton.ts` and
 * `http-request-census.singleton.ts`.
 */

import {
  LogChannelRegistry,
  type LogChannelDescriptor,
  type LogChannelGate,
} from './log-channel.js'

let instance: LogChannelRegistry | null = null

/** The process-wide log channel registry. Created empty on first use. */
export function getLogChannelRegistry(): LogChannelRegistry {
  instance ??= new LogChannelRegistry()
  return instance
}

/**
 * Declare a channel on the process-wide registry and get its gate.
 *
 * The one call an addon makes. Keep the returned gate in a module-scope
 * `const`: looking a channel up by name per line would put a Map lookup on
 * exactly the path this mechanism exists to keep free.
 *
 * `scripts/check-log-channel-gated.ts` reads these call sites. It pairs the
 * declared name with the binding it is assigned to and refuses to let a
 * channel ship that no `<binding>.on` anywhere consults — a declared channel
 * nobody reads is a knob the operator turns with nothing happening, forever,
 * and without a line. That is D62, and this repo has now shipped it three
 * times (`audioThresholdDbfs`, the HA entities with no source, the second
 * per-camera switch that wrote a store nobody read).
 */
export function declareLogChannel(descriptor: LogChannelDescriptor): LogChannelGate {
  return getLogChannelRegistry().declare(descriptor)
}

/** Test-only: drop the instance so a spec starts from an empty registry. */
export function __resetLogChannelRegistryForTests(): void {
  instance = null
}
