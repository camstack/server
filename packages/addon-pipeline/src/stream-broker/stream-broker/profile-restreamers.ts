import {
  CAM_PROFILE_ORDER,
  makeProfileBrokerId,
  makeSourceBrokerId,
  type CamProfile,
  type ProfileRtspEntry,
} from '@camstack/types'

export interface ProfileRestreamerRegistration {
  readonly profileBrokerId: string
  readonly camStreamId: string
}

export interface ProfileRestreamerActions {
  readonly register: readonly ProfileRestreamerRegistration[]
  readonly unregister: readonly string[]
}

export interface ProfileRestreamerActionsParams {
  readonly deviceId: number
  readonly assignmentMap: Partial<Record<CamProfile, string>>
  readonly sourceBrokerExists: (camStreamId: string) => boolean
  readonly currentBindings: ReadonlyMap<string, string>
}

/**
 * Diff the desired profile→source aliasing against the current
 * bindings. Pure: the manager supplies `sourceBrokerExists` (does a
 * live `StreamBroker` exist for this camStream?) and the current
 * `profileBrokerId → sourceBrokerId` bindings. Only emits work when a
 * profile's backing source actually changed, so an unchanged read
 * leaves the existing RTSP token (and any in-flight HAP session) alone.
 */
export function computeProfileRestreamerActions(
  params: ProfileRestreamerActionsParams,
): ProfileRestreamerActions {
  const { deviceId, assignmentMap, sourceBrokerExists, currentBindings } = params
  const register: ProfileRestreamerRegistration[] = []
  const unregister: string[] = []
  for (const profile of CAM_PROFILE_ORDER) {
    const profileBrokerId = makeProfileBrokerId(deviceId, profile)
    const currentSource = currentBindings.get(profileBrokerId) ?? null
    const camStreamId = assignmentMap[profile]
    if (camStreamId === undefined) {
      // Unassigned profile — drop any token that was aliasing it.
      if (currentSource !== null) unregister.push(profileBrokerId)
      continue
    }
    // Past this guard `camStreamId` narrows to `string`, so the register
    // push needs no extra defined-check or cast.
    const desiredSource = sourceBrokerExists(camStreamId)
      ? makeSourceBrokerId(deviceId, camStreamId)
      : null
    if (desiredSource === currentSource) continue
    if (currentSource !== null) unregister.push(profileBrokerId)
    if (desiredSource !== null) register.push({ profileBrokerId, camStreamId })
  }
  return { register, unregister }
}

/** Minted restream URL pair for a profile-keyed brokerId. */
export interface ProfileRestreamUrl {
  readonly url: string
  readonly mutedUrl: string
  readonly enabled: boolean
}

/** Source-camStream codec/resolution used to enrich a profile entry. */
export interface ProfileSourceMeta {
  readonly codec?: string
  readonly resolution?: { readonly width: number; readonly height: number }
}

export interface BuildProfileRtspEntriesParams {
  readonly deviceId: number
  readonly assignmentMap: Partial<Record<CamProfile, string>>
  readonly resolveEntry: (profileBrokerId: string) => ProfileRestreamUrl | null
  readonly resolveMeta: (camStreamId: string) => ProfileSourceMeta
}

/**
 * Map a device's assigned profiles → `ProfileRtspEntry[]`. Pure: the
 * manager supplies `resolveEntry` (profileBrokerId → minted restream
 * URL or null) and `resolveMeta` (camStreamId → codec/resolution).
 * Profiles with no assignment or no mintable entry are skipped.
 */
export function buildProfileRtspEntries(params: BuildProfileRtspEntriesParams): ProfileRtspEntry[] {
  const { deviceId, assignmentMap, resolveEntry, resolveMeta } = params
  const result: ProfileRtspEntry[] = []
  for (const profile of CAM_PROFILE_ORDER) {
    const camStreamId = assignmentMap[profile]
    if (camStreamId === undefined) continue
    const profileBrokerId = makeProfileBrokerId(deviceId, profile)
    const entry = resolveEntry(profileBrokerId)
    if (!entry) continue
    const meta = resolveMeta(camStreamId)
    result.push({
      profile,
      brokerId: profileBrokerId,
      url: entry.url,
      mutedUrl: entry.mutedUrl,
      enabled: entry.enabled,
      ...(meta.codec !== undefined ? { codec: meta.codec } : {}),
      ...(meta.resolution !== undefined ? { resolution: meta.resolution } : {}),
    })
  }
  return result
}
