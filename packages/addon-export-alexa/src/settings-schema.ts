/**
 * The Alexa export's settings page — the exporter page pattern:
 *
 *   Connection        how the skill reaches this hub (open)
 *   Features          what each exposed camera carries (open)
 *   Account link      who is linked, and the one way to unlink (open)
 *   Troubleshooting   one-off repairs (collapsed)
 *   Custom-skill security   the ingress token — custom skill only (collapsed)
 *
 * Every action is an `addon-action-button`, which shows the result or the
 * error under the button. A row that belongs to the custom skill carries
 * `showWhen: skillMode = custom` rather than being left out at build time, so
 * the form reacts the moment the operator switches mode (no save, no reload);
 * a section whose rows are all hidden is not drawn at all. Pure: the addon
 * passes its config in.
 */
import type { ConfigCondition, ConfigField, ConfigSection } from '@camstack/types'
import { buildLinkStatusContent } from './link-status.js'
import type { LinkedAccount, LwaTokenEntry } from './types.js'

const ADDON_ID = 'export-alexa'

/** The rows that exist only for a custom skill. */
const CUSTOM_SKILL_ONLY: ConfigCondition = { field: 'skillMode', equals: 'custom' }

export interface AlexaSettingsPageInput {
  readonly linkedAccounts: readonly LinkedAccount[]
  readonly tokens: readonly LwaTokenEntry[]
  readonly now: number
  /** Field defaults, from the addon's `DEFAULT_CONFIG`. */
  readonly defaults: {
    readonly skillMode: string
    readonly region: string
    readonly expectedAudience: string
    readonly publicHubUrl: string
    readonly detectionSensors: boolean
    readonly objectDetection: boolean
    readonly snapshots: boolean
    readonly enforceIngressToken: boolean
  }
}

const CONNECTION_DESCRIPTION = [
  'Public skill (default): enable the "CamStack" skill in the Alexa app and link your account. No Amazon developer setup is needed.',
  "Custom skill: enter your skill id and deploy the skill Lambda from this addon's lambda-template in your own AWS account.",
  "Either way the skill's Lambda keeps the Amazon credentials (in a custom skill, in your SSM Parameter Store); this hub holds none. It receives short-lived event tokens from the Lambda's token broker with a credential unique to this link.",
  'This hub must be reachable from the internet over HTTPS (Cloudflare Tunnel, Tailscale Funnel, …). The external address below is the one the skill calls back on.',
].join('\n')

function connectionSection(input: AlexaSettingsPageInput): ConfigSection {
  const { defaults } = input
  const fields: ConfigField[] = [
    {
      type: 'select',
      key: 'skillMode',
      label: 'Alexa skill',
      description:
        'Public: the built-in CamStack skill. Custom: your own skill and your own copy of the skill Lambda.',
      options: [
        { value: 'public', label: 'Public (built-in CamStack skill)' },
        { value: 'custom', label: 'Custom skill' },
      ],
      default: defaults.skillMode,
    },
    // Region drives the Event Gateway endpoint and is required in BOTH modes.
    // EVERY proactive post goes there — doorbell presses, motion,
    // online/offline and state changes and the discovery Add/DeleteReports —
    // so a wrong region silently drops all of them, not just the doorbell.
    {
      type: 'select',
      key: 'region',
      label: 'Skill region',
      description:
        'The Alexa Event Gateway this hub posts to: doorbell presses, motion, camera online/offline and state changes, and the device-list updates sent when you expose or unexpose a camera. Pick the region your Amazon account is in — events sent to another region are rejected.',
      options: [
        { value: 'NA', label: 'North America' },
        { value: 'EU', label: 'Europe' },
        { value: 'FE', label: 'Far East' },
      ],
      default: defaults.region,
    },
    {
      type: 'text',
      key: 'expectedAudience',
      label: 'Alexa skill id',
      description:
        "Your skill's id, format amzn1.ask.skill.xxxx, from the Alexa developer console. Directives for any other skill are refused.",
      default: defaults.expectedAudience,
      showWhen: CUSTOM_SKILL_ONLY,
    },
    {
      type: 'addon-action-select',
      key: 'publicHubUrl',
      label: 'External address',
      description:
        'The HTTPS address the skill reaches this hub on, read live from the connected remote-access providers each time this page opens. Defaults to the first one detected; a saved choice that is no longer detected stays selected until you change it.',
      addonId: ADDON_ID,
      action: 'listExternalAddresses',
      mapOption: { value: 'value', label: 'label' },
      emptyResultsMessage:
        'No external HTTPS address detected. Set up remote access (Cloudflare Tunnel, Tailscale Funnel, …), then reopen this page.',
      default: defaults.publicHubUrl,
    },
  ]
  return {
    id: 'export-alexa-connection',
    title: 'Connection',
    description: CONNECTION_DESCRIPTION,
    columns: 1,
    fields,
  }
}

function featuresSection(input: AlexaSettingsPageInput): ConfigSection {
  const { defaults } = input
  return {
    id: 'export-alexa-features',
    title: 'Features',
    columns: 1,
    fields: [
      {
        type: 'boolean',
        key: 'detectionSensors',
        label: 'Detection sensors',
        description:
          'Master switch for the detection sensors: Alexa motion sensors named "<camera> Person", "Vehicle", "Animal" or "Package", usable as routine triggers (for example: when Front door Package detects motion, announce on the Echo devices). Which classes each camera sends is chosen on the camera\'s Export tab — none by default, and only the classes its pipeline detects. They report only "detected", no images. Off removes every one of them from Alexa.',
        default: defaults.detectionSensors,
      },
      {
        type: 'boolean',
        key: 'objectDetection',
        label: 'Object detection (experimental)',
        description:
          'Each exposed camera reports person and package detections to Alexa as events, with an event history on the camera in the Alexa app and, where Alexa supports it, "person detected" announcements. Amazon documents this for US English only; it is on to find out what other languages do with it. If Alexa stops showing a camera, turn this off: the cameras are sent again without it. Images follow the Snapshots switch. Each camera can also be turned off on its Export tab.',
        default: defaults.objectDetection,
      },
      {
        type: 'boolean',
        key: 'snapshots',
        label: 'Snapshots in the Alexa app',
        description:
          "Show each exposed camera's latest still on its tile in the Alexa app. While this is on, Amazon fetches still images of your cameras (re-encoded to about 480 px, each link valid ten minutes and only with your account's token). Off removes the feature from Alexa and invalidates every link already handed out. The external address must be set.",
        default: defaults.snapshots,
      },
    ],
  }
}

function accountLinkSection(input: AlexaSettingsPageInput): ConfigSection {
  return {
    id: 'export-alexa-account',
    title: 'Account link',
    columns: 1,
    fields: [
      // Derived, never stored: rendered from `linkedAccounts` + `tokens` on
      // every schema read.
      {
        type: 'info',
        key: '__alexa-link-status',
        label: 'Status',
        variant: 'info',
        content: buildLinkStatusContent({
          linkedAccounts: input.linkedAccounts,
          tokens: input.tokens,
          now: input.now,
        }),
      },
      // D104: unlinking stays on the page, and here — it is the ONLY way to
      // sever the link (the account-linking token never expires).
      {
        type: 'addon-action-button',
        addonId: ADDON_ID,
        key: '__unlink-alexa-accounts',
        label: 'Unlink Amazon account',
        description:
          'Revokes every Alexa account-link session on this hub and discards the stored Amazon push grant. Live view, voice control and proactive events stop immediately. The account-linking token never expires on its own, so this is the only way to sever the link. Re-link from the Alexa app afterwards; a new link also picks up widened permissions.',
        buttonLabel: 'Unlink now',
        action: 'unlinkAlexaAccounts',
        variant: 'danger',
        confirmMessage:
          'Unlink the Amazon account? Alexa loses access to your cameras immediately and you must re-link from the Alexa app to restore it.',
        successMessage:
          'Unlinked: {revokedSessions} session(s) revoked, {removedAccounts} linked account(s) removed. Re-link from the Alexa app to restore.',
      },
    ],
  }
}

function troubleshootingSection(): ConfigSection {
  return {
    id: 'export-alexa-troubleshooting',
    title: 'Troubleshooting',
    style: 'accordion',
    defaultCollapsed: true,
    columns: 1,
    fields: [
      {
        type: 'addon-action-button',
        addonId: ADDON_ID,
        key: '__resync-discovery',
        label: 'Re-sync devices',
        description:
          'Sends every exposed device to Alexa again, and removes from Alexa the devices you stopped exposing whose removal did not get through. Devices normally sync on their own; use this when the Alexa app disagrees with the exposed list. Needs a linked account. Safe to repeat.',
        buttonLabel: 'Re-sync now',
        action: 'resyncDiscovery',
        variant: 'default',
        successMessage:
          'Sent {endpointCount} endpoint(s) of {deviceCount} device(s) to {accountCount} account(s). Removed {removedEndpointCount} endpoint(s) of unexposed devices; {retainedEndpointCount} still pending. Failed deliveries: {failedCount} (see the addon log).',
      },
      {
        type: 'addon-action-button',
        addonId: ADDON_ID,
        key: '__remove-alexa-endpoints',
        label: 'Remove ids from Alexa',
        description:
          'For a device the Alexa app still shows that this hub no longer knows about (left over from an earlier link or addon version). You type the Alexa endpoint ids when you press the button: a camera is its device id ("54"), its parts add a suffix ("54__privacy", "54__98"). Removing an endpoint also removes it from any Alexa routine that uses it.',
        buttonLabel: 'Remove ids…',
        action: 'removeAlexaEndpoints',
        variant: 'danger',
        prompt: {
          param: 'endpointIds',
          title: 'Remove ids from Alexa',
          message:
            'Endpoint ids separated by commas or spaces. Each linked Alexa account is sent a delete for them.',
          placeholder: '54, 54__privacy',
        },
        successMessage: 'Removed {requested} id(s) from {deliveredAccounts} linked account(s).',
      },
      {
        type: 'addon-action-button',
        addonId: ADDON_ID,
        key: '__rotate-broker-credential',
        label: 'Rotate broker credential',
        description:
          "Replaces the credential this hub uses at the skill's token broker with a fresh one; the old one stops working immediately. Use it if a backup of this hub's settings may have leaked. Re-linking also issues a fresh one.",
        buttonLabel: 'Rotate credential',
        action: 'rotateBrokerCredential',
        variant: 'default',
        successMessage: 'Rotated {rotated} credential(s); {failed} failed (see the addon log).',
      },
    ],
  }
}

/** Custom skill only: the public skill's shared Lambda sends one ingress token
 *  for every hub (`HUB_INGRESS_TOKEN`), so a per-hub token cannot apply to it. */
function customSkillSecuritySection(input: AlexaSettingsPageInput): ConfigSection {
  return {
    id: 'export-alexa-custom-security',
    title: 'Custom-skill security',
    style: 'accordion',
    defaultCollapsed: true,
    columns: 1,
    fields: [
      {
        type: 'info',
        key: '__ingress-token-info',
        label: 'Ingress token',
        variant: 'info',
        showWhen: CUSTOM_SKILL_ONLY,
        content:
          'An optional shared secret your skill Lambda sends on every call to this hub. Show it, put it in the Lambda\'s HUB_INGRESS_TOKEN environment variable, then turn on "Require ingress token". After a rotation, update the Lambda.',
      },
      {
        type: 'addon-action-button',
        addonId: ADDON_ID,
        key: '__reveal-ingress-token',
        label: 'Show ingress token',
        description: 'Administrators only. Shows the current token once, here.',
        buttonLabel: 'Show ingress token',
        action: 'revealIngressToken',
        variant: 'default',
        successMessage: 'Ingress token: {ingressToken}',
        showWhen: CUSTOM_SKILL_ONLY,
      },
      {
        type: 'addon-action-button',
        addonId: ADDON_ID,
        key: '__regenerate-ingress-token',
        label: 'Rotate ingress token',
        description:
          "Generates a new ingress token; the old one stops working. Update your Lambda's HUB_INGRESS_TOKEN afterwards.",
        buttonLabel: 'Regenerate token',
        action: 'regenerateIngressToken',
        variant: 'default',
        successMessage: 'New ingress token: {ingressToken} — put it in HUB_INGRESS_TOKEN now.',
        confirmMessage:
          'Rotate the ingress token? With "Require ingress token" on, the Lambda is refused until you update HUB_INGRESS_TOKEN.',
        showWhen: CUSTOM_SKILL_ONLY,
      },
      {
        type: 'boolean',
        key: 'enforceIngressToken',
        label: 'Require ingress token',
        description:
          'When on, this hub refuses skill calls without the matching token. Turn it on only after HUB_INGRESS_TOKEN is set in your Lambda.',
        default: input.defaults.enforceIngressToken,
        showWhen: CUSTOM_SKILL_ONLY,
      },
    ],
  }
}

export function buildAlexaSettingsSections(input: AlexaSettingsPageInput): ConfigSection[] {
  return [
    connectionSection(input),
    featuresSection(input),
    accountLinkSection(input),
    troubleshootingSection(),
    customSkillSecuritySection(input),
  ]
}
