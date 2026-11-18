/** A gateway's `CMD_BROADCAST` reply: header, command, size, MAC, ip, port, SSID, checksum (hex). */
export function gatewayReplyHex(mac: readonly number[], ssid: string): string {
  const body = Buffer.concat([
    Buffer.from([0xff, 0xff, 0x12, 0x00, 0x00]),
    Buffer.from(mac),
    Buffer.from([192, 0, 2, 7]),
    Buffer.from([0xaf, 0xc8]),
    Buffer.from([ssid.length]),
    Buffer.from(ssid, 'ascii'),
    Buffer.from([0]),
  ])
  let sum = 0
  for (let i = 2; i < body.length - 1; i += 1) sum = (sum + (body[i] ?? 0)) & 0xff
  body[body.length - 1] = sum
  return body.toString('hex')
}
