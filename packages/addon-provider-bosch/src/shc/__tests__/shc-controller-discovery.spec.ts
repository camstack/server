import { describe, expect, it } from 'vitest'
import {
  browseShcControllers,
  resolveShcPairingHost,
  shcHostsFromDnsMessage,
} from '../shc-controller-discovery.js'

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter((part) => part.length > 0)
  return Buffer.concat([
    ...parts.map((part) => Buffer.concat([Buffer.from([part.length]), Buffer.from(part)])),
    Buffer.from([0]),
  ])
}

function record(name: string, type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(10)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(1, 2)
  head.writeUInt32BE(120, 4)
  head.writeUInt16BE(data.length, 8)
  return Buffer.concat([encodeName(name), head, data])
}

function message(answers: readonly Buffer[]): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(answers.length, 6)
  return Buffer.concat([header, ...answers])
}

describe('shcHostsFromDnsMessage', () => {
  it('keeps a Bosch SHC answer and drops other names', () => {
    const ptr = 12
    const a = 1
    const packet = message([
      record('_http._tcp.local', ptr, encodeName('Bosch SHC._http._tcp.local')),
      record('_http._tcp.local', ptr, encodeName('Other Printer._http._tcp.local')),
      record('Bosch SHC._http._tcp.local', a, Buffer.from([192, 168, 1, 20])),
      record('Other Printer._http._tcp.local', a, Buffer.from([192, 168, 1, 21])),
    ])
    expect(shcHostsFromDnsMessage(packet)).toEqual([{ host: '192.168.1.20', name: 'Bosch SHC' }])
  })
})

describe('browseShcControllers', () => {
  it('returns the hosts from the exchanged packets', async () => {
    const packet = message([
      record('_http._tcp.local', 12, encodeName('Bosch SHC._http._tcp.local')),
      record('Bosch SHC._http._tcp.local', 1, Buffer.from([10, 0, 0, 8])),
    ])
    const hosts = await browseShcControllers(async () => [packet])
    expect(hosts).toEqual([{ host: '10.0.0.8', name: 'Bosch SHC' }])
  })
})

describe('resolveShcPairingHost', () => {
  it('prefers the typed host, then the discovered host', () => {
    expect(resolveShcPairingHost({ host: '10.0.0.8', hostManual: '192.0.2.20' })).toBe('192.0.2.20')
    expect(resolveShcPairingHost({ host: '10.0.0.8' })).toBe('10.0.0.8')
    expect(() => resolveShcPairingHost({})).toThrow(/host or IP address/)
  })
})
