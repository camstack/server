export interface SdpOptions {
  readonly codec: 'h264' | 'h265'
  readonly parameterSets: ReadonlyArray<Buffer>
  readonly streamName: string
}

export function buildSdp(options: SdpOptions): string {
  const { codec, parameterSets, streamName } = options
  const lines: string[] = [
    'v=0',
    `o=- ${Date.now()} 1 IN IP4 0.0.0.0`,
    `s=${streamName}`,
    't=0 0',
    'a=tool:camstack-rtsp-restream',
    'm=video 0 RTP/AVP 96',
    'c=IN IP4 0.0.0.0',
    'b=AS:10000',
  ]

  if (codec === 'h264') {
    lines.push('a=rtpmap:96 H264/90000')
    const sps = parameterSets[0]
    const spropSets = parameterSets.map((ps) => ps.toString('base64')).join(',')
    const profileLevelId =
      sps && sps.length >= 4 ? Buffer.from([sps[1]!, sps[2]!, sps[3]!]).toString('hex') : '42001e'
    lines.push(
      `a=fmtp:96 packetization-mode=1;profile-level-id=${profileLevelId};sprop-parameter-sets=${spropSets}`,
    )
  } else {
    lines.push('a=rtpmap:96 H265/90000')
    const fmtpParts = parameterSets.map((ps, i) => {
      const prefix = i === 0 ? 'sprop-vps' : i === 1 ? 'sprop-sps' : 'sprop-pps'
      return `${prefix}=${ps.toString('base64')}`
    })
    lines.push(`a=fmtp:96 ${fmtpParts.join(';')}`)
  }

  lines.push('a=control:trackID=0')
  lines.push('')
  return lines.join('\r\n')
}
