import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { IrTimingsSchema, TransmitSettingsSchema } from '../ir-timings.js'
import { IrCodecError } from '../ir-error.js'
import { decodePronto } from '../pronto.js'
import { IrPayloadSchema, toTimings } from '../ir-payload.js'
import { parseSmartIr } from '../smartir.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'))

// Learned code: frequency word 0x006D = 109 -> unit 26.2958 us, carrier 38.0 kHz,
// 2 intro pairs, 0 repeat pairs.
const PRONTO = '0000 006D 0002 0000 0010 0008 0010 0020'

describe('schemas', () => {
  it('IrTimingsSchema accepts alternating signed timings', () => {
    expect(IrTimingsSchema.safeParse([500, -500, 500]).success).toBe(true)
  })
  it.each([
    ['too short', [500]],
    ['zero', [500, 0]],
    ['starts with a space', [-500, 500]],
    ['two marks in a row', [500, 500]],
    ['non integer', [500.5, -500]],
    ['too long', Array.from({ length: 1025 }, (_, i) => (i % 2 === 0 ? 100 : -100))],
  ])('IrTimingsSchema rejects %s', (_name, value) => {
    expect(IrTimingsSchema.safeParse(value).success).toBe(false)
  })
  it('TransmitSettingsSchema bounds', () => {
    expect(
      TransmitSettingsSchema.safeParse({
        carrierHz: 38000,
        dutyCyclePercent: 33,
        repeat: 2,
        repeatDelayMs: 40,
      }).success,
    ).toBe(true)
    expect(TransmitSettingsSchema.safeParse({}).success).toBe(true)
    expect(TransmitSettingsSchema.safeParse({ dutyCyclePercent: 0 }).success).toBe(false)
    expect(TransmitSettingsSchema.safeParse({ repeat: 21 }).success).toBe(false)
  })
})

describe('pronto', () => {
  it('decodes a learned code to timings and carrier', () => {
    const r = decodePronto(PRONTO)
    expect(r.carrierHz).toBe(38029)
    expect(r.timings).toEqual([421, -210, 421, -841])
    expect(IrTimingsSchema.safeParse(r.timings).success).toBe(true)
  })
  it('rejects a non-learned form with a typed reason', () => {
    expect.assertions(3)
    try {
      decodePronto('0100 006D 0002 0000 0010 0008 0010 0020')
    } catch (e) {
      expect(e).toBeInstanceOf(IrCodecError)
      expect(e instanceof IrCodecError && e.code).toBe('pronto-unsupported-form')
      expect(e instanceof IrCodecError && e.message).toMatch(/0100/)
    }
  })
  it('rejects malformed input with a typed error', () => {
    for (const bad of [
      '',
      'zz',
      '0000 006D 0002 0000 0010',
      '0000 0000 0002 0000 0010 0008 0010 0020',
    ]) {
      expect(() => decodePronto(bad)).toThrow(IrCodecError)
    }
  })
})

describe('payload', () => {
  it('raw passes timings and settings through, validated', () => {
    const p = IrPayloadSchema.parse({ kind: 'raw', timings: [500, -500], settings: { repeat: 1 } })
    expect(toTimings(p)).toEqual({ timings: [500, -500], settings: { repeat: 1 } })
  })
  it('raw with invalid timings is a typed error', () => {
    expect(() => toTimings({ kind: 'raw', timings: [0, 5] })).toThrow(IrCodecError)
  })
  it('pronto becomes timings plus carrierHz', () => {
    const r = toTimings({ kind: 'pronto', code: PRONTO })
    expect(r.timings).toEqual([421, -210, 421, -841])
    expect(r.settings).toEqual({ carrierHz: 38029 })
  })
  it('discriminates on kind', () => {
    expect(IrPayloadSchema.safeParse({ kind: 'nec', code: 1 }).success).toBe(false)
  })
})

describe('smartir fixtures', () => {
  it.each([
    ['7178.json', 'Samsung', 10],
    ['7000.json', 'Hisense', 7],
  ])('%s parses', (file, manufacturer, nCommands) => {
    const { table, skipped } = parseSmartIr(fixture(file))
    expect(skipped).toEqual([])
    expect(table.interCommandDelayMs).toBe(200)
    expect(table.origin?.format).toBe('smartir')
    expect(table.origin?.manufacturer).toBe(manufacturer)
    const commands = table.commands.filter((c) => c.group === 'command')
    expect(commands).toHaveLength(nCommands)
    const names = commands.map((c) => c.name)
    for (const n of [
      'off',
      'on',
      'volumeUp',
      'volumeDown',
      'mute',
      'nextChannel',
      'previousChannel',
    ]) {
      expect(names).toContain(n)
    }
    const sources = table.commands.filter((c) => c.group === 'source').map((c) => c.name)
    expect(sources).toEqual([...Array.from({ length: 10 }, (_, i) => `Channel ${i}`), 'Input'])
    for (const c of table.commands) {
      expect(c.payload.kind).toBe('raw')
      expect(IrTimingsSchema.safeParse(toTimings(c.payload).timings).success).toBe(true)
    }
  })

  it('keeps the exact signed microseconds of a raw command', () => {
    const { table } = parseSmartIr(fixture('7178.json'))
    const off = table.commands.find((c) => c.name === 'off' && c.group === 'command')
    const timings = off ? toTimings(off.payload).timings : []
    expect(timings.slice(0, 4)).toEqual([4508, -4545, 536, -1735])
    expect(timings).toHaveLength(67)
  })
})

describe('smartir other encodings and malformed input', () => {
  const base = {
    manufacturer: 'X',
    supportedModels: ['m'],
    supportedController: 'Broadlink',
    delay: 0.5,
  }
  it('reports Base64 commands as skipped with a reason', () => {
    const { table, skipped } = parseSmartIr({
      ...base,
      commandsEncoding: 'Base64',
      commands: { on: 'JgBQAA==', sources: { HDMI: 'JgBQAA==' } },
    })
    expect(table.commands).toEqual([])
    expect(skipped.map((s) => s.name).sort()).toEqual(['HDMI', 'on'])
    expect(skipped[0]?.reason).toMatch(/Base64/)
  })
  it('handles Pronto commands and skips bad ones individually', () => {
    const { table, skipped } = parseSmartIr({
      ...base,
      commandsEncoding: 'Pronto',
      commands: { on: PRONTO, off: 'garbage' },
    })
    expect(table.commands.map((c) => c.name)).toEqual(['on'])
    expect(table.commands[0]?.payload).toEqual({ kind: 'pronto', code: PRONTO })
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.name).toBe('off')
  })
  it('skips a Raw command that is not valid timings, keeping the rest', () => {
    const { table, skipped } = parseSmartIr({
      ...base,
      commandsEncoding: 'Raw',
      commands: { on: '[500,-500]', off: '[1,2', mute: '[0,0]' },
    })
    expect(table.commands.map((c) => c.name)).toEqual(['on'])
    expect(skipped.map((s) => s.name).sort()).toEqual(['mute', 'off'])
  })
  it('defaults the delay when missing', () => {
    const { table } = parseSmartIr({
      ...base,
      delay: undefined,
      commandsEncoding: 'Raw',
      commands: { on: '[500,-500]' },
    })
    expect(table.interCommandDelayMs).toBe(500)
  })
  it.each([
    [null],
    ['text'],
    [{}],
    [{ commandsEncoding: 'Raw' }],
    [{ commandsEncoding: 'Raw', commands: [] }],
  ])('malformed document %j throws IrCodecError', (doc) => {
    expect(() => parseSmartIr(doc)).toThrow(IrCodecError)
  })
})
