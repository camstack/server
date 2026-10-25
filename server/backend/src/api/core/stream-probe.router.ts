/**
 * Stream probe router — fixed core API (not a capability).
 *
 * Thin wrapper over `StreamProbeService` (backend REAL_LOGIC: ffprobe +
 * HTTP probes + 1h cache). Not pluggable: there is exactly one stream
 * probe implementation shipping with the server.
 *
 * Previously these endpoints lived under `streaming.probeStream` — moved
 * here as part of eliminating the `streaming` aggregator capability.
 */
import { z } from 'zod'
import { classifyStream } from '@camstack/types'
import type { StreamProbeService } from '../../core/streaming/stream-probe.service.js'
import { trpcRouter, adminProcedure } from '../trpc/trpc.middleware.js'

const ProbedStreamSchema = z.object({
  width: z.number().optional(),
  height: z.number().optional(),
  codec: z.string().optional(),
  fps: z.number().optional(),
  bitrateKbps: z.number().optional(),
  quality: z.enum(['high', 'mid', 'low']),
})

const FieldProbeResultSchema = z.object({
  status: z.enum(['ok', 'error']),
  labels: z.array(z.string()).optional(),
  error: z.string().optional(),
})

export function createStreamProbeRouter(sp: StreamProbeService | null) {
  return trpcRouter({
    probe: adminProcedure
      .input(z.object({ url: z.string(), force: z.boolean().optional() }))
      .output(ProbedStreamSchema)
      .mutation(async ({ input }) => {
        if (!sp) throw new Error('StreamProbeService not available')
        const metadata = await sp.probe(input.url, { force: input.force })
        return { ...metadata, quality: classifyStream(metadata) }
      }),
    /**
     * Generic field probe — decides stream vs HTTP reachability based on
     * the field key (keys starting with `stream` trigger ffprobe;
     * everything else falls back to an HTTP GET that aborts at headers).
     * Wraps `StreamProbeService.probeField` — used by device providers
     * that need the kernel's probe without re-implementing ffprobe /
     * HTTP fetch in every addon.
     */
    probeField: adminProcedure
      .input(z.object({ key: z.string(), value: z.unknown() }))
      .output(FieldProbeResultSchema)
      .mutation(async ({ input }) => {
        if (!sp) throw new Error('StreamProbeService not available')
        return sp.probeField(input.key, input.value)
      }),
  })
}
