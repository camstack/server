/**
 * The announcements of an update that is NOT the `@camstack/server` closure
 * (D723 covered that one): the Electron shell replacing itself, and a container
 * that booted on a different image than its previous boot.
 *
 * Both travel as the same `system.restarting` payload the closure update uses,
 * so the notification centre's one split (`restartIsUpdate`) turns them into
 * `node-updating` with no new kind and no new event. `what` says which part is
 * being replaced; `packageName` is its operator-facing name.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  EventCategory,
  type IEventBus,
  type IScopedLogger,
  type NodeUpdateTarget,
  type PendingRestartMarkerPayload,
} from '@camstack/types'

/** Operator-facing name of what each non-closure update replaces. */
const UPDATE_TARGET_LABEL: Readonly<Record<Exclude<NodeUpdateTarget, 'server'>, string>> = {
  'desktop-shell': 'CamStack desktop app',
  'container-image': 'CamStack container image',
}

/** Where a boot records the product version it ran, to compare with the next boot. */
const LAST_BOOT_PRODUCT_VERSION_FILE = 'last-boot-product-version'

export interface NodeUpdateAnnouncementInput {
  readonly what: Exclude<NodeUpdateTarget, 'server'>
  readonly fromVersion?: string
  readonly toVersion?: string
  readonly requestedAt: number
}

export function buildNodeUpdateAnnouncement(
  input: NodeUpdateAnnouncementInput,
): PendingRestartMarkerPayload {
  return {
    kind: 'framework-update',
    what: input.what,
    packageName: UPDATE_TARGET_LABEL[input.what],
    ...(input.fromVersion !== undefined ? { fromVersion: input.fromVersion } : {}),
    ...(input.toVersion !== undefined ? { toVersion: input.toVersion } : {}),
    requestedAt: input.requestedAt,
  }
}

/** Emit the announcement through the node's event bus (telemetry, D8: never throws). */
export function emitNodeUpdateAnnouncement(
  bus: IEventBus,
  sourceId: string,
  nodeId: string,
  payload: PendingRestartMarkerPayload,
): void {
  bus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'core', id: sourceId },
    category: EventCategory.SystemRestarting,
    data: { ...payload, nodeId },
  })
}

export interface ProductVersionChange {
  readonly from: string
  readonly to: string
}

/**
 * Compare the product version this boot runs (`CAMSTACK_PRODUCT_VERSION`, set
 * by the image) with the one the previous boot recorded, then record this one.
 * The record is ONE small file in the data dir: the image is replaced under the
 * node, so the data dir is the only thing that remembers the old one.
 *
 * `null` for the first boot, an unchanged version, or an unknown current
 * version (a dev workspace leaves it unset — absence, not a change; the record
 * is left alone then).
 */
export function detectProductVersionChange(
  dataDir: string,
  current: string | null,
): ProductVersionChange | null {
  if (current === null) return null
  const file = path.join(dataDir, LAST_BOOT_PRODUCT_VERSION_FILE)
  let previous: string | null = null
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim()
    previous = raw.length > 0 ? raw : null
  } catch {
    previous = null
  }
  if (previous === current) return null
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(file, `${current}\n`, 'utf-8')
  return previous === null ? null : { from: previous, to: current }
}

export interface ProductVersionAnnouncementInput {
  readonly dataDir: string
  /** `CAMSTACK_PRODUCT_VERSION`, or null when unset. */
  readonly productVersion: string | null
  /** True when an Electron shell hosts the node: it announces its own update. */
  readonly underDesktopShell: boolean
  readonly bus: IEventBus
  readonly sourceId: string
  readonly nodeId: string
  readonly logger: IScopedLogger
  readonly now?: () => number
}

/**
 * At boot: when the container runs a different image than the previous boot,
 * say so as a `node-updating`. The old container is gone before this process
 * exists, so this is the earliest the change can be known. The record is
 * updated either way; under the desktop shell nothing is announced (the shell
 * announces its own install, and its product version moves with it).
 */
export function announceProductVersionChange(input: ProductVersionAnnouncementInput): void {
  const change = detectProductVersionChange(input.dataDir, input.productVersion)
  if (change === null || input.underDesktopShell) return
  input.logger.info('container image changed since the previous boot', {
    meta: { nodeId: input.nodeId, from: change.from, to: change.to },
  })
  emitNodeUpdateAnnouncement(
    input.bus,
    input.sourceId,
    input.nodeId,
    buildNodeUpdateAnnouncement({
      what: 'container-image',
      fromVersion: change.from,
      toVersion: change.to,
      requestedAt: (input.now ?? Date.now)(),
    }),
  )
}
