import { ReolinkUdpDiscoveryMethodSchema } from './schema.js'
import type { z } from 'zod'

export type TransportMode = 'auto' | 'tcp' | 'udp'
export type UdpDiscoveryMethod = z.infer<typeof ReolinkUdpDiscoveryMethodSchema>

export interface AutodetectInputs {
  readonly host: string
  readonly username: string
  readonly password: string
  readonly uid: string | undefined
  readonly transport: TransportMode
  readonly port: number
  /** Set only when the operator picked a method; unset keeps the lib's race of every method. */
  readonly udpDiscoveryMethod: UdpDiscoveryMethod | undefined
}

function readString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v : ''
}

function readTransportMode(obj: Record<string, unknown>): TransportMode {
  const v = obj['transport']
  return v === 'tcp' || v === 'udp' || v === 'auto' ? v : 'auto'
}

/** `auto` / unknown / absent mean "race every method"; only a real method is kept. */
function readDiscoveryMethod(obj: Record<string, unknown>): UdpDiscoveryMethod | undefined {
  const parsed = ReolinkUdpDiscoveryMethodSchema.safeParse(obj['udpDiscoveryMethod'])
  return parsed.success ? parsed.data : undefined
}

export function buildAutodetectInputs(form: Record<string, unknown>): AutodetectInputs {
  const rawUid = readString(form, 'uid').trim()
  const rawPort = form['port']
  return {
    host: readString(form, 'host').trim(),
    username: (readString(form, 'username') || 'admin').trim(),
    password: readString(form, 'password'),
    uid: rawUid.length > 0 ? rawUid : undefined,
    transport: readTransportMode(form),
    port: typeof rawPort === 'number' && Number.isFinite(rawPort) ? rawPort : 9000,
    udpDiscoveryMethod: readDiscoveryMethod(form),
  }
}
