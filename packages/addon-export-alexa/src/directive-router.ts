/**
 * Top-level dispatch for inbound `/addon/export-alexa/directive`
 * payloads. Validates the envelope shape, picks a handler based on
 * `header.namespace + name`, and falls back to the stub responder for
 * namespaces we haven't implemented yet.
 */
import type { ExportEntityApi, IScopedLogger, MethodAccess, TokenScope } from '@camstack/types'
import { scopesAllowDeviceCap } from '@camstack/types'
import { type AlexaPrincipal, endpointAccessTarget } from './access/access-gate.js'
import { readConnectivity } from './connectivity.js'
import {
  GENERIC_DIRECTIVE_KEYS,
  GENERIC_REACHABLE_DIRECTIVE_KEYS,
  genericDirectives,
  resolveGenericDirective,
} from './endpoints/adapters/index.js'
import {
  type ActionSceneExports,
  handleActionSceneDirective,
  parseActionEndpointId,
} from './action-scenes.js'
import { parseCameraEndpointId } from './handlers/endpoint-id.js'
import type { AlexaEndpoint } from './endpoints/types.js'
import { withholdInvalidEndpoints } from './endpoints/validate-endpoint.js'
import {
  alexaErrorTypeFor,
  authorizeEndpoint,
  describeRefusal,
  type EndpointAccessDeps,
  filterEndpointsForPrincipal,
} from './access/endpoint-access.js'
import {
  type BrightnessControllerContext,
  handleSetBrightness,
} from './handlers/brightness-controller.js'
import {
  type CameraStreamContext,
  handleInitializeCameraStreams,
} from './handlers/camera-stream.js'
import {
  handleDeleteData,
  handleReportData,
  handleSetObjectDetectionClasses,
  type VisionContext,
} from './handlers/data-controller.js'
import { type DiscoveryContext, handleDiscovery } from './handlers/discovery.js'
import { errorEnvelope } from './handlers/error-envelope.js'
import { handleLock, type LockControllerContext } from './handlers/lock-controller.js'
import type { ClimateControllerContext } from './handlers/climate-controller.js'
import type { CoverControllerContext } from './handlers/cover-controller.js'
import { handlePower, type PowerControllerContext } from './handlers/power-controller.js'
import { handlePtzDirection, type PtzDirectionContext } from './handlers/ptz-direction.js'
import { handleSetMode, type PtzPresetContext } from './handlers/ptz-preset.js'
import { handleGetSnapshot, type SnapshotProviderContext } from './handlers/snapshot-provider.js'
import { handleReportState, type ReportStateContext } from './handlers/report-state.js'
import {
  handleInitiateSessionWithOffer,
  handleSessionConnected,
  handleSessionDisconnected,
  type RtcSessionContext,
} from './handlers/rtc-session.js'
import { handleArm, handleDisarm, type SecurityPanelContext } from './handlers/security-panel.js'
import { notImplemented } from './handlers/stubs.js'
import { type DirectiveRequest, DirectiveRequestSchema } from './handlers/types.js'

// ── Directive auth helpers ───────────────────────────────────────────

/**
 * Verified identity threaded from the centralized `/directive` entry
 * check into each handler. Produced by `oauthVerifyAccessToken` in
 * `handleDirective` (http-server.ts) and passed into `dispatchDirective`
 * so individual handlers do not repeat the verification.
 */
export interface VerifiedDirectiveIdentity {
  readonly userId: string
  readonly username: string
  readonly scopes: readonly TokenScope[]
}

/**
 * Pull the bearer Alexa attaches to a directive. Alexa places the
 * token in `endpoint.scope.token` for device-scoped directives and in
 * `payload.scope.token` for discovery directives.
 * Returns `null` when neither location carries a string token.
 */
export function extractDirectiveBearer(event: unknown): string | null {
  const d = (
    event as {
      directive?: {
        endpoint?: { scope?: { token?: unknown } }
        payload?: { scope?: { token?: unknown } }
      }
    }
  ).directive
  const ep = d?.endpoint?.scope?.token
  if (typeof ep === 'string') return ep
  const pl = d?.payload?.scope?.token
  if (typeof pl === 'string') return pl
  return null
}

/**
 * Throw unless the token's scopes cover device-scoped capabilities
 * with at least `view` access. This is the minimum required to dispatch
 * any Alexa directive — read, stream, or actuate all require device
 * visibility.
 */
export function assertDeviceScope(scopes: readonly TokenScope[]): void {
  if (!scopesAllowDeviceCap(scopes, 'view')) {
    throw new Error('token lacks device scope')
  }
}

/**
 * Guard a device directive against the caller token's scopes.
 * `'view'` for read/discovery directives, `'create'` for control.
 *
 * The matching itself is `scopesAllowDeviceCap`, which now lives in
 * `@camstack/types` precisely so an addon can reach it: both of these used to
 * carry a hand-copied re-implementation with a comment saying so, and a copy
 * that drifts from the framework's matcher is a scope check that disagrees with
 * every other scope check in the product.
 */
export function requireDeviceScope(scopes: readonly TokenScope[], access: MethodAccess): void {
  if (!scopesAllowDeviceCap(scopes, access)) {
    throw new Error(`directive token not authorized for device ${access}`)
  }
}

// ── Router types ─────────────────────────────────────────────────────

/** What the router needs to answer a directive for an exported action. */
export interface ActionSceneRouting {
  readonly exports: ActionSceneExports
  readonly api: ExportEntityApi
  readonly logger: IScopedLogger
}

export interface DirectiveRouterDeps {
  readonly discovery: DiscoveryContext
  readonly cameraStream: CameraStreamContext
  readonly rtcSession: RtcSessionContext
  readonly ptzPreset: PtzPresetContext
  readonly ptzDirection: PtzDirectionContext
  readonly powerController: PowerControllerContext
  readonly brightnessController: BrightnessControllerContext
  readonly reportState: ReportStateContext
  readonly securityPanel: SecurityPanelContext
  /** R5 (D775): `Alexa.LockController`. */
  readonly lockController: LockControllerContext
  /** D869: `Alexa.RangeController` / `Alexa.ModeController` on a cover. */
  readonly coverController: CoverControllerContext
  /** D874: `Alexa.ThermostatController` and friends on a thermostat / AC. */
  readonly climateController: ClimateControllerContext
  /** R2 (D773): `Alexa.SmartVision.SnapshotProvider/GetSnapshot`. */
  readonly snapshotProvider: SnapshotProviderContext
  /** R4 (D779): `SetObjectDetectionClasses` and `Alexa.DataController`. */
  readonly vision: VisionContext
  /** S1 (D767): the exposed set + the linking user's live grants. */
  readonly access: EndpointAccessDeps
  /** D967: exported actions answered as scenes. Absent = none exported. */
  readonly actionScenes?: ActionSceneRouting
  /**
   * Called with the endpoints a Discover answered, for the linking user. The
   * addon reports their initial connectivity from here (D770).
   */
  readonly afterDiscovery: (userId: string, endpoints: readonly AlexaEndpoint[]) => void
}

/**
 * Directives that are never refused by the access gate. `SessionDisconnected`
 * only tears down a session that already exists (and releases its transcode);
 * refusing it because the user lost access in the meantime would leak the
 * egress the reaper then has to find.
 */
const ACCESS_EXEMPT: ReadonlySet<string> = new Set([
  'Alexa.RTCSessionController/SessionDisconnected',
])

/**
 * Directives that need the device itself to answer. On a device the registry
 * reports OFFLINE they are refused with `ENDPOINT_UNREACHABLE` at once, rather
 * than spending Alexa's few-second budget on a transcode or a command that
 * cannot land (runbook C.2-b). `Alexa/ReportState` is NOT here: an offline
 * endpoint still answers, with `connectivity: UNREACHABLE` and the last known
 * values (alexa-endpointhealth). A status read that fails does not refuse.
 */
const NEEDS_REACHABLE_DEVICE: ReadonlySet<string> = new Set([
  'Alexa.CameraStreamController/InitializeCameraStreams',
  'Alexa.RTCSessionController/InitiateSessionWithOffer',
  'Alexa.PowerController/TurnOn',
  'Alexa.PowerController/TurnOff',
  'Alexa.BrightnessController/SetBrightness',
  'Alexa.ModeController/SetMode',
  'Alexa.ToggleController/TurnOn',
  'Alexa.ToggleController/TurnOff',
  'Alexa.SecurityPanelController/Arm',
  'Alexa.SecurityPanelController/Disarm',
  'Alexa.LockController/Lock',
  'Alexa.LockController/Unlock',
  // Every directive an adapter handles on a generic endpoint (D869).
  ...GENERIC_REACHABLE_DIRECTIVE_KEYS,
])

export interface DirectiveResult {
  readonly status: number
  readonly body: unknown
}

/**
 * Give an `Alexa.ErrorResponse` the directive's endpoint when it lacks one.
 * Amazon requires `endpoint` on every ErrorResponse to an endpoint directive
 * (alexa-errorresponse); the handlers build their errors from the header
 * alone, so the router — which holds the endpoint for every path — adds it.
 */
export function withErrorEndpoint(body: unknown, endpoint: unknown): unknown {
  const endpointId =
    typeof endpoint === 'object' &&
    endpoint !== null &&
    typeof (endpoint as { endpointId?: unknown }).endpointId === 'string'
      ? (endpoint as { endpointId: string }).endpointId
      : null
  if (endpointId === null || typeof body !== 'object' || body === null) return body
  const event = (body as { event?: unknown }).event
  if (typeof event !== 'object' || event === null) return body
  const ev = event as { header?: { name?: unknown; namespace?: unknown }; endpoint?: unknown }
  if (ev.header?.namespace !== 'Alexa' || ev.header?.name !== 'ErrorResponse') return body
  if (ev.endpoint !== undefined) return body
  return { ...body, event: { ...ev, endpoint: { endpointId } } }
}

/** The device whose online state decides whether an endpoint is reachable:
 *  the device the directive actuates (an accessory for a child endpoint). */
function reachabilityDeviceOf(endpointId: string): number | null {
  const target = endpointAccessTarget(parseCameraEndpointId(endpointId))
  return target === null ? null : target.deviceId
}

/** Whether the principal may CONTROL the device an endpoint addresses — the
 *  talk-back gate (D771). */
async function mayControlEndpoint(
  endpointId: string | undefined,
  principal: AlexaPrincipal | null,
  access: EndpointAccessDeps,
): Promise<boolean> {
  if (endpointId === undefined || principal === null) return false
  const verdict = await authorizeEndpoint(endpointId, principal, access, 'create')
  return verdict.allowed
}

export async function dispatchDirective(
  rawBody: unknown,
  deps: DirectiveRouterDeps,
  callerIdentity: VerifiedDirectiveIdentity,
): Promise<DirectiveResult> {
  const result = await dispatchParsedDirective(rawBody, deps, callerIdentity)
  const endpoint = (rawBody as { directive?: { endpoint?: unknown } } | null)?.directive?.endpoint
  return { status: result.status, body: withErrorEndpoint(result.body, endpoint) }
}

async function dispatchParsedDirective(
  rawBody: unknown,
  deps: DirectiveRouterDeps,
  callerIdentity: VerifiedDirectiveIdentity,
): Promise<DirectiveResult> {
  const parsed = DirectiveRequestSchema.safeParse(rawBody)
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        event: {
          header: {
            namespace: 'Alexa',
            name: 'ErrorResponse',
            messageId: 'unknown',
            payloadVersion: '3',
          },
          payload: {
            type: 'INVALID_DIRECTIVE',
            message: `directive envelope failed validation: ${parsed.error.message}`,
          },
        },
      },
    }
  }
  const req: DirectiveRequest = parsed.data
  const { header, endpoint, payload } = req.directive

  // ── Directive → required access level ──────────────────────────────
  // Map from `${namespace}/${name}` to the MethodAccess level required.
  // Discovery and stream/session read directives need only 'view'; control
  // directives need 'create'.
  const DIRECTIVE_ACCESS: Readonly<Record<string, MethodAccess>> = {
    'Alexa.Discovery/Discover': 'view',
    'Alexa.CameraStreamController/InitializeCameraStreams': 'view',
    'Alexa.RTCSessionController/InitiateSessionWithOffer': 'view',
    'Alexa.RTCSessionController/SessionConnected': 'view',
    'Alexa.RTCSessionController/SessionDisconnected': 'view',
    'Alexa.PowerController/TurnOn': 'create',
    'Alexa.PowerController/TurnOff': 'create',
    'Alexa.BrightnessController/SetBrightness': 'create',
    'Alexa.ModeController/SetMode': 'create',
    'Alexa.ToggleController/TurnOn': 'create',
    'Alexa.ToggleController/TurnOff': 'create',
    'Alexa/ReportState': 'view',
    'Alexa.SecurityPanelController/Arm': 'create',
    'Alexa.SecurityPanelController/Disarm': 'create',
    'Alexa.SmartVision.SnapshotProvider/GetSnapshot': 'view',
    // R4 (D779): all three only change or read what ALEXA holds about the
    // camera (which classes it is told about, the history it is shown);
    // nothing in CamStack is actuated or deleted.
    'Alexa.SmartVision.ObjectDetectionSensor/SetObjectDetectionClasses': 'view',
    'Alexa.DataController/ReportData': 'view',
    'Alexa.DataController/DeleteData': 'view',
    'Alexa.LockController/Lock': 'create',
    'Alexa.LockController/Unlock': 'create',
    // D967: running an action is an act.
    'Alexa.SceneController/Activate': 'create',
    // Every directive an adapter handles actuates a device (D869).
    ...Object.fromEntries(GENERIC_DIRECTIVE_KEYS.map((k): [string, MethodAccess] => [k, 'create'])),
  }

  try {
    const key = `${header.namespace}/${header.name}`

    // Determine required access level: explicit mapping or 'view' as default
    // (any device directive requires at minimum device-read visibility).
    const requiredAccess: MethodAccess = DIRECTIVE_ACCESS[key] ?? 'view'
    try {
      requireDeviceScope(callerIdentity.scopes, requiredAccess)
    } catch (scopeErr: unknown) {
      return {
        status: 200,
        body: errorEnvelope(
          header,
          'INVALID_AUTHORIZATION_CREDENTIAL',
          scopeErr instanceof Error ? scopeErr.message : String(scopeErr),
        ),
      }
    }

    let principal: AlexaPrincipal | null = null
    if (!ACCESS_EXEMPT.has(key)) {
      const lookup = await deps.access.gate.principal(callerIdentity.userId)
      if (lookup.kind === 'unknown-user') {
        deps.discovery.logger.warn(
          'alexa directive: refused — the hub user who linked this Alexa account no longer exists',
          { meta: { userId: callerIdentity.userId, directive: key } },
        )
        return {
          status: 200,
          body: errorEnvelope(
            header,
            'INVALID_AUTHORIZATION_CREDENTIAL',
            'the hub user behind this account link no longer exists',
          ),
        }
      }
      if (lookup.kind === 'unavailable') {
        return {
          status: 200,
          body: errorEnvelope(header, 'INTERNAL_ERROR', lookup.error),
        }
      }
      principal = lookup.principal
      // D967: an action is not a device — it has no registry chain for the
      // access gate to walk, so it is answered (admin only) before the gate.
      if (
        endpoint !== undefined &&
        deps.actionScenes !== undefined &&
        parseActionEndpointId(endpoint.endpointId) !== null
      ) {
        const scenes = deps.actionScenes
        const body = await handleActionSceneDirective(header, endpoint, principal, {
          api: scenes.api,
          logger: scenes.logger,
          isExposed: (actionId) => scenes.exports.isExposed(actionId),
        })
        return { status: 200, body }
      }
      if (key !== 'Alexa.Discovery/Discover') {
        if (endpoint === undefined) {
          return {
            status: 200,
            body: errorEnvelope(header, 'INVALID_DIRECTIVE', 'missing directive.endpoint'),
          }
        }
        const verdict = await authorizeEndpoint(
          endpoint.endpointId,
          principal,
          deps.access,
          requiredAccess,
        )
        if (!verdict.allowed) {
          deps.discovery.logger.info('alexa directive: refused by the user access gate', {
            meta: {
              userId: callerIdentity.userId,
              directive: key,
              endpointId: endpoint.endpointId,
              reason: describeRefusal(verdict.refusal),
            },
          })
          return {
            status: 200,
            body: errorEnvelope(
              header,
              alexaErrorTypeFor(verdict.refusal),
              describeRefusal(verdict.refusal),
            ),
          }
        }
        if (NEEDS_REACHABLE_DEVICE.has(key)) {
          const deviceId = reachabilityDeviceOf(endpoint.endpointId)
          if (
            deviceId !== null &&
            (await readConnectivity(
              deps.reportState.ctx.api,
              deviceId,
              deps.reportState.logger,
            )) === 'UNREACHABLE'
          ) {
            deps.reportState.logger.info('alexa directive: refused — the device is offline', {
              tags: { deviceId },
              meta: { directive: key, endpointId: endpoint.endpointId },
            })
            return {
              status: 200,
              body: errorEnvelope(header, 'ENDPOINT_UNREACHABLE', `device ${deviceId} is offline`),
            }
          }
        }
      }
    }

    if (key === 'Alexa.Discovery/Discover') {
      if (principal === null) throw new Error('discovery reached without a principal')
      const who = principal
      const body = await handleDiscovery(header, payload, deps.discovery, callerIdentity, {
        deviceVisible: async (deviceId) =>
          deps.access.isExposed(deviceId) &&
          (await deps.access.gate.allows(who, deviceId, 'view')) === 'allowed',
        filterEndpoints: async (endpoints) => {
          const filtered = await filterEndpointsForPrincipal(endpoints, who, deps.access)
          if (filtered.refused.length > 0) {
            deps.discovery.logger.info('alexa discovery: endpoints withheld from this link', {
              meta: {
                userId: callerIdentity.userId,
                withheld: filtered.refused.map((r) => ({
                  endpointId: r.endpointId,
                  reason: describeRefusal(r.refusal),
                })),
              },
            })
          }
          const scenes = deps.actionScenes?.exports.endpointsFor(who) ?? []
          const valid = withholdInvalidEndpoints(
            [...filtered.kept, ...scenes],
            (message, violations) => {
              deps.discovery.logger.warn(message, {
                meta: { userId: callerIdentity.userId, violations },
              })
            },
          )
          deps.afterDiscovery(callerIdentity.userId, valid)
          return valid
        },
      })
      return { status: 200, body }
    }
    if (key === 'Alexa.CameraStreamController/InitializeCameraStreams') {
      const body = await handleInitializeCameraStreams(
        header,
        endpoint,
        payload,
        deps.cameraStream,
        callerIdentity,
      )
      return { status: 200, body }
    }
    if (key === 'Alexa.RTCSessionController/InitiateSessionWithOffer') {
      const body = await handleInitiateSessionWithOffer(
        header,
        endpoint,
        payload,
        deps.rtcSession,
        callerIdentity,
        { mayTalk: await mayControlEndpoint(endpoint?.endpointId, principal, deps.access) },
      )
      return { status: 200, body }
    }
    if (key === 'Alexa.RTCSessionController/SessionConnected') {
      const body = handleSessionConnected(header, endpoint, payload, deps.rtcSession)
      return { status: 200, body }
    }
    if (key === 'Alexa.RTCSessionController/SessionDisconnected') {
      const body = await handleSessionDisconnected(
        header,
        endpoint,
        payload,
        deps.rtcSession,
        callerIdentity,
      )
      return { status: 200, body }
    }
    // A generic device (R5, D869): the directive is the adapter registry's, by
    // cap — no per-cap branch here.
    if (genericDirectives(key).length > 0 && endpoint !== undefined) {
      const target = parseCameraEndpointId(endpoint.endpointId)
      if (target.kind === 'generic') {
        const directiveContext = {
          header,
          endpoint,
          payload,
          deviceId: target.deviceId,
          deps,
          identity: callerIdentity,
        }
        // Two caps may answer one key (power on a switch and on a thermostat):
        // the first adapter that claims this endpoint handles it.
        const adapterDirective = await resolveGenericDirective(directiveContext)
        if (adapterDirective === null) {
          return {
            status: 200,
            body: errorEnvelope(
              header,
              'INVALID_DIRECTIVE',
              `${key}: no handler for this endpoint`,
            ),
          }
        }
        return { status: 200, body: await adapterDirective.handle(directiveContext) }
      }
    }
    if (key === 'Alexa.ModeController/SetMode') {
      const body = await handleSetMode(header, endpoint, payload, deps.ptzPreset, callerIdentity)
      return { status: 200, body }
    }
    if (key === 'Alexa.PowerController/TurnOn' || key === 'Alexa.PowerController/TurnOff') {
      const body = await handlePower(header, endpoint, deps.powerController, callerIdentity)
      return { status: 200, body }
    }
    if (key === 'Alexa.BrightnessController/SetBrightness') {
      const body = await handleSetBrightness(
        header,
        endpoint,
        payload,
        deps.brightnessController,
        callerIdentity,
      )
      return { status: 200, body }
    }
    if (key === 'Alexa.ToggleController/TurnOn' || key === 'Alexa.ToggleController/TurnOff') {
      const body = await handlePtzDirection(header, endpoint, deps.ptzDirection, callerIdentity)
      return { status: 200, body }
    }
    if (key === 'Alexa.SecurityPanelController/Arm') {
      const body = await handleArm(header, endpoint, payload, deps.securityPanel, callerIdentity)
      return { status: 200, body }
    }
    if (key === 'Alexa.SecurityPanelController/Disarm') {
      const body = await handleDisarm(header, endpoint, payload, deps.securityPanel, callerIdentity)
      return { status: 200, body }
    }
    if (key === 'Alexa.LockController/Lock' || key === 'Alexa.LockController/Unlock') {
      const body = await handleLock(header, endpoint, deps.lockController)
      return { status: 200, body }
    }
    if (key === 'Alexa.SmartVision.SnapshotProvider/GetSnapshot') {
      const body = await handleGetSnapshot(header, endpoint, deps.snapshotProvider, callerIdentity)
      return { status: 200, body }
    }
    if (key === 'Alexa.SmartVision.ObjectDetectionSensor/SetObjectDetectionClasses') {
      const body = await handleSetObjectDetectionClasses(header, endpoint, payload, deps.vision)
      return { status: 200, body }
    }
    if (key === 'Alexa.DataController/ReportData') {
      const body = await handleReportData(header, endpoint, payload, deps.vision, callerIdentity)
      return { status: 200, body }
    }
    if (key === 'Alexa.DataController/DeleteData') {
      const body = await handleDeleteData(header, endpoint, payload, deps.vision, callerIdentity)
      return { status: 200, body }
    }
    if (key === 'Alexa/ReportState') {
      const body = await handleReportState(header, endpoint, deps.reportState, callerIdentity)
      return { status: 200, body }
    }
    // Unimplemented namespaces (anything Discovery declares but isn't
    // wired above). Returns the canonical `INVALID_DIRECTIVE` error so
    // the Echo surfaces "not supported" instead of silently timing out.
    return { status: 200, body: notImplemented(header) }
  } catch (err: unknown) {
    return {
      status: 500,
      body: errorEnvelope(
        header,
        'INTERNAL_ERROR',
        err instanceof Error ? err.message : String(err),
      ),
    }
  }
}
