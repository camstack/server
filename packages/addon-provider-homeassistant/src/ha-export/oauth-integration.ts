import type { OauthIntegrationDescriptor } from '@camstack/types'

/**
 * The `homeassistant` OAuth client — the descriptor behind
 * `/api/oauth2/authorize?integration=homeassistant`.
 *
 * **Why this manifest and not the provider's.** The client on the other side of
 * this grant is the CamStack custom component inside Home Assistant, and that
 * component is `homeassistant-export`'s counterpart: export pushes to it, and it
 * pins `addonId: 'homeassistant-export'` on the cap calls it makes back. The
 * provider half runs the opposite direction (camstack → HA over the WebSocket,
 * authenticated by HA's own long-lived token, nothing to do with this grant) and
 * is `instanceMode: 'multiple'`, so declaring the descriptor there would produce
 * one copy per broker instance and none at all for an operator who only exports.
 * One integration, one declaration, from the addon whose counterpart consumes it.
 *
 * **Availability consequence, stated rather than discovered.** Linking now
 * requires `homeassistant-export` to be installed and its runner up. Between hub
 * start and that moment the id is genuinely absent — `/api/oauth2/authorize`
 * answers `503 temporarily_unavailable` naming this addon rather than
 * `400 unknown integration`, and `/api/oauth2/integrations` reports
 * `complete: false`. See D101.
 *
 * Design: `docs/design/2026-08-08-ha-oauth-onboarding.md`.
 */

/**
 * Where a Home Assistant lands after consent.
 *
 * `my.home-assistant.io` is the bounce Home Assistant uses when its `my`
 * component is loaded; it is a fixed public origin and needs nothing special.
 * The other shape is `http://<the operator's own HA>:8123/auth/external/callback`,
 * whose host the hub cannot know in advance — that one is admitted by
 * `allowedPrivateHostPaths`, which matches the PATH exactly and demands a
 * private host, so it is not a wildcard prefix wearing a hat.
 */
const HA_MY_REDIRECT_PREFIX = 'https://my.home-assistant.io/redirect/oauth'
const HA_LOCAL_CALLBACK_PATH = '/auth/external/callback'

/**
 * What a linked Home Assistant NEEDS to function — one entry per thing it
 * actually calls with this token, each named. Not a blast radius, not a
 * conservative under-declaration: `requestedScopes` has exactly one meaning
 * across every integration, and since D103 it is also the ENFORCEMENT input, so
 * an under-declaration is an integration that stops working.
 *
 * `category:system [create]` was rejected and stays rejected: it would hand
 * `addons.installPackage` to a home-automation bridge.
 */
export const HOME_ASSISTANT_OAUTH_INTEGRATION: OauthIntegrationDescriptor = {
  integrationId: 'homeassistant',
  displayName: 'Home Assistant',
  requestedScopes: [
    // snapshot.getSnapshot, webrtcSession.* — and every future per-camera cap,
    // which should reach the bridge without forcing the operator to re-link.
    { type: 'category', target: 'device', access: ['view', 'create'] },
    // deviceManager.listAll
    { type: 'capability', target: 'device-manager', access: ['view'] },
    // deviceState.getAllSnapshots
    { type: 'capability', target: 'device-state', access: ['view'] },
    // pipelineOrchestrator.getCameraStatuses
    { type: 'capability', target: 'pipeline-orchestrator', access: ['view', 'create'] },
    /**
     * `deviceExport.listExposedDevices` — the membership read that decides WHICH
     * devices the component imports. It is pinned to this addon so the unpinned
     * aggregate (which merges Alexa's and HomeKit's exposed sets, D12) cannot
     * leak another exporter's devices into Home Assistant.
     *
     * Missing until 2026-08-09, which broke setup outright: the component's very
     * first authenticated call is this one, and the hub answered "rejected the
     * token" — reported by Home Assistant as `Configurazione non riuscita:
     * deviceExport.listExposedDevices: hub rejected the token`. The call was
     * introduced with the export filter and the descriptor was never widened for
     * it. `system` scope, so a capability grant is what it needs — the `addon:`
     * grant below covers the HTTP command route and does NOT cover this.
     */
    { type: 'capability', target: 'device-export', access: ['view'] },
    /**
     * `POST /addon/homeassistant-export/command` — the ONLY path by which an
     * actuated Home Assistant entity (a camera switch, a PTZ button, reboot,
     * snooze) reaches CamStack. Added when D103 made the addon-route gate check
     * the grant instead of accepting any valid hub JWT; without it every HA
     * control entity answers `403 Token scope mismatch`. `view` is here for the
     * same addon's future GET routes, so a read does not force a re-link.
     */
    { type: 'addon', target: 'homeassistant-export', access: ['view', 'create'] },
  ],
  allowedRedirectPrefixes: [HA_MY_REDIRECT_PREFIX],
  allowedPrivateHostPaths: [HA_LOCAL_CALLBACK_PATH],
  // The component is published source. There is no secret it could keep, so
  // PKCE is the only thing standing between an intercepted code and a token.
  requiresPkce: true,
  /**
   * One year. A Home Assistant config entry is meant to survive indefinitely
   * and re-linking is a manual trip through the UI, so the 30-day default
   * silently unlinked a working integration a month after setup. Finite rather
   * than `'never'` (which Alexa uses): an HA instance refreshes on a timer
   * while it is running, so a year is far beyond any realistic downtime, and a
   * bounded token is the better default where nothing is lost by it.
   */
  refreshTokenTtlSec: 365 * 24 * 60 * 60,
}
