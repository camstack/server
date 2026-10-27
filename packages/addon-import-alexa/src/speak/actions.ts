import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'
import { SPEECH_MAX_CHARS } from './constants.js'
import { EchoDeviceSchema, SessionStatusSchema } from './worker-protocol.js'

export const BrokerEchoStateSchema = z.enum(['starting', 'ready', 'broker-not-signed-in', 'failed'])

export const SpeakBrokerStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: BrokerEchoStateSchema,
  error: z.string().optional(),
  devices: z.array(EchoDeviceSchema),
  session: SessionStatusSchema,
})

export const SpeakStatusSchema = z.object({
  brokers: z.array(SpeakBrokerStatusSchema),
  /** Targets that name no Amazon account yet (they cannot speak until one is chosen). */
  unassignedTargets: z.number().int().nonnegative(),
  /** What the old standalone login left behind, named; '' when nothing is pending. */
  notice: z.enum(['', 'no-broker', 'choose-broker']),
})
export type SpeakStatus = z.infer<typeof SpeakStatusSchema>

export const alexaSpeakActions = defineCustomActions({
  speakStatus: customAction(z.object({}), SpeakStatusSchema, { kind: 'mutation', auth: 'admin' }),
  sendTest: customAction(
    z.object({
      brokerId: z.string().min(1),
      echoIds: z.array(z.string().min(1)).min(1),
      mode: z.enum(['speak', 'announce']),
      volume: z.number().int().min(0).max(100),
      text: z.string().min(1).max(SPEECH_MAX_CHARS),
    }),
    z.object({
      outcomes: z.array(
        z.object({
          echoId: z.string(),
          ok: z.boolean(),
          error: z.string().optional(),
        }),
      ),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
})
