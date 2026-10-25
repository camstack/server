import type { IElementConfig } from '../interfaces/context.js'
import type { ISettingsBackend } from '../interfaces/storage.js'

/**
 * Persisted config store for a single element.
 * Reads/writes to the element's scoped storage under the 'config' collection.
 * Notifies listeners on every change.
 */
export class ElementConfigStore implements IElementConfig {
  private cache: Record<string, unknown> = {}
  private listeners: Set<(config: Record<string, unknown>) => void> = new Set()
  private loaded = false

  private readonly getBackend: () => ISettingsBackend | null

  constructor(
    private readonly elementId: string,
    settingsBackend: ISettingsBackend | (() => ISettingsBackend | null) | null,
  ) {
    // Accept either a direct backend or a lazy getter for late-wired backends
    this.getBackend =
      typeof settingsBackend === 'function' ? settingsBackend : () => settingsBackend
  }

  /** Load config from storage into cache. Called once on first access. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    const backend = this.getBackend()
    if (!backend) {
      throw new Error(`ElementConfigStore(${this.elementId}): settings backend not available`)
    }

    const records = await backend.query({
      collection: 'config',
      filter: {
        where: { id: this.elementId },
        limit: 1,
      },
    })
    if (records.length > 0) {
      this.cache = records[0]!.data ?? {}
    }
    this.loaded = true
  }

  getAll(): Record<string, unknown> {
    return { ...this.cache }
  }

  get<T = unknown>(key: string): T | undefined {
    const parts = key.split('.')
    let current: unknown = this.cache
    for (const part of parts) {
      if (current === null || typeof current !== 'object' || Array.isArray(current))
        return undefined
      current = Reflect.get(current, part)
    }
    // Type-level bridge: callers supply T based on their knowledge of the
    // stored schema — the runtime has no way to prove the shape matches.
    return current as T | undefined
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.ensureLoaded()
    setNestedValue(this.cache, key, value)
    await this.persist()
    this.notifyListeners()
  }

  async setAll(config: Record<string, unknown>): Promise<void> {
    await this.ensureLoaded()
    this.cache = { ...config }
    await this.persist()
    this.notifyListeners()
  }

  onChange(callback: (config: Record<string, unknown>) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  /** Initialize from storage — called by ContextFactory after creation */
  async load(): Promise<void> {
    await this.ensureLoaded()
  }

  /** Initialize with default values (doesn't overwrite existing) */
  async loadDefaults(defaults: Record<string, unknown>): Promise<void> {
    await this.ensureLoaded()
    if (Object.keys(this.cache).length === 0) {
      this.cache = { ...defaults }
      await this.persist()
    }
  }

  private async persist(): Promise<void> {
    const backend = this.getBackend()
    if (!backend) {
      throw new Error(
        `ElementConfigStore(${this.elementId}): settings backend not available — cannot persist config`,
      )
    }

    // Use set() for upsert semantics — avoids race condition where two
    // concurrent persist() calls both see "no existing row" and both insert.
    await backend.set({ collection: 'config', key: this.elementId, value: this.cache })
  }

  private notifyListeners(): void {
    const snapshot = this.getAll()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Don't let one bad listener kill others
      }
    }
  }
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let current: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!
    const existing = current[part]
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      const fresh: Record<string, unknown> = {}
      current[part] = fresh
      current = fresh
    } else {
      current = existing as Record<string, unknown>
    }
  }
  current[parts[parts.length - 1]!] = value
}
