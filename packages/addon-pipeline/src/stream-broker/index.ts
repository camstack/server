// --- Stream Broker Addon ---
import { StreamBrokerAddon } from './addon'
export { StreamBrokerAddon }
// Default export — kernel's addon-loader prefers `mod.default` for
// class resolution. After Vite bundling, named exports get sorted
// alphabetically; without the explicit default the resolver's
// "first exports key" strategy lands on a different class.
export default StreamBrokerAddon

export { StreamBrokerManager } from './stream-broker/stream-broker-manager'
export { StreamBroker } from './stream-broker/stream-broker'
export { StreamPipeServer } from './stream-broker/stream-pipe-server'
export type { BrokerStats, BrokerStatus } from '@camstack/types'

// --- Frame Transport (re-exports public API from ./frame-transport) ---
export * from './frame-transport/index.js'
