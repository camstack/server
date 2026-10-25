/**
 * `DeviceConfigContributions` — the device-details aggregator contribution
 * surface (C13 remnant, S11 Task 1).
 *
 * Owns nothing durable — every read/write goes through the injected
 * {@link DeviceConfigContributionsDeps} closures. Contributes the pipeline
 * routing / motion / zones settings tab (`getDeviceSettingsContribution`),
 * the live-assignment status block (`getDeviceLiveContribution`), and the
 * save path for both device-scoped (`applyDeviceSettingsPatch`) and
 * addon-scoped (`updateGlobalSettings`) settings.
 *
 * Extracted verbatim from `index.ts` — every method body, log message, and
 * control-flow branch is unchanged; only `this.<field/method>` accesses
 * become `this.deps.<accessor>`. `ctx` is injected as a closure onto the
 * REAL (throwing) `BaseAddon` getter — `this.deps.ctx()` throws exactly
 * like the original `this.ctx` access would (same getter, same message),
 * mirroring `PlacementServiceDeps.ctx` (S8 extraction). `isCameraDevice`'s
 * original body read `this.ctx?.api` — that optional-chain was already a
 * no-op (`this.ctx` is a throwing getter, not a nullable value; `?.` only
 * guards the property access AFTER it), so `this.deps.ctx().api` is
 * byte-identical behavior, just without the vestigial `?.`.
 *
 * `updateGlobalSettings`'s re-derive-and-propagate step (failoverPolicy +
 * clusterRoles, via `deriveRuntimeSettings` inside the addon's private
 * `applyRuntimeSettings`) is preserved by injecting `applyRuntimeSettings`
 * itself as a single closure (`(config) => this.applyRuntimeSettings(config)`)
 * rather than re-implementing its derivation here — `applyRuntimeSettings`
 * ALSO runs during `onInitialize` (so it can't be moved into this stateless
 * controller) and ALSO calls `this.reconcile!.schedulePendingRetry()` as
 * part of the same derive step; re-implementing only the "derive + push"
 * half here would silently drop that pending-retry side effect. Likewise
 * `super.updateGlobalSettings(patch)` (the `BaseAddon` two-level settings
 * write) is injected as `baseUpdateGlobalSettings` — a class that doesn't
 * extend `BaseAddon` can't spell `super` itself.
 */
import type {
  AddonContext,
  CameraDetectionSource,
  ConfigSectionWithValues,
  ConfigUISchema,
  ConfigUISchemaWithValues,
  PipelineAssignment,
} from '@camstack/types'
import {
  CAMERA_SENSORS_SETTINGS_KEY,
  createEvent,
  DeviceType,
  EventCategory,
  errMsg,
  hydrateSchema,
} from '@camstack/types'
import {
  armOnboardChannel,
  type CameraDetectionSourceView,
  readCameraDetectionSource,
  storedFromPick,
} from './camera-detection-source.js'
import { validateCameraSensorsPatch } from './camera-sensors/settings.js'
import { resolveIngestOwner } from './ingest-owner.js'
import type { NodeTopologyService } from './node-topology.js'
import { RETIRED_CAMERA_PIPELINE_PATCH_KEY } from './orchestrator-types.js'

/** Injected dependencies for {@link DeviceConfigContributions}. */
export interface DeviceConfigContributionsDeps {
  /** Throwing ctx accessor — mirrors the pre-extraction `this.ctx` getter (same object, same throw). */
  readonly ctx: () => AddonContext
  readonly topology: NodeTopologyService
  /** `this.ledger!.getAssignment(deviceId)` (read-only). */
  readonly getAssignment: (deviceId: number) => PipelineAssignment | null
  /** `this.deviceSettingsSchema()` — stays on index.ts (thin delegate onto `buildDeviceSettingsSections`, S2). */
  readonly deviceSettingsSchema: () => ConfigUISchema | null
  /** `this.deviceHasOnboardMotionCap(deviceId)` — stays on index.ts (not part of the C13 move list). */
  readonly deviceHasOnboardMotionCap: (deviceId: number) => Promise<boolean>
  /** `this.deviceHasActivitySignalCap(deviceId)` — same shape, `recording-signal`. */
  readonly deviceHasActivitySignalCap: (deviceId: number) => Promise<boolean>
  /** `this.deviceHasNativeObjectDetectionCap(deviceId)` — stays on index.ts. */
  readonly deviceHasNativeObjectDetectionCap: (deviceId: number) => Promise<boolean>
  /** `super.updateGlobalSettings(patch)` — the `BaseAddon` two-level settings write + auto-restart check. */
  readonly baseUpdateGlobalSettings: (patch: Record<string, unknown>) => Promise<void>
  /** `this.resolveGlobalStore()` — the `BaseAddon` protected store reader. */
  readonly resolveGlobalStore: () => Promise<Record<string, unknown>>
  /** `this.globalSettings = settings` — the addon's in-memory settings snapshot. */
  readonly setGlobalSettings: (settings: Record<string, unknown>) => void
  /**
   * `this.applyRuntimeSettings(config)` — re-derives `failoverPolicy` +
   * `clusterRoles` (via `deriveRuntimeSettings`) and `schedulePendingRetry()`.
   * Stays on index.ts — also invoked synchronously during `onInitialize`.
   */
  readonly applyRuntimeSettings: (config: Record<string, unknown>) => void
  /** `this.placement!.redispatchAllActiveCameras(reason)`. */
  readonly redispatchAllActiveCameras: (reason: string) => Promise<void>
  /** `this.loadShed!.clearOnSettingsChange()`. */
  readonly clearOnSettingsChange: () => void
}

export class DeviceConfigContributions {
  constructor(private readonly deps: DeviceConfigContributionsDeps) {}

  // ── New three-level settings API (Phase 3 pilot) ─────────────────────

  async updateGlobalSettings(patch: Record<string, unknown>): Promise<void> {
    const previousIngestNode = this.deps.topology.clusterRoles.ingestNode
    await this.deps.baseUpdateGlobalSettings(patch)
    // Re-read full state and re-apply runtime tunables (balancer thresholds,
    // failover policy, broker timeout) so subsequent dispatches pick them up.
    const full = await this.deps.resolveGlobalStore()
    this.deps.setGlobalSettings({ ...full })
    this.deps.applyRuntimeSettings(full)

    // Operator log-visibility (best-effort, never throws): warn when the
    // ingest owner just changed to a node that's unreachable or not
    // ingest-capable. Purely additive — never affects the settings write
    // above, and `ingestNode='hub'` (the default) never produces a
    // configIssue, so this is silent in the byte-identical-to-slice-2 case.
    if (this.deps.topology.clusterRoles.ingestNode !== previousIngestNode) {
      const { configIssue } = resolveIngestOwner(
        this.deps.topology.clusterRoles,
        this.deps.topology.reachableHostByNode,
        this.deps.topology.enabledIngestNodes,
      )
      if (configIssue !== undefined) {
        this.deps.ctx().logger.warn('ingest node config issue', {
          meta: { ingestNode: this.deps.topology.clusterRoles.ingestNode, issue: configIssue },
        })
      }
      // The ingest owner changed. Two things must happen, IN ORDER:
      //   1. Re-derive `remoteSourcingNodes` for the NEW owner — it is computed
      //      in `refreshNodeCapabilities` (`deriveRemoteSourcingNodes(...,
      //      clusterRoles.ingestNode)`), which `applyRuntimeSettings` above does
      //      NOT run. Without this the frame-source table is stale (old owner),
      //      so every `selectRunnerFrameSource` still emits `local-broker`.
      //   2. Re-dispatch every camera — the per-camera `frameSource` is resolved
      //      at ATTACH time, so already-running sessions must re-attach to move
      //      their physical source pull to the new owner (otherwise the flip is
      //      inert; sessions keep sourcing from the old owner).
      // Fire-and-forget so the settings write returns promptly.
      void this.deps.topology
        .refreshNodeCapabilities()
        .then(() => this.deps.redispatchAllActiveCameras('ingest-owner-changed'))
        .catch((err: unknown) => {
          this.deps.ctx().logger.warn('ingest-owner-changed re-dispatch failed', {
            meta: { error: errMsg(err) },
          })
        })
    }

    // Clear load-shed state so suspended cameras get re-evaluated
    // with the new thresholds on the next dispatch cycle.
    this.deps.clearOnSettingsChange()
  }

  private async writeDeviceOrchestratorSettings(
    deviceId: number,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.ctx().settings!.writeDeviceStore(deviceId, patch)
    this.deps
      .ctx()
      .eventBus.emit(
        createEvent(
          EventCategory.OrchestrationSettingsUpdated,
          { type: 'device', id: deviceId, nodeId: 'hub' },
          { deviceId },
        ),
      )
  }

  // ── Device-details aggregator contribution (pipeline-orchestrator cap) ──
  //
  // Contributes the pipeline routing tab (enables + source + routing +
  // rates) for every camera. Live contribution exposes the current
  // assignment (runner nodeId) and the cached metrics snapshot so the
  // device-details page can show where the camera is being processed
  // right now without an extra round-trip to pipeline-runner.

  async getDeviceSettingsContribution(input: {
    deviceId: number
  }): Promise<ConfigUISchemaWithValues | null> {
    // Camera-only — pipeline routing / motion / zones are meaningless
    // on Lights / Switches / Sensors / Buttons. Source-side gate keeps
    // the policy with the addon owning the cap; the admin-ui no longer
    // needs the `device-section-policy` allow-list to drop these
    // sections after the fact.
    if (!(await this.isCameraDevice(input.deviceId))) return null
    const raw = (await this.deps.ctx().settings?.readDeviceStore(input.deviceId)) ?? {}
    const schema = this.deps.deviceSettingsSchema()
    if (!schema) return null

    // ── Onboard motion default reflection ───────────────────────────
    //
    // `resolveDeviceDetectionSettings` already prefers `['onboard']` for
    // devices whose driver registered a native `motion`/`native-object-
    // detection` cap (Reolink Baichuan, Hikvision alarm-stream VMD).
    // The form, though, hydrates from device-store ∪ schema-default —
    // when the operator hasn't explicitly saved a value, the static
    // schema default `['analyzer']` wins and the form lies about which
    // source is active. Mirror the runtime resolution into `raw` so
    // both the displayed default AND the runtime call line up.
    const hasOnboardMotion = await this.deps.deviceHasOnboardMotionCap(input.deviceId)
    const hasActivitySignal = await this.deps.deviceHasActivitySignalCap(input.deviceId)
    const rawWithDefaults =
      raw['motionSources'] === undefined && (hasOnboardMotion || hasActivitySignal)
        ? {
            ...raw,
            // The SAME ladder `resolveDetectionSettings` runs, mirrored so the
            // form shows the sources that are actually live. A device that
            // reports its own activity carries `device-activity` here for the
            // same reason onboard is carried: a form that hides a live default
            // is a form that lies about it (D392).
            motionSources: [
              ...(hasOnboardMotion ? ['onboard'] : []),
              ...(hasActivitySignal ? ['device-activity'] : []),
            ],
          }
        : raw

    // L2.5 redesign: the legacy `pipeline-editor` ConfigField contribution
    // is removed — the per-camera pipeline surface now lives on the
    // top-level Device → Pipeline tab (`DeviceStepOverrideTab`, master-
    // detail with per-agent per-step overrides). Keeping both surfaces
    // duplicated the editor inside Config → Pipeline and confused
    // operators about which one was authoritative. Only the base
    // device-settings sections (classifier overrides, detection toggles,
    // …) flow through here now; pipeline tree + engine live in the
    // dedicated tab.
    const baseSections: readonly ConfigSectionWithValues[] = hydrateSchema(
      {
        ...schema,
        sections: schema.sections.map((s) => ({
          ...s,
          tab: s.tab ?? 'pipeline',
        })),
      },
      rawWithDefaults,
    ).sections
    // Zones tab is contributed declaratively here: a `top-tab` section
    // hoists into the device-detail tab bar, keyed by tab id `zones`
    // (well-known tab → label "Zones", icon "shapes"). The single
    // `widget` field is resolved by the shared `WidgetSlot` runtime
    // against the orchestrator-shipped `zone-editor` widget bundle —
    // orchestrator just declares intent, not the React component.
    const zonesSection: ConfigSectionWithValues = {
      id: 'zones',
      title: 'Detection Zones',
      tab: 'zones',
      location: 'top-tab',
      // Single full-width column — the zone-editor widget paints the
      // polygon canvas + side panel + rules + occupancy across the
      // entire viewport. Default 2-column grid would clip everything to
      // 50% width.
      columns: 1,
      order: 0,
      fields: [
        {
          type: 'widget',
          key: 'zones',
          label: 'Detection Zones',
          widgetId: 'pipeline-orchestrator/zone-editor',
          // Span across the (single) column so even if a layout engine
          // were to compute multiple columns, the field still pulls full
          // width.
          span: 1,
        },
      ],
    }
    // Motion-zones is no longer contributed here — the `motion-zones`
    // cap declares a `ui` block, so its config UI is surfaced
    // automatically by the cap-UI contribution mechanism (ConfigTab →
    // admin-ui UI_COMPONENTS). No per-addon widget wiring.

    // Which root detector this camera runs is NOT a contributed section: it is
    // the first control of the Detection pipeline → Steps editor, read and
    // written through `getCameraDetectionSource` / `setCameraDetectionSource`
    // (one authority, one control — D62).
    return {
      sections: [...baseSections, zonesSection],
    }
  }

  async getDeviceLiveContribution(input: {
    deviceId: number
  }): Promise<ConfigUISchemaWithValues | null> {
    const assignment = this.deps.getAssignment(input.deviceId)
    if (!assignment) return null
    return {
      sections: [
        {
          id: 'orchestrator-live',
          title: 'Pipeline Status',
          tab: 'detection-pipeline',
          location: 'top-tab' as const,
          order: 100,
          fields: [
            {
              type: 'text',
              key: 'assignedRunner',
              label: 'Assigned Runner',
              readonlyField: true,
              value: assignment.agentNodeId,
            },
            {
              type: 'text',
              key: 'assignmentReason',
              label: 'Assignment Reason',
              readonlyField: true,
              value: assignment.pinned ? 'pinned' : assignment.reason,
            },
          ],
        },
      ],
    }
  }

  /**
   * Best-effort camera-type check used to gate the settings/live
   * contributions on non-camera devices (Lights, Switches, Sensors,
   * Buttons). Returns `true` on lookup failure so a transient
   * device-manager hiccup never silently hides legitimate camera
   * sections.
   */
  private async isCameraDevice(deviceId: number): Promise<boolean> {
    const api = this.deps.ctx().api
    if (!api) return true
    try {
      const dev = await api.deviceManager.getDevice.query({ deviceId })
      if (!dev) return true
      return (dev as { type?: string }).type === DeviceType.Camera
    } catch {
      return true
    }
  }

  /** Where this camera's detections come from, for the Steps editor's first control. */
  async getCameraDetectionSource(input: { deviceId: number }): Promise<CameraDetectionSourceView> {
    return readCameraDetectionSource(this.deps, input.deviceId)
  }

  /**
   * Pick where this camera's detections come from. Goes through the same write
   * as every other detection-wiring field (the device store + the settings
   * event), and arms the vendor sub-stream the pick drives.
   */
  async setCameraDetectionSource(input: {
    deviceId: number
    source: CameraDetectionSource
  }): Promise<{ success: true }> {
    if (input.source === 'onboard') {
      const view = await readCameraDetectionSource(this.deps, input.deviceId)
      if (!view.onboard.available) {
        throw new Error(
          `setCameraDetectionSource: device ${String(input.deviceId)} has no onboard detector to use as its root`,
        )
      }
    }
    await armOnboardChannel(this.deps.ctx, input.deviceId, input.source === 'onboard')
    await this.writeDeviceOrchestratorSettings(input.deviceId, {
      detectionSources: storedFromPick(input.source),
    })
    return { success: true as const }
  }

  async applyDeviceSettingsPatch(input: {
    deviceId: number
    patch: Record<string, unknown>
  }): Promise<{ success: true }> {
    // The camera-sensors write gate (D672) runs FIRST, so a refused patch
    // writes nothing at all — not even the valid keys that travel with it.
    const sensors = validateCameraSensorsPatch(input.patch)
    if (sensors.kind === 'refused') {
      this.deps.ctx().logger.warn('camera sensors: patch refused — nothing written', {
        tags: { deviceId: input.deviceId },
        meta: { reason: sensors.reason },
      })
      throw new Error(`cameraSensors refused: ${sensors.reason}`)
    }
    // A camera carries no pipeline tree of its own (D927): the retired
    // `cameraPipeline` key is REFUSED, by name, before anything is written.
    // Everything else goes through the device store for the detection-wiring
    // fields (motion/detection toggles, stream profiles, rates, camera
    // priority, pipelineNodeId / audioNodeId pins).
    if (RETIRED_CAMERA_PIPELINE_PATCH_KEY in input.patch) {
      this.deps
        .ctx()
        .logger.warn('device settings patch refused: a camera carries no pipeline tree', {
          tags: { deviceId: input.deviceId },
          meta: { key: RETIRED_CAMERA_PIPELINE_PATCH_KEY },
        })
      throw new Error(
        `${RETIRED_CAMERA_PIPELINE_PATCH_KEY} refused: a camera only turns steps on or off (setCameraStepToggle); models belong to the accelerator that runs them`,
      )
    }
    const rest = input.patch

    // Route `nativeObjectDetectionEnabled` directly to the cap's
    // `setEnabled` mutation. The cap runtimeState is the single source
    // of truth — never persist a divergent copy in the orchestrator store.
    // `detectionSources` DRIVES the vendor's sub-stream: a camera whose root
    // detector is its own firmware needs the boxed channel held open, and a
    // camera that just stopped being one must not keep paying for it. The cap
    // flag is the mechanism; `armOnboardChannel` is its only writer. A page
    // opened before the picker moved into the steps editor may still send the
    // key, so it keeps landing here.
    const nextSources = rest['detectionSources']
    if (Array.isArray(nextSources)) {
      await armOnboardChannel(this.deps.ctx, input.deviceId, nextSources.includes('onboard'))
    }
    // Store the PARSED value (R3: stable refs only) — never the raw patch,
    // which may carry keys Zod stripped, such as a numeric id inside a ref.
    const orchestratorRest =
      sensors.kind === 'valid' ? { ...rest, [CAMERA_SENSORS_SETTINGS_KEY]: sensors.value } : rest

    if (Object.keys(orchestratorRest).length > 0) {
      await this.writeDeviceOrchestratorSettings(input.deviceId, orchestratorRest)
    }
    return { success: true as const }
  }
}
