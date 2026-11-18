/**
 * The connect probe reads a gateway's MAC with the scan's own `CMD_BROADCAST`
 * packet, sent unicast to the configured host on UDP 46000, and the scan's
 * parser. No answer, a foreign answer or a socket error is a reason, never an
 * empty MAC (D393).
 */
import { describe, expect, it } from 'vitest'
import { probeGatewayMac, type UdpUnicastExchange } from '../ecowitt-mac-probe.js'
import { gatewayReplyHex } from './support/ecowitt-reply.js'

const DOC_MAC_REPLY = gatewayReplyHex([0x00, 0x00, 0x5e, 0x00, 0x53, 0x2a], 'GW2000A-WIFI532A')

describe('probeGatewayMac', () => {
  it('sends the scan packet unicast to the host on 46000 and reads the MAC from the reply', async () => {
    const sent: { host: string; port: number; payloadHex: string }[] = []
    const exchange: UdpUnicastExchange = async (input) => {
      sent.push({ host: input.host, port: input.port, payloadHex: input.payloadHex })
      expect(input.accept(DOC_MAC_REPLY)).toBe(true)
      return [DOC_MAC_REPLY]
    }
    await expect(probeGatewayMac('192.0.2.7', exchange)).resolves.toEqual({
      ok: true,
      mac: '00:00:5e:00:53:2a',
    })
    expect(sent).toEqual([{ host: '192.0.2.7', port: 46_000, payloadHex: 'ffff120315' }])
  })

  it('no answer is a reason', async () => {
    await expect(probeGatewayMac('192.0.2.7', async () => [], 1500)).resolves.toEqual({
      ok: false,
      reason: 'no answer within 1500 ms',
    })
  })

  it("an answer that is not a gateway's is a reason", async () => {
    await expect(probeGatewayMac('192.0.2.7', async () => ['00ff'])).resolves.toEqual({
      ok: false,
      reason: "1 reply(ies), none a gateway's",
    })
  })

  it('a socket error is a reason', async () => {
    const exchange: UdpUnicastExchange = async () => {
      throw new Error('send EHOSTUNREACH 192.0.2.7:46000')
    }
    await expect(probeGatewayMac('192.0.2.7', exchange)).resolves.toEqual({
      ok: false,
      reason: 'probe failed: send EHOSTUNREACH 192.0.2.7:46000',
    })
  })
})
