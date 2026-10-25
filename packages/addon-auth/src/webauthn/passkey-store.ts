import { z } from 'zod'
import type { RecordKindHandle } from '@camstack/types'
import { authWebauthnRecordKinds, type PasskeyBody, type PasskeyPrefBody } from './record-kinds.js'

const StoredPreferenceSchema = z.object({
  secondFactorEnabled: z.boolean(),
  updatedAt: z.number(),
})

type StoredPreference = z.infer<typeof StoredPreferenceSchema>
type PrefBody = PasskeyPrefBody

export interface StoredPasskey {
  credentialId: string
  userId: string
  publicKey: string
  counter: number
  transports: readonly string[]
  label: string
  createdAt: number
  lastUsedAt: number | null
}

export interface PasskeyRecordsDeps {
  readonly passkeysKind: RecordKindHandle<PasskeyBody>
  readonly prefsKind: RecordKindHandle<PrefBody>
}

function parseRow(data: Record<string, unknown>): StoredPasskey {
  const credentialId = data['credentialId']
  const userId = data['userId']
  const publicKey = data['publicKey']
  const counter = data['counter']
  const transports = data['transports']
  const label = data['label']
  const createdAt = data['createdAt']
  const lastUsedAt = data['lastUsedAt']
  if (typeof credentialId !== 'string') throw new Error('passkey row: missing credentialId')
  if (typeof userId !== 'string') throw new Error('passkey row: missing userId')
  if (typeof publicKey !== 'string') throw new Error('passkey row: missing publicKey')
  if (typeof counter !== 'number') throw new Error('passkey row: missing counter')
  if (typeof label !== 'string') throw new Error('passkey row: missing label')
  if (typeof createdAt !== 'number') throw new Error('passkey row: missing createdAt')
  return {
    credentialId,
    userId,
    publicKey,
    counter,
    transports: Array.isArray(transports) ? (transports as string[]) : [],
    label,
    createdAt,
    lastUsedAt: typeof lastUsedAt === 'number' ? lastUsedAt : null,
  }
}

function pkToBody(pk: StoredPasskey): PasskeyBody {
  return {
    credentialId: pk.credentialId,
    userId: pk.userId,
    publicKey: pk.publicKey,
    counter: pk.counter,
    transports: pk.transports,
    label: pk.label,
    createdAt: pk.createdAt,
    lastUsedAt: pk.lastUsedAt,
  }
}

function rowToPasskey(id: string, body: PasskeyBody): StoredPasskey {
  const { credentialId: _ignored, ...rest } = body
  return parseRow({ credentialId: id, ...rest })
}

/** The passkeys of every user, on `ctx.records` (D900: the legacy collections are gone). */
export class PasskeyStore {
  private readonly passkeysKind: RecordKindHandle<PasskeyBody>
  private readonly prefsKind: RecordKindHandle<PrefBody>

  constructor(deps: PasskeyRecordsDeps) {
    this.passkeysKind = deps.passkeysKind
    this.prefsKind = deps.prefsKind
  }

  async insert(pk: StoredPasskey): Promise<void> {
    const parsed = authWebauthnRecordKinds.passkeys.schema.safeParse(pkToBody(pk))
    if (!parsed.success) throw new Error(parsed.error.message)
    await this.passkeysKind.put({ id: pk.credentialId, data: parsed.data })
  }

  async findByCredentialId(credentialId: string): Promise<StoredPasskey | null> {
    const page = await this.passkeysKind.query({ where: { credentialId }, limit: 1 })
    const row = page.records[0]
    return row === undefined ? null : rowToPasskey(row.id, row.data)
  }

  async findByUserId(userId: string): Promise<readonly StoredPasskey[]> {
    const page = await this.passkeysKind.query({ where: { userId }, limit: 500 })
    return page.records.map((row) => rowToPasskey(row.id, row.data))
  }

  async updateCounter(credentialId: string, counter: number): Promise<void> {
    const existing = await this.findByCredentialId(credentialId)
    if (!existing) return
    const next: StoredPasskey = { ...existing, counter, lastUsedAt: Date.now() }
    const parsed = authWebauthnRecordKinds.passkeys.schema.safeParse(pkToBody(next))
    if (!parsed.success) return
    await this.passkeysKind.put({ id: credentialId, data: parsed.data })
  }

  async delete(credentialId: string): Promise<void> {
    await this.passkeysKind.delete(credentialId)
  }

  async getSecondFactorPreference(userId: string): Promise<boolean> {
    const row = await this.prefsKind.get(userId)
    const parsed = StoredPreferenceSchema.safeParse(row?.data)
    return parsed.success ? parsed.data.secondFactorEnabled : false
  }

  async setSecondFactorPreference(userId: string, enabled: boolean): Promise<void> {
    const value: StoredPreference = { secondFactorEnabled: enabled, updatedAt: Date.now() }
    const parsed = authWebauthnRecordKinds['passkey-prefs'].schema.safeParse(value)
    if (!parsed.success) throw new Error(parsed.error.message)
    await this.prefsKind.put({ id: userId, data: parsed.data })
  }
}
