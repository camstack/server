/**
 * One-shot migration of the session file an earlier version kept beside the record
 * (`<dataDir>/<brokerId>.alexa-session.json`). The record's secret `cookie` field is now the only
 * place a registration lives; if the file holds a NEWER registration than the record (the client
 * renewed it and only the file saw it), that registration moves into the record, and the file is
 * deleted either way. Nothing writes the file any more.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AlexaBrokerEntry } from './config.js'
import { parseRegistration } from './amazon-auth/registration.js'

export const SESSION_FILE = 'alexa-session.json'

function sessionPath(dataDir: string, brokerId: string): string {
  return path.join(dataDir, `${brokerId}.${SESSION_FILE}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The registration (as the record's `cookie` text) the file holds when it is newer than the
 * record's; null when there is no file, it does not parse, or the record is as new.
 */
export async function readNewerSession(
  dataDir: string | undefined,
  entry: AlexaBrokerEntry,
): Promise<string | null> {
  if (dataDir === undefined) return null
  let raw: string
  try {
    raw = await fs.readFile(sessionPath(dataDir, entry.id), 'utf8')
  } catch {
    return null
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const fromFile = parseRegistration(isRecord(json) ? json['cookieData'] : null)
  if (fromFile === null) return null
  const fromRecord = parseRegistration(entry.connection.cookie)
  const fileDate = fromFile.tokenDate ?? 0
  const recordDate = fromRecord?.tokenDate ?? -1
  return fileDate > recordDate ? JSON.stringify(fromFile) : null
}

/** Delete the session file of a broker (absent is fine). */
export async function removeSessionFile(
  dataDir: string | undefined,
  brokerId: string,
): Promise<void> {
  if (dataDir === undefined) return
  await fs.rm(sessionPath(dataDir, brokerId), { force: true })
}
