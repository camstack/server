/**
 * What the Echo worker needs from an import broker to act as the same Amazon
 * account: the refresh token of the broker's own device registration. The
 * broker keeps that registration fresh (it persists `cookieData` after every
 * refresh), so the freshest copy is the persisted session file, then the
 * stored cookie blob, then a bare refresh token. A raw cookie string carries
 * no refresh token and gives no seed.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { SESSION_FILE } from '../alexa-remote-client.js'
import type { AlexaBrokerEntry } from '../config.js'
import type { AlexaRegion } from './constants.js'

/** The registration name alexapy sends when the broker did not record one. */
export const DEFAULT_DEVICE_APP_NAME = 'Alexa Media Player'

export interface BrokerSeed {
  readonly refreshToken: string
  readonly deviceAppName: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The registration blob alexa-remote2 hands back, from an object or its JSON text. */
function asRegistration(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function seedFromRegistration(value: unknown): BrokerSeed | null {
  const registration = asRegistration(value)
  if (registration === null) return null
  const token = registration['refreshToken']
  if (typeof token !== 'string' || token.length === 0) return null
  const name = registration['deviceAppName']
  return {
    refreshToken: token,
    deviceAppName: typeof name === 'string' && name.length > 0 ? name : DEFAULT_DEVICE_APP_NAME,
  }
}

async function readPersistedRegistration(
  dataDir: string | undefined,
  brokerId: string,
): Promise<unknown> {
  if (dataDir === undefined) return null
  try {
    const raw = await fs.readFile(path.join(dataDir, `${brokerId}.${SESSION_FILE}`), 'utf8')
    const json: unknown = JSON.parse(raw)
    return isRecord(json) ? json['cookieData'] : null
  } catch {
    return null
  }
}

export async function readBrokerSeed(
  dataDir: string | undefined,
  entry: AlexaBrokerEntry,
): Promise<BrokerSeed | null> {
  const persisted = seedFromRegistration(await readPersistedRegistration(dataDir, entry.id))
  if (persisted !== null) return persisted
  const stored = seedFromRegistration(entry.connection.cookie)
  if (stored !== null) return stored
  const bare = entry.connection.refreshToken
  if (bare.length > 0) return { refreshToken: bare, deviceAppName: DEFAULT_DEVICE_APP_NAME }
  return null
}

/** Amazon domain to the region the worker uses for the spoken-sequence locale. */
export function regionOfDomain(domain: string): AlexaRegion {
  const tail = domain.toLowerCase().replace(/^(www|alexa)\./, '')
  if (tail === 'amazon.com') return 'NA'
  if (tail === 'amazon.co.jp' || tail === 'amazon.com.au' || tail === 'amazon.in') return 'FE'
  return 'EU'
}
