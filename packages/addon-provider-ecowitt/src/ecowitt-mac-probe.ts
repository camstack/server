/**
 * Read a gateway's MAC from the host it is configured at: the LAN scan's own
 * `CMD_BROADCAST` probe, sent UNICAST to that host on UDP 46000, its reply read
 * by the scan's parser. One datagram, one short wait, no retry: the next connect
 * tries again. Never a broadcast — this path only asks the host it was given.
 */
import { createSocket } from 'node:dgram'
import { errMsg } from '@camstack/types'
import { parseEcowittReply, SCAN_PACKET_HEX, SCAN_PORT } from './ecowitt-lan-discovery.js'

/** How long the probe waits for the gateway's reply. */
export const MAC_PROBE_TIMEOUT_MS = 1500

/** One unicast datagram out, every datagram that comes back until the timeout (hex). */
export type UdpUnicastExchange = (input: {
  readonly host: string
  readonly port: number
  readonly payloadHex: string
  readonly timeoutMs: number
  /** Stop waiting at the first reply this accepts. */
  readonly accept: (payloadHex: string) => boolean
}) => Promise<readonly string[]>

export type GatewayMacProbeResult =
  | { readonly ok: true; readonly mac: string }
  | { readonly ok: false; readonly reason: string }

/** The real exchange: node `dgram`, an ephemeral unicast socket closed on the first reply or the timeout. */
export const nodeUdpUnicastExchange: UdpUnicastExchange = (input) =>
  new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    const replies: string[] = []
    let settled = false
    const finish = (error: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // already closed
      }
      if (error === null) resolve(replies)
      else reject(error)
    }
    const timer = setTimeout(() => finish(null), input.timeoutMs)
    socket.on('error', (err) => finish(err))
    socket.on('message', (data) => {
      const hex = data.toString('hex')
      replies.push(hex)
      if (input.accept(hex)) finish(null)
    })
    socket.send(Buffer.from(input.payloadHex, 'hex'), input.port, input.host, (err) => {
      if (err) finish(err)
    })
  })

/** Ask the gateway at `host` for its MAC. A failure is a reason, never an empty MAC (D393). */
export async function probeGatewayMac(
  host: string,
  exchange: UdpUnicastExchange = nodeUdpUnicastExchange,
  timeoutMs: number = MAC_PROBE_TIMEOUT_MS,
): Promise<GatewayMacProbeResult> {
  let replies: readonly string[]
  try {
    replies = await exchange({
      host,
      port: SCAN_PORT,
      payloadHex: SCAN_PACKET_HEX,
      timeoutMs,
      accept: (hex) => parseEcowittReply(hex) !== null,
    })
  } catch (err) {
    return { ok: false, reason: `probe failed: ${errMsg(err)}` }
  }
  for (const hex of replies) {
    const reply = parseEcowittReply(hex)
    if (reply !== null) return { ok: true, mac: reply.mac }
  }
  return {
    ok: false,
    reason:
      replies.length === 0
        ? `no answer within ${timeoutMs} ms`
        : `${replies.length} reply(ies), none a gateway's`,
  }
}
