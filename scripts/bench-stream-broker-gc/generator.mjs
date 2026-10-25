// Fake camera fleet: one RTSP-over-TCP (interleaved) server serving /s<i> for every
// profile entry, at the measured bitrate/fps/GOP. Runs in its own process so its
// allocations never reach the measured broker process. Also opens the restream
// drain clients against the harness (argv[3] = port).
import net from 'node:net'
import fs from 'node:fs'

// BROKERS (env) limits the fleet to the first N profile entries — the harness takes the same N.
const prof = JSON.parse(fs.readFileSync(new URL('./profile.json', import.meta.url))).slice(
  0,
  Number(process.env.BROKERS ?? Infinity),
)
const PORT = Number(process.argv[2] ?? 18554)
const RESTREAM_PORT = Number(process.argv[3] ?? 0)
const MTU = 1400
const KEY_MULT = 5

function sdpFor(p) {
  const v = p.codec === 'h265' ? 'H265' : 'H264'
  const lines = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=x',
    't=0 0',
    'm=video 0 RTP/AVP 96',
    `a=rtpmap:96 ${v}/90000`,
    'a=control:trackID=0',
  ]
  if (p.audio) lines.push('m=audio 0 RTP/AVP 0', 'a=rtpmap:0 PCMU/8000', 'a=control:trackID=1')
  return lines.join('\r\n') + '\r\n'
}

function rtpHeader(seq, ts, marker, pt) {
  const h = Buffer.alloc(12)
  h[0] = 0x80
  h[1] = (marker ? 0x80 : 0) | pt
  h.writeUInt16BE(seq & 0xffff, 2)
  h.writeUInt32BE(ts >>> 0, 4)
  h.writeUInt32BE(0x11223344, 8)
  return h
}
function interleave(ch, rtp) {
  const h = Buffer.alloc(4)
  h[0] = 0x24
  h[1] = ch
  h.writeUInt16BE(rtp.length, 2)
  return [h, rtp]
}
// NAL payloads (without start code) → RTP payloads
function nalPayloads(codec, nal) {
  if (nal.length <= MTU) return [nal]
  const out = []
  if (codec === 'h264') {
    const ind = (nal[0] & 0x60) | 28,
      type = nal[0] & 0x1f
    let off = 1
    while (off < nal.length) {
      const end = Math.min(off + MTU, nal.length)
      const fu = (off === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0) | type
      out.push(Buffer.concat([Buffer.from([ind, fu]), nal.subarray(off, end)]))
      off = end
    }
  } else {
    const type = (nal[0] >> 1) & 0x3f
    const ph0 = (nal[0] & 0x81) | (49 << 1),
      ph1 = nal[1]
    let off = 2
    while (off < nal.length) {
      const end = Math.min(off + MTU, nal.length)
      const fu = (off === 2 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0) | type
      out.push(Buffer.concat([Buffer.from([ph0, ph1, fu]), nal.subarray(off, end)]))
      off = end
    }
  }
  return out
}
function slice(codec, key, bytes) {
  const b = Buffer.alloc(Math.max(bytes, 8), 0x55)
  if (codec === 'h264') b[0] = key ? 0x65 : 0x41
  else {
    b[0] = (key ? 19 : 1) << 1
    b[1] = 1
  }
  return b
}
function paramSets(codec) {
  if (codec === 'h264')
    return [Buffer.from([0x67, 0x42, 0, 0x1f, 1, 2]), Buffer.from([0x68, 0xce, 0x3c, 0x80])]
  return [
    Buffer.from([32 << 1, 1, 0x0c, 1]),
    Buffer.from([33 << 1, 1, 1, 1, 0x60]),
    Buffer.from([34 << 1, 1, 0xc0, 0xf3]),
  ]
}

function startStream(sock, p) {
  const fps = Math.max(1, p.fps),
    gopFrames = Math.max(2, Math.round((fps * p.gopMs) / 1000))
  const bytesPerSec = p.kbps * 125
  const pBytes = Math.max(
    200,
    Math.round((bytesPerSec * (gopFrames / fps)) / (gopFrames - 1 + KEY_MULT)),
  )
  let seq = 1,
    ts = 0,
    frame = 0,
    aseq = 1,
    ats = 0
  const tick = 90000 / fps
  const vt = setInterval(() => {
    const key = frame % gopFrames === 0
    const nals = key
      ? [...paramSets(p.codec), slice(p.codec, true, pBytes * KEY_MULT)]
      : [slice(p.codec, false, pBytes)]
    const payloads = nals.flatMap((n) => nalPayloads(p.codec, n))
    const parts = []
    payloads.forEach((pl, i) =>
      parts.push(
        ...interleave(0, Buffer.concat([rtpHeader(seq++, ts, i === payloads.length - 1, 96), pl])),
      ),
    )
    if (!sock.destroyed) sock.write(Buffer.concat(parts))
    ts += tick
    frame++
  }, 1000 / fps)
  let at = null
  if (p.audio)
    at = setInterval(() => {
      if (!sock.destroyed)
        sock.write(
          Buffer.concat(
            interleave(
              2,
              Buffer.concat([rtpHeader(aseq++, ats, true, 0), Buffer.alloc(160, 0xff)]),
            ),
          ),
        )
      ats += 160
    }, 20)
  sock.on('close', () => {
    clearInterval(vt)
    if (at) clearInterval(at)
  })
}

const server = net.createServer((sock) => {
  let buf = ''
  let p = null
  sock.on('error', () => {})
  sock.on('data', (d) => {
    buf += d.toString('latin1')
    let i
    while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
      const req = buf.slice(0, i)
      buf = buf.slice(i + 4)
      const [line] = req.split('\r\n')
      const [method, url] = line.split(' ')
      const cseq = (req.match(/CSeq:\s*(\d+)/i) || [])[1] ?? '0'
      const m = url.match(/\/s(\d+)/)
      if (m) p = prof[Number(m[1])]
      let extra = '',
        body = ''
      if (method === 'OPTIONS')
        extra = 'Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER\r\n'
      if (method === 'DESCRIBE') {
        body = sdpFor(p)
        extra = `Content-Base: ${url}/\r\nContent-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`
      }
      if (method === 'SETUP') {
        const t = (req.match(/Transport:\s*([^\r\n]+)/i) || [])[1]
        extra = `Transport: ${t}\r\nSession: 12345678;timeout=60\r\n`
      }
      if (method === 'PLAY' || method === 'GET_PARAMETER') extra = 'Session: 12345678\r\n'
      sock.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n${extra}\r\n${body}`)
      if (method === 'PLAY') startStream(sock, p)
    }
  })
})
server.listen(PORT, '127.0.0.1', () => {
  console.log('generator listening', PORT, 'streams', prof.length)
  if (RESTREAM_PORT) {
    // drain clients: one per measured rtspClient, connecting after brokers are up
    setTimeout(() => {
      let n = 0
      prof.forEach((p, idx) => {
        for (let k = 0; k < p.clients; k++) {
          const c = net.connect(RESTREAM_PORT, '127.0.0.1', () => {
            c.write(Buffer.from([idx]))
            n++
          })
          c.on('data', () => {})
          c.on('error', () => {})
        }
      })
      setTimeout(() => console.log('drain clients', n), 2000)
    }, 8000)
  }
})
