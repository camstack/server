/**
 * The hidden state of ONE skill, kept in its `skill-state` record: the ingress token, the vision
 * namespace and what Alexa was last told. Writes are serialised and always put the whole body, so
 * a patch can never replace a map half-read, and while the keychain is locked the state takes NO
 * write (a half-read record must never overwrite the credential, D49).
 */
import type { IScopedLogger, RecordKindHandle } from '@camstack/types'
import { RecordSecretUnavailableError } from '@camstack/types'
import { EMPTY_SKILL_STATE, type SkillStateBody } from './skill-records.js'

export interface SkillStateStoreDeps {
  readonly handle: Pick<RecordKindHandle<SkillStateBody>, 'getResolved' | 'put'>
  readonly instanceId: string
  readonly logger: IScopedLogger
}

export class SkillStateStore {
  private row: SkillStateBody | null = null
  private locked = false
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: SkillStateStoreDeps) {}

  /** The state as last read; the empty state while the record does not exist. */
  get current(): SkillStateBody {
    return this.row ?? EMPTY_SKILL_STATE
  }

  get isLocked(): boolean {
    return this.locked
  }

  /** Re-read the record. A failed read changes nothing: the store keeps what it had. */
  async refresh(): Promise<void> {
    try {
      this.row = (await this.deps.handle.getResolved(this.deps.instanceId))?.data ?? null
      this.locked = false
    } catch (err: unknown) {
      if (err instanceof RecordSecretUnavailableError) {
        this.locked = true
        this.deps.logger.warn(
          'export-alexa: the keychain is locked; the skill state is read-only',
          {
            tags: { topic: 'export-alexa', phase: 'keychain-locked' },
          },
        )
        return
      }
      this.deps.logger.warn('export-alexa: the skill state record could not be read', {
        meta: { error: err instanceof Error ? err.message : String(err) },
        tags: { topic: 'export-alexa', phase: 'records-read-failed' },
      })
    }
  }

  /** Merge a patch into the state. Refused while the keychain is locked. */
  update(patch: Partial<SkillStateBody>): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.locked) {
        throw new Error('the keychain is locked: the Alexa skill state cannot be changed right now')
      }
      const next: SkillStateBody = { ...this.current, ...patch }
      await this.deps.handle.put({ id: this.deps.instanceId, data: next })
      this.row = next
    }
    const result = this.queue.then(run, run)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * Fill the identity a skill needs: a token and a namespace. Only what is MISSING is generated;
   * a token that exists is never replaced, and a locked keychain generates nothing (the token may
   * exist behind it, and a new one would break the skill's Lambda).
   */
  async ensureIdentity(generate: {
    readonly token: () => string
    readonly namespace: () => string
  }): Promise<void> {
    await this.refresh()
    if (this.locked) return
    const missing: Partial<SkillStateBody> = {
      ...(this.current.ingressToken ? {} : { ingressToken: generate.token() }),
      ...(this.current.visionNamespace ? {} : { visionNamespace: generate.namespace() }),
    }
    if (Object.keys(missing).length > 0) await this.update(missing)
  }
}
