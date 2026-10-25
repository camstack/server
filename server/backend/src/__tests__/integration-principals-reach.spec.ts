/**
 * The integrations keep exactly their reach under D921. Home Assistant, Alexa
 * and Google are fixed principals: their `requestedScopes` carry no viewer
 * row, so the method roles never apply to them. Each descriptor must still
 * reach every method its integration calls (listed in the descriptor's own
 * comments), and must NOT reach an administration method it never had.
 */
import type { UserScope } from '@camstack/types'
import { capabilityScopesOf } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { checkScopeAccess } from '../api/trpc/scope-access.js'
import { buildAlexaOauthIntegration } from '../../../../packages/addon-export-alexa/src/oauth-integration.js'
import { buildGoogleOauthIntegration } from '../../../../packages/addon-export-google/src/oauth-integration.js'
import { HOME_ASSISTANT_OAUTH_INTEGRATION } from '../../../../packages/addon-provider-homeassistant/src/ha-export/oauth-integration.js'

interface Call {
  readonly path: string
  readonly input: unknown
}

const CAMERA = 7
const DEVICE_CALLS: readonly Call[] = [
  { path: 'snapshot.getSnapshot', input: { deviceId: CAMERA } },
  { path: 'webrtcSession.createSession', input: { deviceId: CAMERA } },
  { path: 'switch.setState', input: { deviceId: CAMERA, on: true } },
  { path: 'motionTrigger.setMotionTrigger', input: { deviceId: CAMERA, enabled: true } },
]

/** A system administration method no integration was ever granted. */
const USER_ADMINISTRATION: Call = { path: 'userManagement.listUsers', input: {} }

function scopesOf(requested: readonly UserScope[]): readonly UserScope[] {
  return capabilityScopesOf(requested)
}

function reaches(scopes: readonly UserScope[], call: Call): boolean {
  return checkScopeAccess(scopes, call.path, call.input).ok
}

const CASES: ReadonlyArray<{
  readonly name: string
  readonly scopes: readonly UserScope[]
  readonly calls: readonly Call[]
}> = [
  {
    name: 'Home Assistant',
    scopes: scopesOf(HOME_ASSISTANT_OAUTH_INTEGRATION.requestedScopes),
    calls: [
      ...DEVICE_CALLS,
      { path: 'deviceManager.listAll', input: {} },
      { path: 'deviceState.getAllSnapshots', input: {} },
      { path: 'pipelineOrchestrator.getCameraStatuses', input: {} },
      { path: 'deviceExport.listExposedDevices', input: {} },
    ],
  },
  {
    name: 'Alexa',
    scopes: scopesOf(buildAlexaOauthIntegration(undefined).requestedScopes),
    calls: DEVICE_CALLS,
  },
  {
    name: 'Google',
    scopes: scopesOf(buildGoogleOauthIntegration().requestedScopes),
    calls: DEVICE_CALLS,
  },
]

describe('integration principals (D921: unchanged)', () => {
  for (const c of CASES) {
    it(`${c.name} carries no viewer row`, () => {
      expect(c.scopes.some((s) => s.type === 'viewer')).toBe(false)
    })

    it(`${c.name} still reaches every method it calls`, () => {
      for (const call of c.calls) expect(reaches(c.scopes, call), call.path).toBe(true)
    })

    it(`${c.name} does not reach user administration`, () => {
      expect(reaches(c.scopes, USER_ADMINISTRATION)).toBe(false)
    })
  }
})
