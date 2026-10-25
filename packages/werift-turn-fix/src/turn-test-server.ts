import Turn from 'node-turn'

/** ICE server descriptor compatible with the RTCConfiguration `iceServers` array. */
export interface IceServerConfig {
  readonly urls: string
  readonly username: string
  readonly credential: string
}

/**
 * Handle returned by {@link startTurnServer}.
 * Call `stop()` in `afterEach` / `finally` to release the UDP socket.
 */
export interface TurnTestServer {
  readonly iceServer: IceServerConfig
  stop(): Promise<void>
}

const USERNAME = 'camstack'
const CREDENTIAL = 'camstack'

/**
 * Start a loopback long-term-credential TURN server on an ephemeral port in
 * the range 30000–34999.
 *
 * The server is intentionally minimal — relay-only loopback — suitable for
 * the automated TURN oracle that drives the werift NAT regression suite.
 * No external access, no STUN-only fallback.
 */
export async function startTurnServer(): Promise<TurnTestServer> {
  const port = 30000 + Math.floor(Math.random() * 5000)

  const server = new Turn({
    authMech: 'long-term',
    credentials: { [USERNAME]: CREDENTIAL },
    realm: 'camstack.local',
    listeningIps: ['127.0.0.1'],
    relayIps: ['127.0.0.1'],
    listeningPort: port,
    debugLevel: 'OFF',
  })

  server.start()

  return {
    iceServer: {
      urls: `turn:127.0.0.1:${port}`,
      username: USERNAME,
      credential: CREDENTIAL,
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => {
        try {
          server.stop()
        } finally {
          resolve()
        }
      })
    },
  }
}
