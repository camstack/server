/** The Echo worker's cookie jar per broker, in the records store (secret field, keychain-backed). */
import {
  type RecordKindHandle,
  type RecordsAccess,
  RecordSecretUnavailableError,
} from '@camstack/types'
import { type AlexaSpeakSessionBody, alexaSpeakSessionsEntryKind } from '../broker-record-kinds.js'

export interface SpeakSessionStore {
  /** Base64 of the jar, or '' when none is stored or the keychain cannot serve it. */
  get(brokerId: string): Promise<string>
  put(brokerId: string, sessionB64: string): Promise<void>
  delete(brokerId: string): Promise<void>
}

export class RecordsSpeakSessionStore implements SpeakSessionStore {
  constructor(private readonly kind: RecordKindHandle<AlexaSpeakSessionBody>) {}

  static of(records: Pick<RecordsAccess, 'kind'>): RecordsSpeakSessionStore {
    return new RecordsSpeakSessionStore(records.kind(alexaSpeakSessionsEntryKind))
  }

  async get(brokerId: string): Promise<string> {
    try {
      const resolved = await this.kind.getResolved(brokerId)
      return resolved === null ? '' : resolved.data.session
    } catch (err: unknown) {
      if (err instanceof RecordSecretUnavailableError) return ''
      throw err
    }
  }

  async put(brokerId: string, sessionB64: string): Promise<void> {
    await this.kind.put({ id: brokerId, data: { name: brokerId, session: sessionB64 } })
  }

  async delete(brokerId: string): Promise<void> {
    await this.kind.delete(brokerId)
  }
}
