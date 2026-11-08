import { IrCodecError } from './ir-error.js'
import type { IrTimings } from './ir-timings.js'
import type { RemoteCommand, RemoteCommandTable, SkippedCommand } from './smartir.js'

/**
 * The Flipper `.ir` signals file: a header, then one block per button
 * separated by `#`. A block is either a PARSED code (protocol, address,
 * command) or a RAW train (frequency, duty cycle, alternating durations).
 * Parsed codes are encoded here for the protocols whose frame is proven;
 * every other protocol is reported per button, never dropped silently.
 */
const FILETYPE = 'IR signals file'

export interface FlipperParsedButton {
  readonly type: 'parsed'
  readonly name: string
  readonly protocol: string
  /** Little-endian value of the 4 address bytes. */
  readonly address: number
  /** Little-endian value of the 4 command bytes. */
  readonly command: number
}

export interface FlipperRawButton {
  readonly type: 'raw'
  readonly name: string
  readonly frequency: number
  readonly dutyCycle: number
  /** Durations in µs, mark first, all positive as the file spells them. */
  readonly data: readonly number[]
}

export type FlipperButton = FlipperParsedButton | FlipperRawButton

export interface FlipperIrFile {
  readonly buttons: readonly FlipperButton[]
}

function malformed(message: string): IrCodecError {
  return new IrCodecError('flipper-malformed', message)
}

function fieldsOf(block: readonly string[]): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of block) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    fields.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  return fields
}

function need(fields: Map<string, string>, key: string, name: string): string {
  const value = fields.get(key)
  if (value === undefined || value === '') throw malformed(`Button "${name}" has no ${key}`)
  return value
}

function littleEndian(hex: string, what: string, name: string): number {
  const bytes = hex.split(/\s+/)
  let value = 0
  bytes.forEach((byte, index) => {
    if (!/^[0-9a-fA-F]{1,2}$/.test(byte)) throw malformed(`Button "${name}" has a bad ${what}`)
    value += Number.parseInt(byte, 16) * 256 ** index
  })
  return value
}

function buttonOf(block: readonly string[]): FlipperButton {
  const fields = fieldsOf(block)
  const name = need(fields, 'name', '?')
  const type = need(fields, 'type', name)
  if (type === 'parsed') {
    return {
      type,
      name,
      protocol: need(fields, 'protocol', name),
      address: littleEndian(need(fields, 'address', name), 'address', name),
      command: littleEndian(need(fields, 'command', name), 'command', name),
    }
  }
  if (type === 'raw') {
    const data = need(fields, 'data', name)
      .split(/\s+/)
      .map((v) => Number(v))
    if (data.some((v) => !Number.isInteger(v) || v <= 0))
      throw malformed(`Button "${name}" has bad raw data`)
    return {
      type,
      name,
      frequency: Number(need(fields, 'frequency', name)),
      dutyCycle: Number(fields.get('duty_cycle') ?? '0.33'),
      data,
    }
  }
  throw malformed(`Button "${name}" has unknown type "${type}"`)
}

/** Parse a `.ir` file. Throws `IrCodecError` (`flipper-malformed`). */
export function parseFlipperIr(text: string): FlipperIrFile {
  const lines = text.split(/\r?\n/)
  if (fieldsOf(lines.slice(0, 3)).get('filetype') !== FILETYPE) {
    throw malformed('Not a Flipper IR signals file')
  }
  const blocks: string[][] = [[]]
  for (const line of lines.slice(1)) {
    if (line.trim().startsWith('#')) {
      if ((blocks.at(-1) ?? []).some((l) => l.trim().toLowerCase().startsWith('name:')))
        blocks.push([])
      continue
    }
    blocks.at(-1)?.push(line)
  }
  const buttons = blocks
    .filter((b) => b.some((l) => l.trim().toLowerCase().startsWith('name:')))
    .map(buttonOf)
  return { buttons }
}

export interface EncodedFlipper {
  readonly timings: IrTimings
  readonly carrierHz: number
}

const CARRIER_HZ = 38000
const BIT_MARK_US = 560
const ONE_SPACE_US = 1690
const ZERO_SPACE_US = 560

/** Bytes sent in order, each byte LSB first, closed by a stop mark. */
function frame(headerMark: number, headerSpace: number, bytes: readonly number[]): IrTimings {
  const body = bytes.flatMap((byte) =>
    Array.from({ length: 8 }, (_, bit) => [
      BIT_MARK_US,
      -(Math.floor(byte / 2 ** bit) % 2 === 1 ? ONE_SPACE_US : ZERO_SPACE_US),
    ]).flat(),
  )
  return [headerMark, -headerSpace, ...body, BIT_MARK_US, -ZERO_SPACE_US]
}

function fits(value: number, bits: number, what: string, protocol: string): void {
  if (value >= 2 ** bits)
    throw new IrCodecError('flipper-malformed', `${protocol} ${what} does not fit in ${bits} bits`)
}

const lo = (v: number): number => v % 256
const hi = (v: number): number => Math.floor(v / 256) % 256

/** Protocols this encoder emits: NEC, NECext and Samsung32. Any other throws, naming the protocol. */
export function encodeFlipperParsed(code: {
  readonly protocol: string
  readonly address: number
  readonly command: number
}): EncodedFlipper {
  const { protocol, address, command } = code
  if (protocol === 'NEC') {
    fits(address, 8, 'address', protocol)
    fits(command, 8, 'command', protocol)
    return {
      timings: frame(9000, 4500, [address, 255 - address, command, 255 - command]),
      carrierHz: CARRIER_HZ,
    }
  }
  if (protocol === 'NECext') {
    fits(address, 16, 'address', protocol)
    fits(command, 16, 'command', protocol)
    return {
      timings: frame(9000, 4500, [lo(address), hi(address), lo(command), hi(command)]),
      carrierHz: CARRIER_HZ,
    }
  }
  if (protocol === 'Samsung32') {
    fits(address, 16, 'address', protocol)
    fits(command, 8, 'command', protocol)
    const addressBytes = address > 255 ? [lo(address), hi(address)] : [address, address]
    return {
      timings: frame(4500, 4500, [...addressBytes, command, 255 - command]),
      carrierHz: CARRIER_HZ,
    }
  }
  throw new IrCodecError('flipper-malformed', `${protocol} protocol is not supported`)
}

function rawTimings(data: readonly number[]): IrTimings {
  return data.map((value, index) => (index % 2 === 0 ? value : -value))
}

/**
 * The file as a command table (every button a `raw` payload carrying its
 * carrier), plus the buttons that could not be encoded, named with the reason.
 */
export function flipperIrTable(file: FlipperIrFile): {
  table: RemoteCommandTable
  skipped: SkippedCommand[]
} {
  const commands: RemoteCommand[] = []
  const skipped: SkippedCommand[] = []
  for (const button of file.buttons) {
    try {
      if (button.type === 'raw') {
        commands.push({
          name: button.name,
          group: 'command',
          payload: {
            kind: 'raw',
            timings: rawTimings(button.data),
            settings: {
              carrierHz: Math.round(button.frequency),
              dutyCyclePercent: Math.min(100, Math.max(1, Math.round(button.dutyCycle * 100))),
            },
          },
        })
      } else {
        const { timings, carrierHz } = encodeFlipperParsed(button)
        commands.push({
          name: button.name,
          group: 'command',
          payload: { kind: 'raw', timings, settings: { carrierHz } },
        })
      }
    } catch (err: unknown) {
      if (!(err instanceof IrCodecError)) throw err
      skipped.push({ name: button.name, group: 'command', reason: err.message })
    }
  }
  return { table: { commands, interCommandDelayMs: 500 }, skipped }
}
