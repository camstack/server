import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * `connection-test` — pre-creation validation of an integration's settings,
 * system-scoped collection (one provider per integration addon).
 *
 * ── Why this cap exists ─────────────────────────────────────────────────────
 *
 * Before it, `integrations.testConnection` had exactly two behaviours: a broker
 * branch (`settings.brokerId` → `broker.testConnection`) and a DEFAULT branch
 * that probed `settings.main_stream_url ?? settings.url` with ffprobe. Every
 * account-based integration — Dreo, Dreame, Tuya, Petkit, Wyze — fell into that
 * default and was told `{"success":false,"error":"No stream URL provided"}`.
 * That answer neither validated nor refused anything, so:
 *
 *   - the Test button had NEVER worked for an account integration, and
 *   - `integrations.create` had nothing to gate on, so an integration with a
 *     wrong password was created happily and failed later, silently, at
 *     reconcile time.
 *
 * The structural gap was that at CREATE time the integration does not exist
 * yet: there is no `integrationId`, no `brokerId`, no live client — and every
 * existing provider surface (`device-provider`, `device-adoption`) is keyed by
 * one of those. There was no way to ask "are these settings valid?" before the
 * row existed.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 *
 * The provider knows how to validate its OWN settings. The framework does not
 * guess from the shape of the settings — a stream-URL probe is one provider's
 * implementation of this cap, not the universal fallback. A provider that does
 * not register this cap is a KNOWN "cannot validate", never a silent pass.
 *
 * `testSettings` takes the candidate settings blob exactly as the wizard's
 * config step collected it (the same blob that would be handed to
 * `integrations.create`), and MUST NOT persist anything, mint an integration,
 * or mutate live state. It opens a throwaway session, asks, and closes it.
 *
 * ── The three outcomes are NOT interchangeable ──────────────────────────────
 *
 * This is the whole point of the discriminated union: a `null` from a timeout
 * must never look like a `null` from a refusal.
 *
 *   - `validated`    — the remote ACCEPTED these credentials. Observed.
 *   - `rejected`     — the remote REFUSED these credentials. Observed.
 *                      This is the ONLY outcome that blocks creation.
 *   - `inconclusive` — the check could not complete (DNS, timeout, 5xx, an
 *                      unexpected shape). NOTHING was observed about the
 *                      credentials. Never rendered, or counted, as a failure.
 *
 * A provider that cannot tell a refusal from a transport fault must return
 * `inconclusive`. Guessing `rejected` would block creation on a flaky network;
 * guessing `validated` would wave a wrong password through.
 */

/** Ceiling on how long a pre-creation probe may hold the wizard. */
export const CONNECTION_TEST_TIMEOUT_MS = 20_000

export const ConnectionTestOutcomeSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('validated'),
      /** Round-trip of the sign-in, when the provider measured it. */
      latencyMs: z.number().nonnegative().optional(),
      /** Optional human detail worth showing next to the tick
       *  ("3 devices visible on this account"). */
      detail: z.string().optional(),
    })
    // `.strict()` so a stray `error` can never ride along on a success —
    // the same guard `broker.testSettings` carries.
    .strict(),
  z.object({ outcome: z.literal('rejected'), error: z.string() }).strict(),
  z.object({ outcome: z.literal('inconclusive'), error: z.string() }).strict(),
])

export type ConnectionTestOutcome = z.infer<typeof ConnectionTestOutcomeSchema>

export const ConnectionTestInputSchema = z.object({
  /** Candidate integration settings, exactly as the create form collected them. */
  settings: z.record(z.string(), z.unknown()),
})

/**
 * What the provider's test actually DOES, so the UI can say it in words before
 * the operator presses the button ("Signs in to the Dreo cloud"). Purely
 * descriptive — it never changes routing.
 */
export const ConnectionTestDescriptorSchema = z.object({
  label: z.string(),
})

export const connectionTestCapability = {
  name: 'connection-test',
  scope: 'system',
  mode: 'collection',
  methods: {
    testSettings: method(ConnectionTestInputSchema, ConnectionTestOutcomeSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    describeTest: method(z.void(), ConnectionTestDescriptorSchema, { auth: 'admin' }),
  },
} as const satisfies CapabilityDefinition

export type IConnectionTestProvider = InferProvider<typeof connectionTestCapability>
