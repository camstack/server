/**
 * The Google Home INSTANCES at runtime (planning#422 P2). One instance is one Actions-console
 * project: a `google-homes` row, plus the `google-exports` row (what it syncs) and the
 * `google-links` row (who linked it) under the same id.
 *
 * An instance is built only AFTER both of its rows were read. A request therefore never meets an
 * instance whose link ledger is still empty because the read had not finished: the first SYNC
 * after a boot would otherwise write that empty ledger over the real one. A read that fails
 * rejects (and is not cached), so the request fails and a later one reads again.
 */
import type { IScopedLogger, RecordKindHandle } from '@camstack/types'
import type { ActionSceneEntry, ActionSceneExports } from './action-scenes.js'
import {
  EMPTY_GOOGLE_EXPORTS,
  EMPTY_GOOGLE_LINKS,
  type GoogleExportsBody,
  type GoogleHomeBody,
  type GoogleLinksBody,
} from './export-records.js'
import type { VerifiedGoogleCaller } from './fulfillment-router.js'
import type { ExposedDeviceEntry, LinkedAccount } from './types.js'

/** The most instances one hub lists. */
const INSTANCES_MAX = 1000

export interface GoogleInstanceStores {
  readonly homes: RecordKindHandle<GoogleHomeBody>
  readonly exports: RecordKindHandle<GoogleExportsBody>
  readonly links: RecordKindHandle<GoogleLinksBody>
}

/** Builds the action-scene exposure of ONE instance, persisting through `persist`. */
export type SceneFactory = (
  persist: (entries: readonly ActionSceneEntry[]) => Promise<void>,
  initial: readonly ActionSceneEntry[],
) => ActionSceneExports

export class GoogleInstance {
  readonly scenes: ActionSceneExports
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    readonly id: string,
    private home: GoogleHomeBody,
    private exportsRow: GoogleExportsBody,
    private linksRow: GoogleLinksBody,
    private readonly stores: GoogleInstanceStores,
    private readonly logger: IScopedLogger,
    makeScenes: SceneFactory,
  ) {
    this.scenes = makeScenes(
      (entries) => this.writeExports({ actions: [...entries] }),
      exportsRow.actions,
    )
  }

  get name(): string {
    return this.home.name
  }

  get enabled(): boolean {
    return this.home.enabled !== false
  }

  get devices(): readonly ExposedDeviceEntry[] {
    return this.exportsRow.devices
  }

  get linkedAccounts(): readonly LinkedAccount[] {
    return this.linksRow.linkedAccounts
  }

  applyHome(home: GoogleHomeBody): void {
    this.home = home
  }

  isExposed(deviceId: number): boolean {
    return this.exportsRow.devices.some((entry) => entry.deviceId === deviceId)
  }

  /** One write at a time per instance: two concurrent changes must not lose each other. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work)
    this.tail = run.catch(() => undefined)
    return run
  }

  /** Persist a change of the exposure: the record first, the in-memory copy after it landed. */
  writeExports(patch: Partial<Pick<GoogleExportsBody, 'devices' | 'actions'>>): Promise<void> {
    return this.serial(async () => {
      const next: GoogleExportsBody = {
        name: this.exportsRow.name,
        devices: patch.devices ?? this.exportsRow.devices,
        actions: patch.actions ?? this.exportsRow.actions,
      }
      await this.stores.exports.put({ id: this.id, data: next })
      this.exportsRow = next
    })
  }

  /** Google's SYNC is the first thing a completed link does: the only "linked" signal there is. */
  recordLink(caller: VerifiedGoogleCaller): Promise<void> {
    return this.serial(async () => {
      if (this.linksRow.linkedAccounts.some((a) => a.userId === caller.userId)) return
      const next: GoogleLinksBody = {
        name: this.linksRow.name,
        linkedAccounts: [
          ...this.linksRow.linkedAccounts,
          { userId: caller.userId, username: caller.username, linkedAt: Date.now() },
        ],
      }
      await this.stores.links.put({ id: this.id, data: next })
      this.linksRow = next
      this.logger.info('export-google: recorded linked account', {
        meta: { instanceId: this.id, userId: caller.userId },
      })
    })
  }

  removeLink(userId: string): Promise<void> {
    return this.serial(async () => {
      const kept = this.linksRow.linkedAccounts.filter((a) => a.userId !== userId)
      if (kept.length === this.linksRow.linkedAccounts.length) return
      const next: GoogleLinksBody = { name: this.linksRow.name, linkedAccounts: kept }
      await this.stores.links.put({ id: this.id, data: next })
      this.linksRow = next
    })
  }
}

export class GoogleInstanceRegistry {
  private readonly loaded = new Map<string, GoogleInstance>()
  private readonly loading = new Map<string, Promise<GoogleInstance | null>>()

  constructor(
    private readonly stores: GoogleInstanceStores,
    private readonly logger: IScopedLogger,
    private readonly makeScenes: SceneFactory,
  ) {}

  /** The instance, loaded (home, exposure AND links) on first use; null when no such instance. */
  get(id: string): Promise<GoogleInstance | null> {
    const ready = this.loaded.get(id)
    if (ready !== undefined) return Promise.resolve(ready)
    const inFlight = this.loading.get(id)
    if (inFlight !== undefined) return inFlight
    const started = this.load(id).finally(() => {
      this.loading.delete(id)
    })
    this.loading.set(id, started)
    return started
  }

  /** An instance already loaded; never reads. */
  peek(id: string): GoogleInstance | undefined {
    return this.loaded.get(id)
  }

  private async load(id: string): Promise<GoogleInstance | null> {
    const home = await this.stores.homes.get(id)
    if (home === null) return null
    const [exported, links] = await Promise.all([
      this.stores.exports.get(id),
      this.stores.links.get(id),
    ])
    const instance = new GoogleInstance(
      id,
      home.data,
      exported?.data ?? EMPTY_GOOGLE_EXPORTS,
      links?.data ?? EMPTY_GOOGLE_LINKS,
      this.stores,
      this.logger,
      this.makeScenes,
    )
    this.loaded.set(id, instance)
    return instance
  }

  /** Every instance row, as stored. */
  async list(): Promise<readonly { readonly id: string; readonly body: GoogleHomeBody }[]> {
    const page = await this.stores.homes.query({ limit: INSTANCES_MAX })
    return page.records.map((record) => ({ id: record.id, body: record.data }))
  }

  /** The instance row changed (name, switch): a loaded instance takes it. */
  async refreshHome(id: string): Promise<void> {
    const home = await this.stores.homes.get(id)
    const instance = this.loaded.get(id)
    if (home === null) {
      this.loaded.delete(id)
      return
    }
    if (instance === undefined) {
      await this.get(id)
      return
    }
    instance.applyHome(home.data)
  }

  /** The instance is gone: its exposure and links rows go with it, and nothing serves it. */
  async remove(id: string): Promise<void> {
    this.loaded.delete(id)
    this.loading.delete(id)
    await this.stores.exports.delete(id)
    await this.stores.links.delete(id)
    this.logger.info('export-google: instance deleted with its exposure and links', {
      meta: { instanceId: id },
    })
  }
}
