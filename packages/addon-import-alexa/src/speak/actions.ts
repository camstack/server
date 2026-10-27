import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'
import { ALEXA_REGIONS, SPEECH_MAX_CHARS } from './constants.js'
import { EchoDeviceSchema, LoginStatusSchema, SessionStatusSchema } from './worker-protocol.js'

export const SpeakStatusSchema = z.object({
  phase: z.enum(['sign-in', 'otp', 'captcha', 'devices']),
  email: z.string(),
  region: z.enum(ALEXA_REGIONS),
  devices: z.array(EchoDeviceSchema),
  session: SessionStatusSchema,
})

export const LoginResultSchema = z.object({
  status: LoginStatusSchema,
  error: z.string().optional(),
})

export const alexaSpeakActions = defineCustomActions({
  speakStatus: customAction(z.object({}), SpeakStatusSchema, { kind: 'mutation', auth: 'admin' }),
  loginStart: customAction(
    z.object({
      email: z.string().min(1),
      password: z.string().min(1).meta({ secret: true }),
      region: z.enum(ALEXA_REGIONS),
    }),
    LoginResultSchema,
    { kind: 'mutation', auth: 'admin' },
  ),
  loginOtp: customAction(z.object({ code: z.string().min(1).max(12) }), LoginResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  sendTest: customAction(
    z.object({
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
