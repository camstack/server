/**
 * A set of named entities held as records with an id (D1089): a room, a site
 * zone, a tag.
 *
 * The store reads every record once (few, hand-made) and keeps the working copy
 * here; a write goes to the record first and lands in the map only when it
 * succeeded. ONE operation is ONE `put` of ONE record — a rename never touches
 * a record that merely references the entity.
 *
 * A name is unique within the store, compared by `entityNameKey`. `ensure` of a
 * name that exists returns the existing entity, so "type a new name in the
 * picker" is one call. A reference whose id is unknown reads as `null`
 * ({@link nameOf}): a reader never throws on it and never shows the raw id.
 */
import { type EntityKind, entityNameKey, newEntityId, type RecordKindHandle } from '@dominevo/types'
import { createWriteLock, type WriteLock } from '../builtins/device-manager/write-lock.js'
import { readAllRows } from './read-all-rows.js'

export interface NamedBody {
  readonly name: string
  readonly order?: number | undefined
}

/** The entity as it travels: the record id beside its body. */
export type Entity<TBody extends NamedBody> = TBody & { readonly id: string }

/** Refused: the name belongs to another entity of the same kind. */
export class EntityNameTakenError extends Error {
  constructor(
    readonly entityKind: EntityKind,
    readonly name: string,
  ) {
    super(`[${entityKind}] name already taken: ${name}`)
    this.name = 'EntityNameTakenError'
  }
}

/** Refused: no entity has this id. */
export class EntityNotFoundError extends Error {
  constructor(
    readonly entityKind: EntityKind,
    readonly id: string,
  ) {
    super(`[${entityKind}] not found: ${id}`)
    this.name = 'EntityNotFoundError'
  }
}

export class NamedEntityStore<TBody extends NamedBody> {
  private entities: Map<string, Entity<TBody>> = new Map()
  private readonly lock: WriteLock = createWriteLock()

  constructor(
    readonly entityKind: EntityKind,
    private readonly kind: RecordKindHandle<TBody>,
    private readonly validate: (body: unknown) => TBody,
  ) {}

  async load(): Promise<void> {
    const rows = await readAllRows(this.kind)
    this.entities = new Map(rows.map((row) => [row.id, { ...row.data, id: row.id }]))
  }

  /** The name of entity `id`, or `null` when unset or unknown. Never the id. */
  nameOf(id: string | null | undefined): string | null {
    if (id === null || id === undefined) return null
    return this.entities.get(id)?.name ?? null
  }

  get(id: string): Entity<TBody> | null {
    return this.entities.get(id) ?? null
  }

  /** The entity named `name` (trimmed, case-insensitive), or `null`. */
  findByName(name: string): Entity<TBody> | null {
    const key = entityNameKey(name)
    for (const entity of this.entities.values()) {
      if (entityNameKey(entity.name) === key) return entity
    }
    return null
  }

  list(): readonly Entity<TBody>[] {
    return [...this.entities.values()].toSorted((a, b) => {
      const ao = orderOf(a)
      const bo = orderOf(b)
      if (ao !== bo) return ao - bo
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  }

  /**
   * Create the entity named `name`, or return the one that has it. `preferredId` is the id a
   * migration already wrote into referencing rows: it is adopted when no entity holds it (a record
   * that arrives late never orphans a migrated id), else a fresh id is minted.
   */
  async ensure(
    name: string,
    extra: Omit<TBody, 'name'>,
    preferredId?: string,
  ): Promise<Entity<TBody>> {
    return this.lock(async () => {
      const existing = this.findByName(name)
      if (existing !== null) return existing
      const body = this.validate({ ...extra, name: name.trim() })
      const id =
        preferredId !== undefined && !this.entities.has(preferredId)
          ? preferredId
          : newEntityId(this.entityKind)
      await this.kind.put({ id, data: body })
      const created: Entity<TBody> = { ...body, id }
      this.entities.set(id, created)
      return created
    })
  }

  /** Replace the body of `id` with `next(current)`: ONE put. */
  async update(id: string, next: (current: TBody) => TBody): Promise<Entity<TBody>> {
    return this.lock(async () => {
      const current = this.entities.get(id)
      if (current === undefined) throw new EntityNotFoundError(this.entityKind, id)
      const { id: _id, ...currentBody } = current
      const body = this.validate(next(this.validate(currentBody)))
      const holder = this.findByName(body.name)
      if (holder !== null && holder.id !== id) {
        throw new EntityNameTakenError(this.entityKind, body.name)
      }
      await this.kind.put({ id, data: body })
      const updated: Entity<TBody> = { ...body, id }
      this.entities.set(id, updated)
      return updated
    })
  }

  /** Remove the record. Returns whether it existed. The caller clears references. */
  async delete(id: string): Promise<boolean> {
    return this.lock(async () => {
      if (!this.entities.has(id)) return false
      await this.kind.delete(id)
      this.entities.delete(id)
      return true
    })
  }
}

function orderOf(entity: { readonly order?: number }): number {
  return entity.order ?? Number.MAX_SAFE_INTEGER
}
