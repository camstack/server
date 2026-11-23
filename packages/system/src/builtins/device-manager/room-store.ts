/**
 * The rooms and site zones of the property, as records with an id (D1089).
 *
 * `rooms` and `zones` are record kinds the device manager owns; a device meta
 * carries `locationId`, a room carries `zoneId`. The store keeps both in memory
 * once read — a device read resolves a room name through {@link RoomStore.nameOf}
 * without a query, and an unknown id reads as unset.
 */
import {
  RoomBodySchema,
  ZoneBodySchema,
  type RecordsAccess,
  type RoomBody,
  type ZoneBody,
} from '@camstack/types'
import { NamedEntityStore } from '../../records/named-entity-store.js'
import { deviceManagerRecordKinds } from './record-kinds.js'

export class RoomStore {
  constructor(
    readonly rooms: NamedEntityStore<RoomBody>,
    readonly zones: NamedEntityStore<ZoneBody>,
  ) {}

  static of(records: Pick<RecordsAccess, 'kind'>): RoomStore {
    return new RoomStore(
      new NamedEntityStore<RoomBody>('room', records.kind(deviceManagerRecordKinds.rooms), (body) =>
        RoomBodySchema.parse(body),
      ),
      new NamedEntityStore<ZoneBody>('zone', records.kind(deviceManagerRecordKinds.zones), (body) =>
        ZoneBodySchema.parse(body),
      ),
    )
  }

  async load(): Promise<void> {
    await this.rooms.load()
    await this.zones.load()
  }

  /** The current name of room `id`; `null` when unset or unknown. */
  nameOf(id: string | null | undefined): string | null {
    return this.rooms.nameOf(id)
  }
}
