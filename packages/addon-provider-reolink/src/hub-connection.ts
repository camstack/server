import { type ConfigUISchema, isSecretMarkerLike } from '@camstack/types'
import { z } from 'zod'
import { ReolinkSocketDebugFlagSchema } from './schema.js'

/** Baichuan control port a Reolink NVR / Home Hub listens on. */
export const REOLINK_HUB_DEFAULT_PORT = 9000

/** RTSP port of the hub's relay — never the Baichuan port. */
export const REOLINK_HUB_DEFAULT_RTSP_PORT = 554

/** Settings key that names the section holding the hub connection form. */
export const HUB_CONNECTION_SECTION_ID = 'connection'
export const HUB_DEBUG_SECTION_ID = 'hub-debug'

/** A blank form field is "not provided", never an invalid port. */
function blankToUndefined(value: unknown): unknown {
  return value === '' || value === null ? undefined : value
}

/**
 * The connection of ONE Reolink NVR / Home Hub: the settings of an INTEGRATION (D985). The
 * password is a schema `password` field kept in the keychain — never in env, argv or logs.
 */
export const reolinkHubConnectionSchema = z.object({
  host: z.string().trim().min(1).describe('NVR / Home Hub IP or hostname'),
  port: z.preprocess(
    blankToUndefined,
    z.number().int().min(1).max(65535).default(REOLINK_HUB_DEFAULT_PORT),
  ),
  /** The RTSP relay port the cameras dial for their streams (not the Baichuan `port`). */
  rtspPort: z.preprocess(
    blankToUndefined,
    z.number().int().min(1).max(65535).default(REOLINK_HUB_DEFAULT_RTSP_PORT),
  ),
  username: z.preprocess(blankToUndefined, z.string().trim().min(1).default('admin')),
  password: z.string().min(1).describe('NVR / Home Hub password').meta({ secret: true }),
  /** Hubs are TCP-only on supported firmwares — kept for symmetry with a camera. */
  transport: z.enum(['tcp', 'udp']).default('tcp'),
  /** UID of a hub that was paired by it; unused for a plain TCP login. */
  uid: z.string().optional(),
  debugGeneral: z.boolean().default(false),
  debugSocketLogs: z.array(ReolinkSocketDebugFlagSchema).default([]),
})

export type ReolinkHubConnection = z.infer<typeof reolinkHubConnectionSchema>

/**
 * What an integration's settings say about its hub. A locked secret reads as its marker and is
 * NEVER treated as an empty password: the session must not dial with a marker, and must not
 * mint a replacement either.
 */
export type HubConnectionRead =
  | { readonly kind: 'ok'; readonly connection: ReolinkHubConnection }
  | { readonly kind: 'no-host' }
  | { readonly kind: 'no-password' }
  | { readonly kind: 'password-locked' }

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function readHubConnection(settings: Readonly<Record<string, unknown>>): HubConnectionRead {
  if (stringValue(settings['host']).length === 0) return { kind: 'no-host' }
  const password = settings['password']
  if (isSecretMarkerLike(password)) return { kind: 'password-locked' }
  if (typeof password !== 'string' || password.length === 0) return { kind: 'no-password' }
  const parsed = reolinkHubConnectionSchema.safeParse(settings)
  if (!parsed.success) return { kind: 'no-host' }
  return { kind: 'ok', connection: parsed.data }
}

/** Two reads that would dial the same way. */
export function sameHubConnection(a: ReolinkHubConnection, b: ReolinkHubConnection): boolean {
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.rtspPort === b.rtspPort &&
    a.username === b.username &&
    a.password === b.password &&
    a.transport === b.transport &&
    a.uid === b.uid
  )
}

/**
 * The connection + debug sections of the integration form. Fields are NOT `required` here:
 * the same schema is the addon's own settings page, where a required host would block saving
 * an unrelated email-push change on the default integration. A hub integration missing its
 * host or password is named by the session at reconcile time instead.
 */
export function buildHubConnectionSections(): ConfigUISchema {
  return {
    sections: [
      {
        id: HUB_CONNECTION_SECTION_ID,
        title: 'NVR / Home Hub connection',
        titleKey: 'provider-reolink:connection.s_connection.title',
        description:
          'Only for an integration that is one NVR or Home Hub. Its channels are adopted as cameras that share this connection.',
        descriptionKey: 'provider-reolink:connection.s_connection.description',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'host',
            label: 'Hub IP',
            labelKey: 'provider-reolink:connection.s_connection.host.label',
            placeholder: '192.168.10.100',
          },
          {
            type: 'number',
            key: 'port',
            label: 'Port',
            labelKey: 'provider-reolink:connection.s_connection.port.label',
            default: REOLINK_HUB_DEFAULT_PORT,
            min: 1,
            max: 65535,
            step: 1,
          },
          {
            type: 'number',
            key: 'rtspPort',
            label: 'RTSP port',
            labelKey: 'provider-reolink:connection.s_connection.rtspPort.label',
            default: REOLINK_HUB_DEFAULT_RTSP_PORT,
            min: 1,
            max: 65535,
            step: 1,
          },
          {
            type: 'text',
            key: 'username',
            label: 'Username',
            labelKey: 'provider-reolink:connection.s_connection.username.label',
            default: 'admin',
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-reolink:connection.s_connection.password.label',
            showToggle: true,
          },
        ],
      },
      {
        id: HUB_DEBUG_SECTION_ID,
        title: 'NVR / Home Hub debug',
        titleKey: 'provider-reolink:connection.s_hub-debug.title',
        description: 'Debug logging adds log volume; use it temporarily.',
        descriptionKey: 'provider-reolink:connection.s_hub-debug.description',
        columns: 1,
        fields: [
          {
            type: 'boolean',
            key: 'debugGeneral',
            label: 'General debug logs',
            labelKey: 'provider-reolink:connection.s_hub-debug.debugGeneral.label',
            default: false,
            style: 'switch',
          },
          {
            type: 'multiselect',
            key: 'debugSocketLogs',
            label: 'Socket trace categories',
            labelKey: 'provider-reolink:connection.s_hub-debug.debugSocketLogs.label',
            description: 'Each area adds log volume.',
            descriptionKey: 'provider-reolink:connection.s_hub-debug.debugSocketLogs.description',
            default: [],
            options: [
              {
                value: 'traceEvents',
                label: 'Events (cmd 33 — AlarmEventList push)',
                labelKey:
                  'provider-reolink:connection.s_hub-debug.debugSocketLogs.o_traceEvents.label',
              },
            ],
          },
        ],
      },
    ],
  }
}

/** What tells a hub integration from the default one. */
export interface HubIntegrationEvidence {
  readonly originStableId?: string | undefined
  readonly info: Readonly<Record<string, unknown>>
  readonly settings: Readonly<Record<string, unknown>>
}

/**
 * `true` for an integration that IS one NVR / Home Hub: it was set up from a hub candidate, was
 * migrated from a Hub device, or carries a host. The default integration (standalone cameras,
 * email push, webhook, clips) has none of the three.
 */
export function isHubIntegration(evidence: HubIntegrationEvidence): boolean {
  if (evidence.originStableId?.startsWith('reolink-hub-') === true) return true
  if (evidence.info['migratedFromHubDeviceId'] !== undefined) return true
  return stringValue(evidence.settings['host']).length > 0
}

/** The form of a hub integration: its connection and debug sections, nothing of the addon's own. */
export function buildHubInstanceSchema(): ConfigUISchema {
  return buildHubConnectionSections()
}
