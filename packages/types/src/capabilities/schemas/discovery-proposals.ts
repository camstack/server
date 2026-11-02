import { z } from 'zod'
import { DiscoveryCandidateSchema } from '../device-provider.cap.js'

/**
 * What the passive listener of `local-network` saw on the wire, before any
 * provider classified it. Device-manager turns an observation into the hits
 * of the providers whose declared discovery modes it matches.
 */
export const DiscoveryObservationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mdns'),
    /** Normalised DNS-SD service type, e.g. `_esphomelib._tcp`. */
    serviceType: z.string(),
    instance: z.string(),
    host: z.string(),
    /** The A record address when the announcement carried one. */
    address: z.string().nullable(),
    port: z.number().int(),
    txt: z.record(z.string(), z.string()),
  }),
  z.object({
    kind: z.literal('ssdp'),
    /** Sender address of the datagram. */
    host: z.string(),
    port: z.number().int(),
    /** `NT` of a NOTIFY, `ST` of a search response. */
    target: z.string(),
    headers: z.record(z.string(), z.string()),
  }),
])
export type DiscoveryObservation = z.infer<typeof DiscoveryObservationSchema>

/** The persisted body of one proposal (record kind `discovery-proposals`). */
export type DiscoveryProposalBody = {
  /** The device-provider addon that can adopt the candidate. */
  addonId: string
  candidate: z.infer<typeof DiscoveryCandidateSchema>
  firstSeenAt: number
  lastSeenAt: number
  /** Dismissed stays dismissed when the device is seen again. */
  dismissed: boolean
}
export const DiscoveryProposalBodySchema: z.ZodType<DiscoveryProposalBody> = z.object({
  addonId: z.string(),
  candidate: DiscoveryCandidateSchema,
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
  dismissed: z.boolean(),
})

export type DiscoveryProposal = DiscoveryProposalBody & { id: string }
export const DiscoveryProposalSchema: z.ZodType<DiscoveryProposal> = z.object({
  id: z.string(),
  addonId: z.string(),
  candidate: DiscoveryCandidateSchema,
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
  dismissed: z.boolean(),
})
