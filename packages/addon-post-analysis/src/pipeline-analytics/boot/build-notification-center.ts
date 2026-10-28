/**
 * Notification centre construction. Moved out of `pipeline-analytics/index.ts`
 * verbatim (Plan B, boot extraction): only the visibility of the entry point
 * changed. Every dependency is read through the deps object.
 */

import type { CameraOccupancySnapshot, IScopedLogger, TargetKind } from '@camstack/types'
import {
  errMsg,
  isDeviceScopedCap,
  kebabToCamel,
  readDeviceStateFrom,
  viewerLinkBaseOf,
} from '@camstack/types'
import { readAlarmOpenings } from '../../notification-center/alarm/alarm-openings.js'
import {
  createDisplayPalettePainter,
  readDisplayPalette,
} from '../../shared/display-palette-painter.js'
import { pickArtifactBaseUrl } from '../../notification-center/artifact-url.js'
import type {
  NcEventMediaRequest,
  NcSendInput,
  NcTargetRef,
} from '../../notification-center/dispatcher.js'
import { NotificationCenter } from '../../notification-center/index.js'
import { buildRecordedGifPorts, deriveRecordedGif } from '../../notification-center/recorded-gif.js'
import {
  NC_TRACKS_AT_INSTANT_LIMIT,
  tracksAtInstant,
} from '../../notification-center/tracks-at-instant.js'
import { makeNcOwnerMediaReader } from '../nc-owner-media-reader.js'
import { buildOccupancyDepartureDeps } from '../occupancy-departure-deps.js'
import { FACE_SETTLE_HOLD_MS } from '../pipeline/tracker-v2/constants.js'
import { retrainRefusalReason } from '../pipeline/track-flags.js'
import { recognitionOutlook } from '../recognition-outlook.js'
import { buildLinkedSnapshotReads } from '../runtime/linked-snapshot-reads.js'
import { resolveMediaOwnerId } from '../track-alias-resolution.js'
import type { AnalyticsApi, AnalyticsStores } from './boot-types.js'
import { isCapCall, isCapNode } from './boot-types.js'

import { BuildNotificationCenterBase } from './build-notification-center-deps.js'

export class BuildNotificationCenter extends BuildNotificationCenterBase {
  /** Construct + start the Notification Center module (extractable —
   *  every collaborator is an injected closure over ctx.api / the stores;
   *  see `../notification-center/index.ts`). Dispatch goes through the
   *  `notification-output` cap routed by the target's `addonId`; media
   *  attachments resolve from the media store BY OWNER at send time. */
  async buildNotificationCenter(
    api: AnalyticsApi,
    logger: IScopedLogger,
    stores: AnalyticsStores,
  ): Promise<void> {
    // Device display names + location labels for templating and the digest AI
    // roster — ONE TTL-cached listAll projection feeding both maps.
    //
    // `slim`, and it matters far more than the fields suggest: `name` and
    // `location` are COLUMNS of the device row, but the full projection makes
    // `device-queries.ts#listAll` materialise `config` too, with one sequential
    // `readDeviceStore` per row. On this hub that was 967 per-device settings
    // reads a minute, forever, to build a map of 967 strings.
    let deviceFactsAt = 0
    let deviceNames = new Map<number, string>()
    // Only cameras the operator gave a location — absent entry means "none".
    let deviceLocations = new Map<number, string>()
    const refreshDeviceFacts = async (): Promise<void> => {
      if (Date.now() - deviceFactsAt <= 60_000) return
      const all = await api.deviceManager.listAll.query({
        projection: 'slim',
      })
      deviceNames = new Map(all.map((d) => [d.id, d.name]))
      deviceLocations = new Map(
        all.flatMap((d) => (d.location !== null ? [[d.id, d.location] as const] : [])),
      )
      deviceFactsAt = Date.now()
    }
    const getDeviceName = async (deviceId: number): Promise<string | null> => {
      await refreshDeviceFacts()
      return deviceNames.get(deviceId) ?? null
    }
    const getDeviceLocation = async (deviceId: number): Promise<string | null> => {
      await refreshDeviceFacts()
      return deviceLocations.get(deviceId) ?? null
    }
    const deviceSettings = this.ctxIfReady?.settings
    if (deviceSettings === undefined) {
      throw new Error('notification centre: the addon has no per-device settings')
    }
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('notification centre: ctx.records is required')
    }
    this.notificationCenter = new NotificationCenter({
      pruneWindows: () => this.pruneWindows(),
      records,
      deviceSettings,
      logger: logger.child('NotificationCenter'),
      // Phase 4 rule→user fan-out: user grants + the device's routing identity
      // for the allowedDevices check.
      listUsers: async () => {
        const users = await api.userManagement.listUsers.query()
        return users.map((u) => ({
          id: u.id,
          isAdmin: u.isAdmin,
          allowedDevices: u.allowedDevices,
        }))
      },
      getDeviceRoute: async (deviceId: number) => {
        const device = await api.deviceManager.getDevice.query({ deviceId })
        return device === null ? null : { stableId: device.stableId, addonId: device.addonId }
      },
      // The save-time device-compatibility guard's ONE capability read
      // (`device-compat-guard.ts`, operator ruling 2026-10-01) — which ids
      // carry ANY of the asked caps, never a hard-coded device list.
      listDeviceIdsByCaps: (capNames) =>
        api.deviceManager.listDeviceIdsByCaps.query({ capNames: [...capNames] }),
      // The deleted-device prune's second read. `getDevice` falls back to the
      // persisted row, so `null` means the row is DELETED — a respawning or
      // offline device still answers. A throw propagates, and the prune reads
      // a throw as "not confirmed".
      isDeviceDeleted: async (deviceId: number) =>
        (await api.deviceManager.getDevice.query({ deviceId })) === null,
      // The state summary's node reconcile (D647 review I2): the cheap node
      // list — registry plus durable history, never `nodes.topology` (D315).
      readNodeDirectory: () => api.nodes.directory.query(),
      // The state summary's recovery read for crash-looped runners (D708): a
      // core block re-enabled or updated emits no `addon.started`, so its
      // crash-loop state is closed by the owner's own status, read per summary.
      readRunnerStates: {
        coreBlocks: async () => (await api.coreBlocks.list.query({})).blocks,
        nodeAddons: (nodeId: string) => api.nodes.getNodeAddons.query({ nodeId }),
      },
      // The alert centre sends nothing of its own: an open critical/error alert
      // reaches the operator through a system-event rule, and this read is the
      // reconcile that covers a dropped `alert.episode` announcement (D11).
      readAlerts: () => api.alerts.list.query({ limit: 5000 }),
      emitBusEvent: (event) => this.ctx.eventBus.emit(event),
      // The picture for a subject that is an ABSENCE. A confirmed audio match
      // owns no frame, and an occupancy edge that emptied its scope owns no
      // member, so the centre photographs the camera at the trigger and holds
      // the bytes on its own still shelf (`still-shelf.ts`). Deliberately
      // WITHOUT `force`: the cap defines that as the operator's refresh button,
      // and nobody pressed anything here — a sound happened, or a space freed.
      getSnapshot: (deviceId: number) => api.snapshot.getSnapshot.query({ deviceId }),
      // D691: the early look at a pending flip's sustain end (dialled by the
      // orchestrator — an addon-to-addon call, no hub router involved), and a
      // DEPARTURE's frame at the moment it happened: the clip ring first, the
      // recordings when the ring has lost it, decoded on the PINNED ffmpeg
      // (D540). Never a live frame of the empty space. Built by a named,
      // tested builder (`occupancy-departure-deps.ts`).
      // D683 × D691: a departed track the L2 fusion absorbed is read through
      // the alias store before its departure falls back to the ring still.
      // D692 §4: the grouped-window outlook — the camera's announced detail steps and
      // the face recogniser's first face, against the tracker's own face-settle cap.
      recognitionOutlook: ({ deviceId, trackId, className, labelKind, now }) =>
        recognitionOutlook({
          className,
          ...(labelKind !== undefined ? { labelKind } : {}),
          detailSteps: this.frameState.detailStepsByDevice.get(deviceId),
          faceRecognizerWired: this.faceRecognizer !== null,
          firstFaceAt: this.faceRecognizer?.firstFaceAt(trackId),
          now,
          faceSettleHoldMs: FACE_SETTLE_HOLD_MS,
        }),
      resolveTrackAlias: (trackId: string) =>
        this.trackAliasStore?.resolve(trackId) ?? Promise.resolve(null),
      // D692 (fresh review L-1): the alias store's RAM read, asked first by a grouped
      // admission so a late event under an absorbed id resolves without an await.
      resolveTrackAliasSync: (trackId: string) => this.trackAliasStore?.resolveSync(trackId),
      ...buildOccupancyDepartureDeps({
        requestOccupancyLook: (ask) => api.pipelineOrchestrator.requestOccupancyLook.mutate(ask),
        // Spread: the cap input carries an index signature (no cast needed).
        renderPreBufferClip: (input) => api.streamBroker.renderPreBufferClip.mutate({ ...input }),
        cutRecordedClip: (req) => this.cutNotificationRecordedClip(req),
        derive: buildRecordedGifPorts({
          logger: logger.child('RingStill'),
          resolveFfmpeg: () => this.ctx.deps.ensureFfmpeg(),
        }),
        now: () => Date.now(),
      }),
      // Capture-free and cache-only reads of the snapshot wrapper, for the
      // linked-camera shelf (ADR 0632): which cameras must not be dialled, and
      // how old the frame a capture returned really is.
      ...buildLinkedSnapshotReads(api.snapshot),
      // DISPLAY NAME → GALLERY ID, for the lazy migration of rules authored
      // before an identity condition meant an id. Both galleries feed one map:
      // `identities` and `plates` are the same question asked of a person and
      // of a vehicle, and a rule names one or the other, never both under the
      // same word. Read on the rule-store reload tick, and a failure returns an
      // empty map, which migrates nothing — see `migrateIdentityNames`.
      identityIdsByName: async () => {
        const byName = new Map<string, string>()
        const identities = await stores.identityStore.listIdentities()
        for (const identity of identities) {
          byName.set(identity.name.trim().toLowerCase(), identity.id)
        }
        const vehicles = await stores.vehicleStore.listVehicles()
        for (const vehicle of vehicles) byName.set(vehicle.name.trim().toLowerCase(), vehicle.id)
        return byName
      },
      // WHO each device id is, for the system-event intake: it decides whether
      // a `device.offline` is a CAMERA offline at all, and it names it. `slim`
      // because the directory needs identity only — id, name, type, isCamera —
      // and shipping 293 configs every reload tick to read four fields is the
      // projection this flag exists for.
      // The three cluster settings behind the battery band and the all-clear.
      // Synchronous by contract — it reads a mirror this addon refreshes off
      // the event path, never the store.
      readDeviceAlertSettings: () => ({
        batteryLowPercent: this.deviceAlertSettingsMirror.batteryLowPercent,
        renotifyMinutes: this.deviceAlertSettingsMirror.alertRenotifyMinutes,
        notifyRecovery: this.deviceAlertSettingsMirror.alertNotifyRecovery,
      }),
      listDeviceIdentities: async () => {
        const all = await api.deviceManager.listAll.query({
          projection: 'slim',
        })
        // WHICH devices still have detection running — the authority is the
        // presence of a WRAPPED `detection-pipeline` binding, never a flag
        // (D62: absence IS how a deactivated wrapper is represented). This USED
        // to be a fleet-wide `getAllBindings` on EVERY 30 s reload tick (903 ms
        // / 373 KB / ~505 skip-log lines on 524 devices, forever). It now reads
        // an event-invalidated mirror seeded ONCE and kept fresh per-device by
        // `DeviceBindingsChanged` — the same fix as SystemMirror (639073e8). A
        // cold or still-warming mirror answers UNKNOWN for every id, and
        // unknown never reports a camera as excluded from coverage.
        const coverage = this.detectionCoverage
        if (coverage) await coverage.ensureWarm()
        return all.map((d) => ({
          deviceId: d.id,
          type: d.type,
          name: d.name,
          isCamera: d.isCamera,
          // LIVENESS IS A FIRST-LEVEL DEVICE FACT. `slim` already carries this,
          // and without it every accessory on the hub is indistinguishable from
          // a camera: 96 of the 100 devices reading offline on 2026-09-01 were
          // children of a device that was itself online.
          parentDeviceId: d.parentDeviceId ?? null,
          // D706: the alarm's intrusion title names WHERE — the device's location label.
          location: d.location ?? null,
          // A device the operator SWITCHED OFF reads as offline to the alarm's
          // coverage answer, because it is: nothing about it is running. D62
          // governs how it is WORDED, and no alarm sentence calls it broken.
          online: d.online && !d.disabled,
          ...(coverage?.has(d.id) ? { detectionActive: coverage.get(d.id) === true } : {}),
        }))
      },
      // WHICH ZONES each camera owns, so a multi-camera rule can scope its
      // `zones` condition to the camera the operator drew each polygon on.
      // Mirror-first through `DeviceZoneResolver` — the same resolver (and the
      // same 102 hydration fallback) every occupancy path reads, so the two can
      // never disagree about a camera's catalogue.
      //
      // The failure policies differ on purpose, and this is the seam: the
      // resolver's is "never lose zones" (a read that threw keeps the last
      // catalogue, and can answer `[]`), the notification centre's is "never
      // invent an absence" — an empty answer from the resolver is confirmed
      // against the capability, and a THROW leaves the camera absent from the
      // map, which reads as "unknown" and keeps the flat, unscoped verdict.
      readDeviceZoneIds: async (ids) => {
        const out = new Map<number, readonly string[]>()
        for (const deviceId of ids) {
          try {
            const mirrored = await this.deviceZones.resolve(deviceId)
            if (mirrored.length > 0) {
              out.set(
                deviceId,
                mirrored.map((zone) => zone.id),
              )
              continue
            }
            // Empty is the answer that MATTERS (it makes a rule's zones inert
            // for this camera), so it is taken from the authority itself.
            const authoritative = await api.zones.listZones.query({ deviceId })
            out.set(
              deviceId,
              authoritative.map((zone) => zone.id),
            )
          } catch (err) {
            // Absent, never empty — see the comment above. Logged because a
            // camera silently keeping the old, camera-blind verdict is exactly
            // the failure mode this scoping exists to end.
            this.ctx.logger.debug('zone ownership read failed', {
              tags: { deviceId },
              meta: { error: errMsg(err) },
            })
          }
        }
        return out
      },
      // The `deviceState` rule gate. `loadRuntimeState` returns every cap's
      // slice for a device, keyed by cap name; `readDeviceStateFrom` collapses
      // that to the one word a rule compares against, via a declared table.
      //
      // One read per WATCHED device per reload tick, not per event — the gate
      // itself reads the cache with no I/O. A device that cannot be read is
      // simply absent from the map, never present with a stale value, because
      // the cache treats absence as "unknown" and unknown never arms a rule.
      // The transport behind a rule's actions. `ctx.api` is the generated
      // tRPC-shaped proxy, so a cap method is `api[camelCase(cap)][method]`.
      // The BOUNDARY is not here — the runner refuses a non-device cap before
      // this is ever called — but a bad name still has to fail loudly rather
      // than silently resolve to undefined.
      actuate: async ({ deviceId, cap, method, args }) => {
        const router: unknown = Reflect.get(api, kebabToCamel(cap))
        if (!isCapNode(router)) {
          throw new Error(`rule action: no router for capability "${cap}"`)
        }
        const proc: unknown = Reflect.get(router, method)
        const mutate = isCapNode(proc) ? Reflect.get(proc, 'mutate') : undefined
        const query = isCapNode(proc) ? Reflect.get(proc, 'query') : undefined
        const fn = isCapCall(mutate) ? mutate : isCapCall(query) ? query : undefined
        if (fn === undefined) {
          throw new Error(`rule action: "${cap}.${method}" is not a callable cap method`)
        }
        await fn({ deviceId, ...args })
      },
      isCapDeviceScoped: isDeviceScopedCap,
      // AI CONFIRM — `llm.generateVision`, through `ctx.api` like every other
      // cross-addon call. The centre constructs no gate when this is absent,
      // and a `no-profile` answer is a NORMAL result here rather than an
      // exception: the gate turns it into a counted fail-open.
      generateVision: async (request) => {
        const result = await api.llm.generateVision.mutate({
          ...(request.profileId !== undefined ? { profileId: request.profileId } : {}),
          requestId: request.requestId,
          consumer: request.consumer,
          system: request.system,
          prompt: request.prompt,
          images: request.images.map((i) => ({
            bytes: i.bytes,
            mimeType: i.mimeType,
          })),
          jsonSchema: request.jsonSchema,
          temperature: request.temperature,
          // The caller's bound must reach the provider. Dropping it here left
          // every AI call on `profile.timeoutMs` (60 s) however patient the
          // caller was — the reason digests shipped without their text.
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        })
        return result.ok
          ? { ok: true, text: result.text, model: result.model }
          : { ok: false, code: result.code, message: result.message }
      },
      // The 8 s gate frees its slot on a timeout; this is what also frees the
      // GENERATION. Without it the bound counts waits, not work.
      cancelVision: async (requestId) => {
        await api.llm.cancel.mutate({ requestId })
      },
      // The cap's `resolveArtifactUrl` — one derivation, the SAME plane the
      // dispatcher publishes through (`dispatcher.indexArtifact` below).
      // `null` on a node that never served the plane, exactly like every
      // other artefact dep here.
      resolveArtifactUrl: async (artifactId) =>
        (await this.ncArtifactPlane?.mintUrl(artifactId)) ?? null,
      // Null until the action plane is served, and null forever on an install
      // with no reachable public address — either way, no buttons rather than
      // a button that cannot work.
      mintActionUrl: (input) => this.ncActionMintUrl?.(input) ?? Promise.resolve(null),
      // The "apply these updates" button's two doors into the hub's addon
      // registry. Both go out over `ctx.api`, which for a CORE router from a
      // forked addon travels the `$core-caps` mesh bridge and arrives as admin
      // (docs/architecture/transport.md) — this addon is forked, so nothing
      // here may assume a hub-local service.
      //
      // `listUpdates` is asked FIRST and its answer is the work set: the frozen
      // row says what was out of date six hours ago, this says what still is.
      // Framework rows are dropped — they are announced as
      // `server-update-available`, which mints its own button (D325), and
      // `updatePackage` refuses them anyway.
      listAddonUpdates: async (nodeId) => {
        const updates = await this.ctx.api.addons.listUpdates.query({ nodeId })
        return updates.filter((update) => !update.isSystem).map((update) => update.name)
      },
      // NO version, in either direction. Passing one would pin an observation
      // the registry may have moved past; reading the answer's `version` back
      // would hand an operator the string the cap was ASKED for
      // (`input.version ?? 'latest'`), which is the sentence D313 exists to
      // stop. What landed is read back once, by the lifecycle engine, and
      // arrives as the `addon.updated` notification.
      applyAddonUpdate: async ({ packageName, nodeId }) => {
        try {
          await this.ctx.api.addons.updatePackage.mutate({
            name: packageName,
            nodeId,
          })
          return { ok: true as const }
        } catch (err: unknown) {
          return { ok: false as const, error: errMsg(err) }
        }
      },
      // The "apply this server update" button's two doors into
      // `server-management`. Same mesh-bridge as the addon pair above: this
      // addon is forked, so nothing here may assume a hub-local service.
      //
      // `checkServerUpdate` is asked FIRST and its `updateAvailable` boolean
      // is the whole answer — versions on that payload are observations, and
      // restating them is D313. A registry `error` is a throw, never "already
      // current". `applyServerUpdate` omits `version` so the provider resolves
      // latest at apply time. The hub dies in apply; the start announcement
      // has already left.
      checkServerUpdate: async (nodeId) => {
        const result = await this.ctx.api.serverManagement.checkServerUpdate.mutate({
          nodeId,
        })
        if (result.error) throw new Error(result.error)
        return result.updateAvailable
      },
      applyServerUpdate: async ({ nodeId }) => {
        try {
          const result = await this.ctx.api.serverManagement.applyServerUpdate.mutate({
            nodeId,
          })
          if (!result.accepted) return { ok: false as const, error: result.message }
          return { ok: true as const }
        } catch (err: unknown) {
          return { ok: false as const, error: errMsg(err) }
        }
      },
      // The Correct / Wrong buttons' one door into the retrain lifecycle: the
      // very mark the Library writes. The lifecycle's deliberate refusals come
      // back as NAMED reasons (the tap page says why), anything else throws.
      markTrackForRetrain: async ({ deviceId, trackId }) => {
        try {
          await this.ctx.api.pipelineAnalytics.setTrackFlags.mutate({
            deviceId,
            trackId,
            flags: { markForTrain: true },
          })
          return { ok: true as const }
        } catch (err: unknown) {
          const reason = retrainRefusalReason(err)
          if (reason === null) throw err
          return { ok: false as const, reason }
        }
      },
      readDeviceStates: async (ids) => {
        const out = new Map<number, string>()
        for (const id of ids) {
          try {
            const runtime = await api.deviceManager.loadRuntimeState.query({
              deviceId: id,
            })
            const state = readDeviceStateFrom(runtime)
            if (state !== undefined) out.set(id, state)
          } catch (err) {
            // Leave it absent — a failed read must never look like a state.
            this.ctx.logger.debug('device-state read failed', {
              tags: { deviceId: id },
              meta: { error: String(err) },
            })
          }
        }
        return out
      },
      // The alarm's openings (D630): read from the RAW slices, because the
      // collapsed word cannot say whether a device is an opening at all. The
      // contract (absent = the read failed) lives with `readAlarmOpenings`.
      readDeviceOpenings: (ids) =>
        readAlarmOpenings(
          ids,
          (deviceId) => api.deviceManager.loadRuntimeState.query({ deviceId }),
          this.ctx.logger,
        ),
      // The `scene` rule gate's reconcile half. Read LAZILY off the provider —
      // it is built AFTER the centre, so this closure is the only shape that
      // can work at all, and it answers an empty list until then (a cold mirror
      // gates everything shut, which is the safe direction).
      //
      // Synchronous, and that is not an accident: the provider lives in THIS
      // process, so there is no RPC, no timer and nothing to drop. The gate's
      // freshness comes from the edge tap; this is the reconcile that catches a
      // scene created, edited, reset or deleted anywhere else (D8 —
      // reconcile-over-events).
      readSceneStates: () =>
        (this.sceneProvider?.listAllEnabled() ?? []).map(({ deviceId, monitor }) => ({
          sceneId: monitor.id,
          deviceId,
          label: monitor.label,
          verdict: monitor.verdict,
          latched: monitor.latched,
          emit: monitor.emit,
        })),
      // The rule tester's occupancy probe. Read LAZILY off the provider (built
      // before the centre, but held on `this`), and honest about its two empty
      // answers: no provider on this node ⇒ an empty map, a camera with no
      // frame ⇒ absent from the map. Both land as a REPORTED fail-closed row in
      // the tester rather than as an empty result list.
      readOccupancySnapshots: async (deviceIds) => {
        const za = this.zoneAnalytics
        if (za === null) return new Map()
        const ids = deviceIds ?? za.deviceIdsWithSnapshot()
        const out = new Map<number, CameraOccupancySnapshot>()
        for (const deviceId of ids) {
          try {
            const snapshot = await za.getCurrentSnapshot({ deviceId })
            if (snapshot !== null) out.set(deviceId, snapshot)
          } catch (err) {
            // A camera that cannot be read is ABSENT, never present with a
            // stale reading — the same contract `readDeviceStates` follows.
            this.ctx.logger.debug('occupancy snapshot read failed', {
              tags: { deviceId },
              meta: { error: String(err) },
            })
          }
        }
        return out
      },
      dispatcher: {
        // Rendering-only zone-name lookup: `subject.zones` carries IDs (what
        // the conditions match on), and a body full of UUIDs is what an
        // operator actually received on 2026-07-30.
        getZoneNames: async (deviceId: number) => {
          const zones = await api.zones.listZones.query({ deviceId })
          return zones.map((z) => ({ id: z.id, name: z.name }))
        },
        getZonePolygons: async (deviceId: number, zoneIds: readonly string[]) => {
          const zones = await api.zones.listZones.query({ deviceId })
          const wanted = new Set(zoneIds)
          return zones
            .filter((z) => wanted.has(z.id) && Array.isArray(z.polygon))
            .map((z) => (z.polygon ?? []).map((pt) => ({ x: pt.x, y: pt.y })))
        },
        paintClass: createDisplayPalettePainter(
          () => readDisplayPalette(api),
          logger.child('DisplayPalette'),
        ).paint,
        renderEventMedia: (req: NcEventMediaRequest) => this.renderEventMedia(req),
        // Cut an OLD moment from the recordings, because the pre-buffer cannot
        // reach it. A departure is confirmed by an independent read that lands
        // minutes later (D279; 6-10 minutes measured on 102), while the clip
        // ring holds 25 seconds — so an honestly-anchored clip is routinely
        // older than any footage the ring has. `recording-export` is the ONE
        // way this repo cuts recorded video (D435: the cheapest band that
        // actually covers the window, chosen by the same `pickProfile` the
        // timelapse renderer uses); nothing here renders anything itself.
        cutRecordedClip: (req) => this.cutNotificationRecordedClip(req),
        // The gif for a moment only the recordings hold (D682): derived from the
        // recorded cut's own bytes with the broker's filter chain, on the
        // PINNED ffmpeg (D540). A package pick-up is concluded five minutes
        // after it happened, so its gif is always one of these.
        deriveGifFromClip: (req) =>
          deriveRecordedGif(
            buildRecordedGifPorts({
              logger: logger.child('RecordedGif'),
              resolveFfmpeg: () => this.ctx.deps.ensureFfmpeg(),
            }),
            req,
          ),
        publishArtifact: async (bytes: Uint8Array, mime: string, deviceId: number | null) =>
          (await this.ncArtifactPlane?.publish(bytes, mime, deviceId)) ?? null,
        // The public endpoint: the SAME resolver the artifact and action
        // planes use — one ladder, or the planes mint links on different
        // hosts for the same notification. A system event's admin tap uses it.
        publicUrlBase: async () => pickArtifactBaseUrl(await this.ncEndpoints()),
        // Where a camera tap opens (D709, D734): the `notificationTaps` role —
        // the CamStack app link carrying the hub as `hub=` (the default), or
        // the hub address flagged for taps. Set on the admin Network page.
        tapBase: async () =>
          viewerLinkBaseOf(await this.ctx.api.localNetwork.getNotificationEndpoint.query()),
        indexArtifact: async (bytes, mime, meta) =>
          (await this.ncArtifactPlane?.publishIndexed(bytes, mime, meta)) ?? {
            url: null,
            artifactId: null,
          },
        listTargets: async (): Promise<readonly NcTargetRef[]> => {
          const targets = await api.notificationOutput.listTargets.query({})
          // The KIND catalog, alongside the targets and on the same TTL (the
          // dispatcher caches the answer whole). It carries `caps.bodyMaxLen`,
          // which is the ONLY thing a kind declares about how much text it can
          // take — the number the degrade engine truncates on, and therefore
          // the only honest source for the AI narration's default word cap.
          // A catalog that throws costs the DEFAULT, never the targets: an
          // absent budget reads as unknown and falls back to a push-shaped cap.
          const kinds = await api.notificationOutput.listTargetKinds
            .query({})
            .catch((): readonly TargetKind[] => [])
          const bodyMaxLenByKind = new Map(kinds.map((k) => [k.kind, k.caps.bodyMaxLen]))
          // The button budget of each kind: 0 means the verdict choices travel
          // as links in the body, not as buttons.
          const maxActionsByKind = new Map(kinds.map((k) => [k.kind, k.caps.actions]))
          // What each kind lets a rule set at send time (D938).
          const deliveryParamsByKind = new Map(kinds.map((k) => [k.kind, k.deliveryParams]))
          return targets.map((t) => {
            // Personal-target owner rides INSIDE the open config blob (the
            // nc.upsertMyTarget convention) — surfaced for rule→user fan-out.
            const owner = (t.config as Record<string, unknown>)['ownerUserId']
            const bodyMaxLen = bodyMaxLenByKind.get(t.kind)
            const maxActions = maxActionsByKind.get(t.kind)
            const deliveryParams = deliveryParamsByKind.get(t.kind)
            return {
              id: t.id,
              addonId: t.addonId,
              name: t.name,
              kind: t.kind,
              enabled: t.enabled,
              ...(typeof owner === 'string' && owner.length > 0 ? { ownerUserId: owner } : {}),
              ...(typeof bodyMaxLen === 'number' ? { bodyMaxLen } : {}),
              ...(typeof maxActions === 'number' ? { maxActions } : {}),
              ...(deliveryParams !== undefined && deliveryParams.length > 0
                ? { deliveryParams }
                : {}),
            }
          })
        },
        // `addonId` is threaded top-level so the collection router routes
        // the send to the ONE provider owning the target (same convention
        // as the admin-ui test panel).
        send: async (input: NcSendInput) => {
          // `attachments` and `actions` are copied out of their readonly types:
          // the cap's Zod-inferred input wants mutable arrays, and spreading is
          // the whole conversion.
          const { attachments, actions, ...notification } = input.notification
          return api.notificationOutput.send.mutate({
            addonId: input.addonId,
            targetId: input.targetId,
            notification: {
              ...notification,
              ...(attachments !== undefined ? { attachments: [...attachments] } : {}),
              ...(actions !== undefined ? { actions: [...actions] } : {}),
            },
          })
        },
        // D683 Task 18 review M4: this is an IN-PROCESS read (never crosses a
        // cap boundary, so `resolvingTrackIds` does not cover it) — a
        // delivery that resolves after a fusion re-point (recognition wait,
        // outbox retry, AI narration) must still reach the survivor's scene
        // stills, not an absorbed id that now owns nothing.
        // D694: an `object` owner is a reusable rowid — the reader narrows it
        // to the event's generation (camera + the event's own timestamp).
        getMediaForOwner: makeNcOwnerMediaReader({
          media: stores.mediaStore,
          resolveTrackOwnerId: (trackId) =>
            resolveMediaOwnerId(
              'track',
              trackId,
              (id) => this.trackAliasStore?.resolve(id) ?? Promise.resolve(null),
              // Review H2: a failed lookup falls back to `ownerId` as asked,
              // reported once via the shared sampled WARN, never thrown.
              (failure) => this.aliasResolveFailureLogger?.(failure),
              'getMediaForOwner',
            ),
          logger: this.ctx.logger.child('nc-media'),
        }),
        // Where the subject was, NORMALIZED — so the notification's still can be
        // narrowed to the zone that fired the rule without the dispatcher ever
        // learning a frame's dimensions. Live first: a dispatch happens ~7 s
        // after the trigger, while the track is still open and NOT yet
        // persisted, so `getPersistedByTrackId` alone would answer "no trail"
        // for exactly the rows this exists for.
        //
        // Dimensions we do not have make the answer a GUESS, and a guess here
        // silently drops the right frame — so an unknown-dims device returns an
        // empty trail and the plain ladder runs, unchanged.
        getSubjectTrail: async (deviceId: number, trackId: string) => {
          const dims = this.frameState.lastFrameDimsByDevice.get(deviceId)
          if (dims === undefined || dims.w <= 0 || dims.h <= 0) return []
          const track =
            stores.trackStore.getActiveByTrack(trackId) ??
            (await stores.trackStore.getPersistedByTrackId(trackId))
          if (track === null || track === undefined) return []
          return track.positions.map((p) => ({
            timestamp: p.timestamp,
            bbox: {
              x: p.bbox.x / dims.w,
              y: p.bbox.y / dims.h,
              w: p.bbox.w / dims.w,
              h: p.bbox.h / dims.h,
            },
          }))
        },
        // Every OTHER track on the camera at the picture's instant, with its box
        // AT that instant (D897 `scene-boxes`). Live tracks first (a dispatch
        // happens while the track is still open), then the persisted rows whose
        // life spans the instant; `tracksAtInstant` dedups and normalises.
        getTracksAt: async (deviceId: number, timestamp: number, toleranceMs: number) => {
          const live = stores.trackStore.getActive(deviceId)
          const persisted = await stores.trackStore.queryRecent({
            deviceIds: [deviceId],
            since: timestamp - toleranceMs,
            limit: NC_TRACKS_AT_INSTANT_LIMIT,
          })
          return tracksAtInstant(
            [...live, ...persisted.tracks],
            timestamp,
            toleranceMs,
            this.frameState.lastFrameDimsByDevice.get(deviceId),
            // A candidate the gate refuses is a branch that drops work: say so.
            (drop) =>
              this.ctx.logger.info('scene-boxes: other track not drawn', {
                tags: { deviceId },
                meta: {
                  trackId: drop.trackId,
                  className: drop.className,
                  reason: drop.reason,
                  instant: timestamp,
                  ...(drop.nearestDtMs !== undefined ? { nearestDtMs: drop.nearestDtMs } : {}),
                },
              }),
          )
        },
        getDeviceName,
        // WHERE each camera is (operator-authored `DeviceInfo.location`) — the
        // AI passes' per-still location label, digest and ordinary rules
        // alike. Same TTL device-facts cache as the names, never a second one.
        getDeviceLocation,
        // Per-delivery tap-through buttons. The center owns the grants; the
        // dispatcher only knows it has some strings to attach.
        buildActions: (input) => this.notificationCenter?.mintButtons(input) ?? Promise.resolve([]),
      },
      listObjectEventsSince: (since, limit) => stores.eventStore.queryObjectSince({ since, limit }),
      listRecentTracks: async (since, limit) => {
        const deviceIds = await stores.trackStore.listDeviceIds()
        const page = await stores.trackStore.queryRecent({
          deviceIds,
          since,
          limit,
          projection: 'slim',
        })
        return page.tracks
      },
      // The POST-HOC timelapse producer's outside world. Hub-only: the export
      // engine, the footage index and the track history are all reachable from
      // here, and rule CRUD is already hub-authoritative.
      ...(this.isPostProcessingNode ? { timelapse: this.buildTimelapsePorts(api, stores) } : {}),
      // The multi-camera DIGEST producer's outside world. Hub-only for the same
      // reason as the timelapse: the track store and the media store it reads
      // are the hub's own, in-process, so no frame ever crosses a boundary.
      ...(this.isPostProcessingNode ? { summary: this.buildSummaryPorts(api, stores) } : {}),
      ...(this.isPostProcessingNode
        ? {
            calendars: {
              listCalendars: async () => {
                const list = await api.calendars.listCalendars.query()
                return list.map((c) => ({ id: c.id }))
              },
              listEvents: async (input: {
                readonly calendarIds: readonly string[]
                readonly startMs: number
                readonly endMs: number
              }) =>
                api.calendars.listEvents.query({
                  calendarIds: [...input.calendarIds],
                  startMs: input.startMs,
                  endMs: input.endMs,
                }),
            },
          }
        : {}),
    })
    // Both halves exist now — see `wireAlarmPanel`.
    this.wireAlarmPanel(this.notificationCenter)
    // AFTER the center exists: the plane claims against its registry and runs
    // its sequences, so there is nothing to serve until it does.
    await this.serveNcActionPlane(this.notificationCenter)
    await this.notificationCenter.start({
      evaluation: this.isPostProcessingNode,
    })
  }
}
