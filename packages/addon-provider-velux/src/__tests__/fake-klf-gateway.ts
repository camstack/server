import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type TLSSocket, type Server as TlsServer } from 'node:tls'

/**
 * A scripted KLF-200 gateway: a TLS server on the real port 51200 that speaks the
 * wire format from the gateway's API specification (SLIP-framed
 * `[ProtocolID 0][Length][Command u16][Data...][XOR checksum]`), written
 * independently of the client library so the client is exercised against the
 * documented bytes, not against its own encoder.
 */

/** Command ids from the KLF-200 API specification. */
export const CMD = {
  REBOOT_REQ: 0x0001,
  REBOOT_CFM: 0x0002,
  GET_VERSION_REQ: 0x0008,
  GET_VERSION_CFM: 0x0009,
  GET_STATE_REQ: 0x000c,
  GET_STATE_CFM: 0x000d,
  GET_ALL_NODES_INFORMATION_REQ: 0x0202,
  GET_ALL_NODES_INFORMATION_CFM: 0x0203,
  GET_ALL_NODES_INFORMATION_NTF: 0x0204,
  GET_ALL_NODES_INFORMATION_FINISHED_NTF: 0x0205,
  NODE_STATE_POSITION_CHANGED_NTF: 0x0211,
  HOUSE_STATUS_MONITOR_ENABLE_REQ: 0x0240,
  HOUSE_STATUS_MONITOR_ENABLE_CFM: 0x0241,
  COMMAND_SEND_REQ: 0x0300,
  COMMAND_SEND_CFM: 0x0301,
  SESSION_FINISHED_NTF: 0x0304,
  GET_LIMITATION_STATUS_REQ: 0x0312,
  GET_LIMITATION_STATUS_CFM: 0x0313,
  LIMITATION_STATUS_NTF: 0x0314,
  PASSWORD_ENTER_REQ: 0x3000,
  PASSWORD_ENTER_CFM: 0x3001,
} as const

const SLIP_END = 0xc0
const SLIP_ESC = 0xdb
const SLIP_ESC_END = 0xdc
const SLIP_ESC_ESC = 0xdd

/** Node description the fake reports. Positions are WIRE values (0 = open). */
export interface FakeNode {
  readonly nodeId: number
  readonly name: string
  /** type<<6 | subtype, as in the gateway's node type word. */
  readonly actuatorType: number
  readonly actuatorSubType: number
  readonly serialHex: string
  readonly positionRaw: number
  /** Minimum-limitation wire value returned for a limitation query (rain). */
  readonly limitationMinRaw?: number
}

/** A decoded request the fake received. */
export interface ReceivedFrame {
  readonly command: number
  readonly data: Buffer
}

/** A movement command as the gateway received it. */
export interface ReceivedMove {
  readonly nodeIds: readonly number[]
  readonly mainValueRaw: number
}

function slipEncode(command: number, data: Buffer): Buffer {
  const body = Buffer.alloc(3 + data.length)
  body.writeUInt8(3 + data.length, 0)
  body.writeUInt16BE(command, 1)
  data.copy(body, 3)
  const framed = Buffer.concat([Buffer.from([0x00]), body, Buffer.from([0])])
  let crc = 0
  for (let i = 0; i < framed.length - 1; i++) crc ^= framed[i] ?? 0
  framed.writeUInt8(crc, framed.length - 1)
  const out: number[] = [SLIP_END]
  for (const byte of framed) {
    if (byte === SLIP_END) out.push(SLIP_ESC, SLIP_ESC_END)
    else if (byte === SLIP_ESC) out.push(SLIP_ESC, SLIP_ESC_ESC)
    else out.push(byte)
  }
  out.push(SLIP_END)
  return Buffer.from(out)
}

function slipDecodeAll(state: { pending: number[] }, chunk: Buffer): ReceivedFrame[] {
  const frames: ReceivedFrame[] = []
  for (const byte of chunk) {
    if (byte === SLIP_END) {
      if (state.pending.length > 0) {
        const raw = unescape(state.pending)
        // [ProtocolID][Length][Command u16][Data...][CRC]
        const command = raw.readUInt16BE(2)
        frames.push({ command, data: raw.subarray(4, raw.length - 1) })
      }
      state.pending = []
    } else {
      state.pending.push(byte)
    }
  }
  return frames
}

function unescape(bytes: readonly number[]): Buffer {
  const out: number[] = []
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0
    if (byte === SLIP_ESC) {
      const next = bytes[++i]
      out.push(next === SLIP_ESC_END ? SLIP_END : SLIP_ESC)
    } else out.push(byte)
  }
  return Buffer.from(out)
}

function nodeInformation(node: FakeNode): Buffer {
  const data = Buffer.alloc(124)
  data.writeUInt8(node.nodeId, 0)
  data.write(node.name, 4, 64, 'utf8')
  data.writeUInt16BE((node.actuatorType << 6) | node.actuatorSubType, 69)
  Buffer.from(node.serialHex, 'hex').copy(data, 76)
  data.writeUInt8(5, 84) // Done
  data.writeUInt16BE(node.positionRaw, 85)
  data.writeUInt16BE(node.positionRaw, 87)
  data.writeUInt16BE(0xf7ff, 89)
  data.writeUInt16BE(0xf7ff, 91)
  data.writeUInt16BE(0xf7ff, 93)
  data.writeUInt16BE(0xf7ff, 95)
  return data
}

/** Result of {@link FakeKlfGateway.start}: the certificate the client must trust. */
export interface FakeGatewayTls {
  readonly certPem: string
}

/** The scripted gateway. One instance = one gateway on 127.0.0.1:51200. */
export class FakeKlfGateway {
  readonly moves: ReceivedMove[] = []
  readonly stateRequests: number[] = []
  readonly limitationQueries: number[] = []
  /** How many GW_REBOOT_REQ the gateway accepted. */
  reboots = 0
  /** Software version GW_GET_VERSION answers: [command, main, sub, branch, build, micro]. */
  firmware: readonly [number, number, number, number, number, number] = [0, 2, 0, 0, 71, 0]
  /** Every connection ever accepted (open or since closed). */
  accepted = 0
  /** Refuse logins with this password check. */
  readonly password: string
  #server: TlsServer | null = null
  readonly #sockets: Set<TLSSocket> = new Set()
  readonly #nodes: FakeNode[]
  #dir: string | null = null

  constructor(password: string, nodes: readonly FakeNode[]) {
    this.password = password
    this.#nodes = [...nodes]
  }

  get openConnections(): number {
    return this.#sockets.size
  }

  async start(): Promise<FakeGatewayTls> {
    this.#dir = mkdtempSync(join(tmpdir(), 'fake-klf-'))
    const keyPath = join(this.#dir, 'key.pem')
    const certPath = join(this.#dir, 'cert.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '2',
        '-subj',
        '/CN=klf200.test',
      ],
      { stdio: 'ignore' },
    )
    const certPem = readFileSync(certPath, 'utf8')
    this.#server = createServer({ key: readFileSync(keyPath, 'utf8'), cert: certPem }, (socket) =>
      this.#serve(socket),
    )
    await new Promise<void>((resolve, reject) => {
      const server = this.#server
      if (server === null) return reject(new Error('server not created'))
      server.once('error', reject)
      server.listen(51200, '127.0.0.1', () => resolve())
    })
    return { certPem }
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
    const server = this.#server
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()))
    this.#server = null
    if (this.#dir !== null) rmSync(this.#dir, { recursive: true, force: true })
  }

  /** Push a node position change to every logged-in client, as the gateway does on its own. */
  pushPosition(nodeId: number, positionRaw: number, targetRaw: number, executing: boolean): void {
    const data = Buffer.alloc(20)
    data.writeUInt8(nodeId, 0)
    data.writeUInt8(executing ? 4 : 5, 1)
    data.writeUInt16BE(positionRaw, 2)
    data.writeUInt16BE(targetRaw, 4)
    for (const socket of this.#sockets)
      socket.write(slipEncode(CMD.NODE_STATE_POSITION_CHANGED_NTF, data))
  }

  /** Change what a limitation query answers for a node (rain on / off). */
  setLimitationMin(nodeId: number, minRaw: number): void {
    const index = this.#nodes.findIndex((n) => n.nodeId === nodeId)
    const node = this.#nodes[index]
    if (node !== undefined) this.#nodes[index] = { ...node, limitationMinRaw: minRaw }
  }

  /** The gateway closes every session (idle timeout / reset). */
  dropAll(): void {
    for (const socket of this.#sockets) socket.destroy()
  }

  /** Stop answering without closing (a wedged gateway). */
  mute(): void {
    this.#muted = true
  }

  #muted = false

  #serve(socket: TLSSocket): void {
    this.accepted += 1
    this.#sockets.add(socket)
    socket.on('close', () => this.#sockets.delete(socket))
    socket.on('error', () => undefined)
    const state = { pending: [] as number[] }
    socket.on('data', (chunk: Buffer) => {
      for (const frame of slipDecodeAll(state, chunk)) this.#answer(socket, frame)
    })
  }

  #answer(socket: TLSSocket, frame: ReceivedFrame): void {
    if (this.#muted) return
    const send = (command: number, data: Buffer): void => {
      socket.write(slipEncode(command, data))
    }
    switch (frame.command) {
      case CMD.PASSWORD_ENTER_REQ: {
        const given = frame.data.toString('utf8').split('\0', 1)[0]
        send(CMD.PASSWORD_ENTER_CFM, Buffer.from([given === this.password ? 0 : 1]))
        return
      }
      case CMD.GET_VERSION_REQ:
        send(CMD.GET_VERSION_CFM, Buffer.from([...this.firmware, 0, 14, 3]))
        return
      case CMD.REBOOT_REQ:
        this.reboots += 1
        send(CMD.REBOOT_CFM, Buffer.alloc(0))
        return
      case CMD.GET_STATE_REQ:
        this.stateRequests.push(Date.now())
        send(CMD.GET_STATE_CFM, Buffer.from([2, 0, 0, 0, 0, 0]))
        return
      case CMD.HOUSE_STATUS_MONITOR_ENABLE_REQ:
        send(CMD.HOUSE_STATUS_MONITOR_ENABLE_CFM, Buffer.alloc(0))
        return
      case CMD.GET_ALL_NODES_INFORMATION_REQ:
        send(CMD.GET_ALL_NODES_INFORMATION_CFM, Buffer.from([0, this.#nodes.length]))
        for (const node of this.#nodes)
          send(CMD.GET_ALL_NODES_INFORMATION_NTF, nodeInformation(node))
        send(CMD.GET_ALL_NODES_INFORMATION_FINISHED_NTF, Buffer.alloc(0))
        return
      case CMD.COMMAND_SEND_REQ: {
        const sessionId = frame.data.readUInt16BE(0)
        const mainValueRaw = frame.data.readUInt16BE(7)
        const count = frame.data.readUInt8(41)
        const nodeIds: number[] = []
        for (let i = 0; i < count; i++) nodeIds.push(frame.data.readUInt8(42 + i))
        this.moves.push({ nodeIds, mainValueRaw })
        const cfm = Buffer.alloc(3)
        cfm.writeUInt16BE(sessionId, 0)
        cfm.writeUInt8(1, 2) // accepted
        send(CMD.COMMAND_SEND_CFM, cfm)
        return
      }
      case CMD.GET_LIMITATION_STATUS_REQ: {
        const sessionId = frame.data.readUInt16BE(0)
        const nodeId = frame.data.readUInt8(3)
        this.limitationQueries.push(nodeId)
        const min = this.#nodes.find((n) => n.nodeId === nodeId)?.limitationMinRaw ?? 0
        const cfm = Buffer.alloc(3)
        cfm.writeUInt16BE(sessionId, 0)
        cfm.writeUInt8(1, 2)
        send(CMD.GET_LIMITATION_STATUS_CFM, cfm)
        const ntf = Buffer.alloc(10)
        ntf.writeUInt16BE(sessionId, 0)
        ntf.writeUInt8(nodeId, 2)
        ntf.writeUInt8(0, 3)
        ntf.writeUInt16BE(min, 4)
        ntf.writeUInt16BE(0xc800, 6)
        send(CMD.LIMITATION_STATUS_NTF, ntf)
        const fin = Buffer.alloc(2)
        fin.writeUInt16BE(sessionId, 0)
        send(CMD.SESSION_FINISHED_NTF, fin)
        return
      }
      default:
        return
    }
  }
}
