import {
  errMsg,
  type IConnectionTestProvider,
  type IKernelStreamProbe,
  type IScopedLogger,
} from '@camstack/types'

/**
 * `connection-test` cap provider for the generic RTSP integration — the
 * stream-URL probe, now DECLARED.
 *
 * This behaviour used to live in the backend as the DEFAULT branch of
 * `integrations.testConnection`: anything that was not broker-backed had its
 * settings scanned for `main_stream_url ?? url` and ffprobed. That made a
 * camera-shaped test the universal fallback, so every account integration in
 * the system (Dreo, Dreame, Tuya, PetKit) was answered with "No stream URL
 * provided" — a sentence about a field they have never had.
 *
 * The probe itself was never the problem; being the default was. It lives here
 * now, reached because THIS addon declares it, and it answers only about the
 * settings this addon actually understands.
 *
 * Note the asymmetry with the cloud providers: an RTSP integration carries no
 * account, so a settings blob with no URL in it is `inconclusive`, not
 * `rejected` — there is nothing to be wrong about yet, and blocking creation
 * over it would make the standalone "create then add cameras" flow impossible.
 */

/** Settings keys a stream URL may arrive under, oldest first. */
const URL_KEYS = ['main_stream_url', 'url'] as const

export interface RtspConnectionTestDeps {
  /** Kernel stream probe (`ctx.kernel.streamProbe`), or null when unavailable. */
  readonly getStreamProbe: () => IKernelStreamProbe | null
  readonly logger: IScopedLogger
}

const TEST_LABEL = 'Probes the RTSP stream URL, when the integration carries one'

function firstUrl(settings: Record<string, unknown>): string | null {
  for (const key of URL_KEYS) {
    const value = settings[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

export function buildRtspConnectionTestProvider(
  deps: RtspConnectionTestDeps,
): IConnectionTestProvider {
  const { getStreamProbe, logger } = deps

  return {
    describeTest: async () => ({ label: TEST_LABEL }),

    testSettings: async ({ settings }) => {
      const url = firstUrl(settings)
      if (url === null) {
        return {
          outcome: 'inconclusive',
          error:
            'This RTSP integration carries no stream URL to probe — cameras are ' +
            'added (and their URLs probed) after it is created.',
        }
      }

      const probe = getStreamProbe()
      if (probe === null) {
        logger.warn('RTSP connection test: kernel streamProbe unavailable')
        return {
          outcome: 'inconclusive',
          error: 'The kernel stream probe is unavailable — the URL was not tested.',
        }
      }

      const startedAt = Date.now()
      try {
        const result = await probe.probeField('main_stream_url', url)
        if (result.status === 'ok') {
          return {
            outcome: 'validated',
            latencyMs: Date.now() - startedAt,
            ...(result.labels && result.labels.length > 0
              ? { detail: result.labels.join(' · ') }
              : {}),
          }
        }
        // The probe reached a verdict about THIS url — an observed refusal.
        return {
          outcome: 'rejected',
          error: result.error ?? 'No streams found at that URL',
        }
      } catch (err: unknown) {
        logger.warn('RTSP connection test: probe could not complete', {
          meta: { error: errMsg(err) },
        })
        return {
          outcome: 'inconclusive',
          error: `The stream probe could not complete: ${errMsg(err)}`,
        }
      }
    },
  }
}
