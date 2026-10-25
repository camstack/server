/**
 * Who is CONNECTED to this accessory right now, and which of them may write.
 *
 * ## The branch this exists to make visible
 *
 * HKSV has two writes and they come from different places. The iPhone writes
 * `CameraRecordingManagement.Active` when the operator picks "Stream & Allow
 * Recording". The **resident home hub** is what writes
 * `SelectedCameraRecordingConfiguration` and then opens the HDS recording
 * stream — the iPhone never does.
 *
 * Both characteristics carry `adminOnlyAccess: [Access.WRITE]`, and hap-nodejs
 * enforces that in `Accessory.handleSetCharacteristics`: a controller without
 * admin permission gets `HAPStatus.INSUFFICIENT_PRIVILEGES` and the write never
 * reaches the characteristic. That refusal emits NO characteristic warning and
 * logs nothing above `debug` — so "the hub is paired but not an admin" and "the
 * hub never tried" are, from our side, the same total silence.
 *
 * On 2026-08-08 camera 101 sat with `Active = true` persisted and no
 * `selectedConfiguration` at all, with a controller holding a connection to
 * every camera accessory. Distinguishing those two cases needed a census of the
 * connections and their permissions, and there was none.
 *
 * TYPE BOUNDARY: `Accessory._server`, `HAPServer.httpServer`,
 * `EventedHTTPServer.connections`, `HAPConnection.username` and
 * `Accessory._accessoryInfo` are hap-nodejs internals with no public accessor —
 * the same boundary `doorbell-delivery.ts` already crosses. Every hop is
 * optional and narrowed by a guard: a shape change in the library degrades this
 * to `serverPublished: false`, never to a throw on a control path.
 */

/** A census of the HAP connections open on one accessory. */
export interface HapControllerCensus {
  /** True when the accessory owns a running HAP server. */
  readonly serverPublished: boolean
  /** Open HAP connections — iPhones with the app in front, home hubs, … */
  readonly connections: number
  /** Connections whose paired identity holds ADMIN, so may write HKSV state. */
  readonly adminConnections: number
  /** Connections whose paired identity is NOT admin. Every HKSV write they
   *  attempt is refused with `INSUFFICIENT_PRIVILEGES`, silently. */
  readonly nonAdminConnections: number
  /** Connections not yet authenticated (or whose identity we could not read). */
  readonly unverifiedConnections: number
  /** Paired controllers on this accessory, total and admin — from the store,
   *  so it counts the hub even while it is disconnected. */
  readonly pairedControllers: number
  readonly pairedAdmins: number
}

const EMPTY_CENSUS: HapControllerCensus = {
  serverPublished: false,
  connections: 0,
  adminConnections: 0,
  nonAdminConnections: 0,
  unverifiedConnections: 0,
  pairedControllers: 0,
  pairedAdmins: 0,
}

interface AccessoryInfoLike {
  readonly pairedClients: Record<string, unknown>
  readonly hasAdminPermissions: (username: string) => boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return isRecord(value) && typeof Reflect.get(value, Symbol.iterator) === 'function'
}

function isAccessoryInfoLike(value: unknown): value is AccessoryInfoLike {
  return (
    isRecord(value) &&
    isRecord(value['pairedClients']) &&
    typeof value['hasAdminPermissions'] === 'function'
  )
}

/** `accessory._server.httpServer.connections`, or null at any missing hop. */
function readConnections(accessory: Record<string, unknown>): Iterable<unknown> | null {
  const server = accessory['_server']
  if (!isRecord(server)) return null
  const httpServer = server['httpServer']
  if (!isRecord(httpServer)) return null
  const connections = httpServer['connections']
  return isIterable(connections) ? connections : null
}

/**
 * Census the accessory's HAP connections. Pure with respect to HAP state — it
 * only reads — and never throws.
 */
export function describeHapControllers(accessory: unknown): HapControllerCensus {
  if (!isRecord(accessory)) return EMPTY_CENSUS
  const info = accessory['_accessoryInfo']
  const paired = isAccessoryInfoLike(info) ? Object.keys(info.pairedClients) : []
  const pairedAdmins = isAccessoryInfoLike(info)
    ? paired.filter((username) => info.hasAdminPermissions(username)).length
    : 0

  const connections = readConnections(accessory)
  if (connections === null) {
    return {
      ...EMPTY_CENSUS,
      pairedControllers: paired.length,
      pairedAdmins,
    }
  }

  let open = 0
  let admins = 0
  let nonAdmins = 0
  let unverified = 0
  for (const connection of connections) {
    open += 1
    const username = isRecord(connection) ? connection['username'] : undefined
    if (typeof username !== 'string' || !isAccessoryInfoLike(info)) {
      unverified += 1
      continue
    }
    if (info.hasAdminPermissions(username)) admins += 1
    else nonAdmins += 1
  }

  return {
    serverPublished: true,
    connections: open,
    adminConnections: admins,
    nonAdminConnections: nonAdmins,
    unverifiedConnections: unverified,
    pairedControllers: paired.length,
    pairedAdmins,
  }
}

/**
 * True when NO connected controller may write HKSV state. Every
 * `SelectedCameraRecordingConfiguration` write such a controller sends is
 * refused before it reaches us, so the recording configuration can never
 * arrive and the caller must say so out loud.
 */
export function noAdminControllerConnected(census: HapControllerCensus): boolean {
  return census.serverPublished && census.connections > 0 && census.adminConnections === 0
}
