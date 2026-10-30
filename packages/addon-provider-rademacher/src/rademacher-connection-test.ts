import {
  Rademacher,
  RademacherApiError,
  RademacherAuthError,
  RademacherTransportError,
} from '@apocaliss92/noderademacher'
import {
  type ConnectionTestOutcome,
  errMsg,
  type IConnectionTestProvider,
  type IScopedLogger,
} from '@camstack/types'

const TEST_LABEL = 'Logs in to the hub with this password, reads its identity, then disconnects'

/** What a successful probe learned about the hub. */
export interface RademacherProbeResult {
  readonly model: string | null
  readonly firmware: string | null
}

export interface RademacherProbeInput {
  readonly host: string
  readonly password: string
  readonly basePath: string
}

/** One login attempt against the real hub. HomePilot keeps no socket, so there is no session to close. */
export async function probeRademacherHub(
  input: RademacherProbeInput,
): Promise<RademacherProbeResult> {
  const client = new Rademacher({
    host: input.host,
    ...(input.password.length > 0 ? { password: input.password } : {}),
    ...(input.basePath.length > 0 ? { basePath: input.basePath } : {}),
  })
  await client.connect()
  const identity = client.getIdentity()
  return { model: identity?.model ?? null, firmware: identity?.firmware ?? null }
}

export interface RademacherConnectionTestDeps {
  readonly logger: IScopedLogger
  /** One login attempt. Defaults to the real hub probe. */
  readonly probe?: (input: RademacherProbeInput) => Promise<RademacherProbeResult>
}

/** Why a probe failed, as far as the error class and text tell. */
export type ProbeFailureKind = 'wrong-password' | 'not-a-hub' | 'unreachable' | 'other'

const NOT_A_HUB_TEXT = /no homepilot hub responded/i

export function classifyProbeFailure(err: unknown): { kind: ProbeFailureKind; text: string } {
  const text = errMsg(err)
  if (err instanceof RademacherAuthError) return { kind: 'wrong-password', text }
  if (err instanceof RademacherTransportError) return { kind: 'unreachable', text }
  if (err instanceof RademacherApiError) return { kind: 'other', text }
  if (NOT_A_HUB_TEXT.test(text)) return { kind: 'not-a-hub', text }
  return { kind: 'other', text }
}

export function buildRademacherConnectionTestProvider(
  deps: RademacherConnectionTestDeps,
): IConnectionTestProvider {
  const { logger, probe = probeRademacherHub } = deps

  return {
    describeTest: async () => ({ label: TEST_LABEL }),

    testSettings: async ({ settings }): Promise<ConnectionTestOutcome> => {
      const host = readString(settings, 'host')
      if (host === null) {
        return { outcome: 'rejected', error: 'Enter the hub host or IP address.' }
      }
      const password = readString(settings, 'password') ?? ''
      const basePath = readString(settings, 'basePath') ?? ''
      const startedAt = Date.now()
      try {
        const result = await probe({ host, password, basePath })
        const detail = [
          result.model,
          result.firmware === null ? null : `firmware ${result.firmware}`,
        ]
          .filter((part): part is string => part !== null)
          .join(', ')
        return {
          outcome: 'validated',
          latencyMs: Date.now() - startedAt,
          ...(detail.length > 0 ? { detail } : {}),
        }
      } catch (err) {
        const failure = classifyProbeFailure(err)
        logger.warn('Rademacher connection test failed', {
          meta: { host, kind: failure.kind, error: failure.text },
        })
        switch (failure.kind) {
          case 'wrong-password':
            return {
              outcome: 'rejected',
              error:
                password.length === 0
                  ? 'The hub is password-protected. Enter its password.'
                  : 'The hub refused the password.',
            }
          case 'not-a-hub':
            return {
              outcome: 'rejected',
              error: `${host} did not answer as a HomePilot or Start2Smart hub. Check the address and the API base path.`,
            }
          case 'unreachable':
            return { outcome: 'inconclusive', error: `Could not reach ${host}: ${failure.text}` }
          case 'other':
            return {
              outcome: 'inconclusive',
              error: `The hub test did not finish: ${failure.text}`,
            }
        }
      }
    },
  }
}

function readString(settings: unknown, key: string): string | null {
  if (settings === null || typeof settings !== 'object') return null
  const value = Reflect.get(settings, key)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
