/**
 * The ONE place a `.restart-pending` marker payload is built.
 *
 * ## Why one place
 *
 * The hub (`AddonPackageService.restartServer`) and the agent
 * (`writeAgentRestartMarker`) each had their own copy of the same three rules —
 * how to classify the restart, which package it is about, and which version it
 * targets — and both copies were missing the same fact: `fromVersion`. The
 * marker is the only thing that crosses the reboot, so the operator's "Server
 * aggiornato" notification is exactly as complete as this function.
 *
 * ## The two rules
 *
 * 1. **A restart is a framework update only when a VERSION is known.** The
 *    plain node restart travels under the same `server-update:` prefix
 *    (`RootUpdateService.restartNode` → `server-update: manual restart`), and
 *    labelling it `framework-update` announces an update that never happened.
 * 2. **`fromVersion` comes from the caller or from nowhere.** After the reboot
 *    the process asking IS the new version; the version it replaced exists only
 *    in the {@link RootRestartUpdate} the update engine hands to the restart
 *    seam.
 */
import type { PendingRestartMarkerPayload } from '@camstack/types'
import type { RootRestartUpdate } from '../../server-root/index.js'

/** Reason-string prefix every `RootUpdateService`-driven restart carries. */
const SERVER_UPDATE_PREFIX = 'server-update:'

/** The root package a version-less `server-update:` reason is about. */
const ROOT_PACKAGE_NAME = '@camstack/server'

export interface RestartMarkerInput {
  /** Free-form reason from the caller (`server-update: <pkg>@<version>`, a username, …). */
  readonly requestedBy?: string
  /** Present only for an update-driven restart. */
  readonly update?: RootRestartUpdate
  readonly requestedAt: number
}

export function buildRestartMarker(input: RestartMarkerInput): PendingRestartMarkerPayload {
  const { requestedBy, update, requestedAt } = input
  const toVersion = update?.toVersion ?? versionFromReason(requestedBy)
  const isUpdate =
    update !== undefined || (isServerUpdateReason(requestedBy) && toVersion !== undefined)
  if (!isUpdate) {
    return {
      kind: 'manual',
      requestedAt,
      ...(requestedBy !== undefined ? { requestedBy } : {}),
    }
  }
  return {
    kind: 'framework-update',
    requestedAt,
    ...(requestedBy !== undefined ? { requestedBy } : {}),
    packageName: update?.packageName ?? ROOT_PACKAGE_NAME,
    ...(update?.fromVersion !== undefined ? { fromVersion: update.fromVersion } : {}),
    ...(toVersion !== undefined ? { toVersion } : {}),
  }
}

export function isServerUpdateReason(requestedBy: string | undefined): boolean {
  return requestedBy !== undefined && requestedBy.startsWith(SERVER_UPDATE_PREFIX)
}

/** `server-update: @camstack/server@1.2.138` → `1.2.138`; `… manual restart` → none. */
export function versionFromReason(requestedBy: string | undefined): string | undefined {
  if (requestedBy === undefined) return undefined
  return /@([^@\s]+)$/.exec(requestedBy)?.[1]
}
