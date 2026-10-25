/**
 * Ambient type declaration for `node-turn`.
 *
 * node-turn ships no TypeScript types. This declaration covers only the
 * constructor options and lifecycle methods used by the werift-turn-fix
 * acceptance-test helper. It is the documented type boundary — do not
 * widen it with `any`.
 */
declare module 'node-turn' {
  export interface TurnServerOptions {
    /** Authentication mechanism. Use 'long-term' for TURN relay. */
    authMech?: 'none' | 'long-term'
    /** Map of username → password pairs (long-term auth). */
    credentials?: Record<string, string>
    /** TURN realm string sent to clients. */
    realm?: string
    /** UDP port the TURN server listens on (default 3478). */
    listeningPort?: number
    /** IP addresses to bind the listening socket on. */
    listeningIps?: string[]
    /** IP addresses used for relay (allocations). */
    relayIps?: string[]
    /**
     * Log verbosity level.
     * Valid values: 'ALL' | 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'OFF'
     */
    debugLevel?: 'ALL' | 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'OFF'
  }

  export default class TurnServer {
    constructor(options?: TurnServerOptions)
    /** Bind the listening socket and start processing STUN/TURN messages. Synchronous. */
    start(): void
    /** Release all allocations and close the listening socket. Synchronous. */
    stop(): void
  }
}
