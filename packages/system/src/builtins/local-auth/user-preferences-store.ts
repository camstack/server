/**
 * Per-user account preferences (D894): one row per `(userId, namespace)`.
 *
 * Every method takes the OWNER's id as its first argument and touches only
 * that user's rows; the hub router stamps it from the principal, and nothing
 * here accepts a second user id.
 *
 * The poll (`changedSince`) is answered from an in-memory mirror of each
 * user's `namespace → revision`, loaded once on first touch. This store is the
 * kind's only writer (one in-process instance in `local-auth`), so the mirror
 * cannot fall behind the rows; a poll that finds nothing changed reads no row.
 * Writes of one user are serialized, so a read-modify-write never interleaves.
 */
import {
  PREFERENCES_MAX_NAMESPACES,
  PREFERENCES_MAX_VALUE_BYTES,
  type PreferenceRow,
  type PreferencesChangedSinceOutput,
  type PreferencesPutInput,
  type PreferencesPutOutput,
  type RecordKindHandle,
  type RecordRow,
} from '@camstack/types'
import { type UserPreferenceBody, userPreferenceRecordId } from './preferences-record-kinds.js'

export type PreferencesLimitReason = 'value-too-large' | 'too-many-namespaces'

/** A write the limits refuse; nothing was stored. */
export class PreferencesLimitError extends Error {
  constructor(
    readonly reason: PreferencesLimitReason,
    message: string,
  ) {
    super(message)
    this.name = 'PreferencesLimitError'
  }
}

/**
 * The limit refusal behind `error`, or `null`. By name and field, not
 * `instanceof`: the store and its caller may load different copies of this
 * module.
 */
export function preferencesLimitReasonOf(error: unknown): PreferencesLimitReason | null {
  if (!(error instanceof Error) || error.name !== 'PreferencesLimitError') return null
  const reason: unknown = Reflect.get(error, 'reason')
  return reason === 'value-too-large' || reason === 'too-many-namespaces' ? reason : null
}

export interface UserPreferencesStoreOptions {
  readonly now?: () => number
}

/** The page size of a per-user scan; one page covers a user within the limit. */
const USER_SCAN_PAGE = PREFERENCES_MAX_NAMESPACES + 8

/** The page size of the boot orphan sweep over every user's rows. */
const ORPHAN_SCAN_PAGE = 500

function toRow(body: UserPreferenceBody): PreferenceRow {
  return {
    namespace: body.namespace,
    value: body.value,
    revision: body.revision,
    updatedAt: body.updatedAt,
    updatedByDevice: body.updatedByDevice,
  }
}

function byNamespace(a: PreferenceRow, b: PreferenceRow): number {
  return a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0
}

export class UserPreferencesStore {
  private readonly now: () => number
  /** `userId → namespace → revision`; absent until the user is first touched. */
  private readonly mirrors = new Map<string, Map<string, number>>()
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly kind: RecordKindHandle<UserPreferenceBody>,
    options: UserPreferencesStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now
  }

  /** The caller's rows; `namespaces` narrows them (unknown ones are simply absent). */
  async get(userId: string, namespaces?: readonly string[]): Promise<readonly PreferenceRow[]> {
    if (namespaces === undefined) {
      const rows = await this.scanUser(userId)
      return rows.map((r) => toRow(r.data)).toSorted(byNamespace)
    }
    const rows = await this.kind.getMany(
      [...new Set(namespaces)].map((ns) => userPreferenceRecordId(userId, ns)),
    )
    return rows
      .filter((r) => r.data.userId === userId)
      .map((r) => toRow(r.data))
      .toSorted(byNamespace)
  }

  async put(userId: string, input: PreferencesPutInput): Promise<PreferencesPutOutput> {
    const bytes = Buffer.byteLength(JSON.stringify(input.value), 'utf8')
    if (bytes > PREFERENCES_MAX_VALUE_BYTES) {
      throw new PreferencesLimitError(
        'value-too-large',
        `preferences: ${input.namespace} is ${bytes} bytes, the limit is ${PREFERENCES_MAX_VALUE_BYTES}`,
      )
    }
    return this.serialized(userId, async () => {
      const mirror = await this.mirrorOf(userId)
      const id = userPreferenceRecordId(userId, input.namespace)
      const existing = await this.kind.get(id)
      const currentRevision = existing?.data.revision ?? 0
      if (input.baseRevision !== undefined && input.baseRevision !== currentRevision) {
        return { status: 'conflict', current: existing === null ? null : toRow(existing.data) }
      }
      if (existing === null && mirror.size >= PREFERENCES_MAX_NAMESPACES) {
        throw new PreferencesLimitError(
          'too-many-namespaces',
          `preferences: a user holds at most ${PREFERENCES_MAX_NAMESPACES} namespaces`,
        )
      }
      const body: UserPreferenceBody = {
        userId,
        namespace: input.namespace,
        value: input.value,
        revision: currentRevision + 1,
        updatedAt: this.now(),
        updatedByDevice: input.deviceId ?? null,
      }
      // `ifRev` 0 = "must not exist": the engine refuses a write that raced past the read.
      await this.kind.put({ id, data: body }, { ifRev: existing?.rev ?? 0 })
      mirror.set(input.namespace, body.revision)
      return { status: 'saved', row: toRow(body) }
    })
  }

  /** `false` when the namespace did not exist. */
  async delete(userId: string, namespace: string): Promise<boolean> {
    return this.serialized(userId, async () => {
      const mirror = await this.mirrorOf(userId)
      const deleted = await this.kind.delete(userPreferenceRecordId(userId, namespace))
      mirror.delete(namespace)
      return deleted
    })
  }

  /**
   * What the client is missing: every row whose revision differs from the one
   * it holds (or that it does not list), and every listed namespace now gone.
   */
  async changedSince(
    userId: string,
    known: Readonly<Record<string, number>>,
  ): Promise<PreferencesChangedSinceOutput> {
    const mirror = await this.mirrorOf(userId)
    const changed: string[] = []
    for (const [namespace, revision] of mirror) {
      if (known[namespace] !== revision) changed.push(namespace)
    }
    const deleted = Object.keys(known)
      .filter((namespace) => !mirror.has(namespace))
      .toSorted()
    const rows = changed.length === 0 ? [] : await this.get(userId, changed)
    return { rows: [...rows], deleted }
  }

  /** Every row of `userId` goes (user delete). Returns how many. */
  async wipeUser(userId: string): Promise<number> {
    return this.serialized(userId, async () => {
      const rows = await this.scanUser(userId)
      const removed = rows.length === 0 ? 0 : await this.kind.deleteMany(rows.map((r) => r.id))
      this.mirrors.delete(userId)
      return removed
    })
  }

  /** Rows whose user is not in `liveUserIds` go (boot sweep). Returns how many. */
  async wipeOrphans(liveUserIds: ReadonlySet<string>): Promise<number> {
    const orphans = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await this.kind.query({
        order: 'id',
        limit: ORPHAN_SCAN_PAGE,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      for (const row of page.records) {
        if (!liveUserIds.has(row.data.userId)) orphans.add(row.data.userId)
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    let removed = 0
    for (const userId of orphans) removed += await this.wipeUser(userId)
    return removed
  }

  private async mirrorOf(userId: string): Promise<Map<string, number>> {
    const cached = this.mirrors.get(userId)
    if (cached !== undefined) return cached
    const rows = await this.scanUser(userId)
    // A concurrent first touch may have filled it meanwhile; keep the first.
    const raced = this.mirrors.get(userId)
    if (raced !== undefined) return raced
    const mirror = new Map(rows.map((r) => [r.data.namespace, r.data.revision] as const))
    this.mirrors.set(userId, mirror)
    return mirror
  }

  private async scanUser(userId: string): Promise<readonly RecordRow<UserPreferenceBody>[]> {
    const out: RecordRow<UserPreferenceBody>[] = []
    let cursor: string | undefined
    do {
      const page = await this.kind.query({
        where: { userId },
        limit: USER_SCAN_PAGE,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      out.push(...page.records)
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    return out
  }

  /** Run `task` after every earlier write of the same user has settled. */
  private serialized<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve()
    const next = previous.then(task, task)
    const settled = next.catch(() => undefined)
    this.locks.set(userId, settled)
    void settled.then(() => {
      if (this.locks.get(userId) === settled) this.locks.delete(userId)
    })
    return next
  }
}
