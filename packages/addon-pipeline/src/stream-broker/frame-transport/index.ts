/**
 * Frame Transport — public barrel.
 *
 * Addon authors should import from `@camstack/addon-stream-broker` which
 * re-exports everything here. The layer is self-contained: types +
 * codecs + transports + server/client + auth helpers.
 *
 * Typical producer:
 *
 *   import {
 *     createFrameServer, TcpTransport, decodedFrameCodec, createAuthPair,
 *   } from '@camstack/addon-stream-broker'
 *
 *   const { signer, verifier } = createAuthPair()
 *   const server = await createFrameServer({
 *     transport: new TcpTransport(),
 *     codec: decodedFrameCodec,
 *     listen: { host: '0.0.0.0', port: 0 },
 *     authenticate: (token, _conn) => {
 *       if (token === null) throw new Error('no token')
 *       const v = verifier.verify(token, expectedSessionId)
 *       if (!v.ok) throw new Error(`auth failed: ${v.reason}`)
 *     },
 *   })
 *   console.log('listening on', server.url)
 *
 *   // On every new decoded frame:
 *   server.broadcast(frame)
 *
 * Typical consumer:
 *
 *   import { createFrameClient, TcpTransport, decodedFrameCodec } from '@camstack/addon-stream-broker'
 *
 *   const client = createFrameClient({
 *     transport: new TcpTransport(),
 *     codec: decodedFrameCodec,
 *     connect: { authToken: issuedToken },
 *   })
 *   await client.connect(serverUrl)
 *
 *   for await (const frame of client.messages) {
 *     processFrame(frame)
 *   }
 */

// ── Types ─────────────────────────────────────────────────────────────────
export type {
  TransportKind,
  TransportListenOptions,
  TransportConnectOptions,
  TransportEndpoint,
  TransportConnection,
  FrameTransport,
  FrameCodec,
  FrameDecoder,
  FrameDropPolicy,
  FrameServerOptions,
  FrameServer,
  FrameServerStats,
  FrameClientOptions,
  FrameClient,
  FrameClientStats,
} from './types.js'

// ── Codecs ────────────────────────────────────────────────────────────────
export { LengthPrefixCodec } from './codecs/length-prefix-codec.js'
export type { LengthPrefixCodecOptions } from './codecs/length-prefix-codec.js'
export {
  decodedFrameCodec,
  encodeDecodedFrame,
  decodeDecodedFrame,
} from './codecs/decoded-frame-codec.js'

// ── Transports ────────────────────────────────────────────────────────────
export { TcpTransport } from './transports/tcp-transport.js'
export { UdsTransport } from './transports/uds-transport.js'
export { InProcessTransport } from './transports/inprocess-transport.js'

// ── Server / Client ───────────────────────────────────────────────────────
export { createFrameServer } from './frame-server.js'
export { createFrameClient } from './frame-client.js'

// ── Auth ──────────────────────────────────────────────────────────────────
export { createAuthPair } from './auth.js'
export type { AuthSigner, AuthVerifier, AuthVerifyResult } from './auth.js'
