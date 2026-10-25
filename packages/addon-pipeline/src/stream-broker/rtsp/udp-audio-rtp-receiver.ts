import { createSocket, type Socket } from 'node:dgram'

/**
 * Receives RTP audio datagrams ffmpeg pushes to a local UDP port (the
 * transcode-egress audio sidecar). The egress forwards each datagram verbatim
 * to the restreamer's `pushAudioRtpPassthrough`.
 */
export interface AudioRtpReceiver {
  /** Bind a UDP socket; resolves with the `rtp://` URL ffmpeg should target. */
  start(onPacket: (rtp: Buffer) => void): Promise<{ rtpUrl: string }>
  stop(): void
}

export class UdpAudioRtpReceiver implements AudioRtpReceiver {
  private readonly socket: Socket = createSocket('udp4')
  private stopped = false

  start(onPacket: (rtp: Buffer) => void): Promise<{ rtpUrl: string }> {
    return new Promise<{ rtpUrl: string }>((resolve, reject) => {
      this.socket.once('error', reject)
      this.socket.on('message', (msg) => {
        if (!this.stopped) onPacket(msg)
      })
      this.socket.bind(0, '127.0.0.1', () => {
        const addr = this.socket.address()
        resolve({ rtpUrl: `rtp://127.0.0.1:${addr.port}` })
      })
    })
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    try {
      this.socket.close()
    } catch {
      /* already closed */
    }
  }
}
