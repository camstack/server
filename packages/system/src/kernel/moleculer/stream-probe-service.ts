/**
 * Hub-side `$stream-probe` Moleculer service. Exposes the same two
 * operations the tRPC `streamProbe` router does — `probe(url, force?)`
 * and `probeField(key, value)` — but via a broker action name so that
 * forked workers / remote agents reach it through the already-wired
 * Moleculer transport without needing the HTTPS tRPC WSS link.
 *
 * Why not reuse the tRPC router? Workers default to
 * `brokerTransportLink` when `CAMSTACK_HUB_API_URL` isn't set; the link
 * naively maps every `op.path` to `<addonId>.<capName>.<method>` and
 * fails with "Service not found" for core (non-capability) routers.
 * `$stream-probe` is the canonical cross-process entrypoint — the
 * browser still reaches the tRPC flavour via HTTPS for the "Test"
 * button, but provider addons use this service so auto-profile
 * classification works from any forked worker.
 *
 * The service name is prefixed with `$` so it doesn't show up in the
 * addon / capability graph (same convention as `$hub`, `$readiness`).
 */
import type { ServiceSchema, Context } from 'moleculer'
import type { StreamMetadata, FieldProbeResult, IKernelStreamProbe } from '@camstack/types'

/**
 * Hub-side dependencies for the `$stream-probe` broker service.
 * Matches `IKernelStreamProbe` exactly so the same function references
 * are reused for hub-direct injection and worker broker routing.
 */
export type StreamProbeBrokerDeps = IKernelStreamProbe

export function createStreamProbeBrokerService(deps: StreamProbeBrokerDeps): ServiceSchema {
  return {
    name: '$stream-probe',
    actions: {
      probe: {
        async handler(ctx: Context<{ url: string; force?: boolean }>): Promise<StreamMetadata> {
          return deps.probe(ctx.params.url, { force: ctx.params.force ?? false })
        },
      },
      probeField: {
        async handler(ctx: Context<{ key: string; value: unknown }>): Promise<FieldProbeResult> {
          return deps.probeField(ctx.params.key, ctx.params.value)
        },
      },
    },
  }
}
