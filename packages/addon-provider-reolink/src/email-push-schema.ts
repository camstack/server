import type { ConfigUISchema } from '@camstack/types'
import { DEFAULT_EMAIL_PUSH_DOMAIN, DEFAULT_EMAIL_PUSH_PORT } from './email-push-shared.js'

/**
 * The ids of the sections above, in render order — the value the addon hands
 * to `BaseAddon.integrationSettingSections()`. Exported so the declaration and
 * the schema cannot drift: core throws if an id here names no section.
 */
export const EMAIL_PUSH_SECTION_IDS: readonly string[] = ['email-push', 'email-push-auth']

/**
 * Addon-level settings UI for the Reolink email/SMTP push intake.
 *
 * Rendered under the provider's addon settings (Cluster → addon config).
 * Edits land in the addon store via `updateGlobalSettings`; the provider
 * restarts the SMTP server on change. The recommended camera-facing host
 * is rendered read-only so the operator knows what to point cameras at if
 * they configure email manually instead of using Auto-configure.
 *
 * `requiresRestart` is intentionally NOT set — the provider handles the
 * restart itself in `onConfigChanged` (a targeted SMTP rebind, not a full
 * addon teardown).
 *
 * ── These sections ARE the Reolink integration's configuration ──────────
 *
 * Both are declared in `ReolinkAddon.integrationSettingSections()`, so core
 * serves them on System → Integrations → Reolink. The operator looks for "the
 * Reolink SMTP port" under Reolink; this puts it there.
 *
 * They EARN that placement, and the reason is the test any future declaration
 * must pass: they configure ONE SMTP server in ONE provider process, serving
 * every Reolink camera at once. There is no per-camera copy to confuse them
 * with, which is exactly why a per-camera home would be nonsense and a
 * per-integration home is correct. A setting that differs per camera belongs
 * in `deviceSettingsSchema`, never here.
 *
 * The declaration does not move the values: they remain the same bare keys in
 * the same addon store, still reachable from System → Settings, still written
 * by `updateGlobalSettings` — there is no integration-specific writer at all.
 * See ADR-0269.
 *
 * `tab` is deliberately NOT used to express this. It means "how to group this
 * visually", and an earlier design that overloaded it put the literal word
 * "integration" into an operator-facing tab bar (D268 → D269).
 */
export function buildEmailPushSettingsSchema(recommendedHost: string): ConfigUISchema {
  return {
    sections: [
      {
        id: 'email-push',
        title: 'Battery-cam Motion (Email/SMTP Push)',
        titleKey: 'provider-reolink:emailPushSettings.s_email-push.title',
        description: 'Lets battery cameras report motion by email without being woken.',
        descriptionKey: 'provider-reolink:emailPushSettings.s_email-push.description',
        columns: 2,
        fields: [
          {
            type: 'boolean',
            key: 'emailPushEnabled',
            label: 'Enable Email Push Server',
            labelKey: 'provider-reolink:emailPushSettings.s_email-push.emailPushEnabled.label',
            default: true,
          },
          {
            type: 'info',
            key: 'emailPushRecommendedHost',
            label: 'Camera-facing host',
            labelKey:
              'provider-reolink:emailPushSettings.s_email-push.emailPushRecommendedHost.label',
            content: `Point cameras at this host: ${recommendedHost}`,
          },
          {
            type: 'number',
            key: 'emailPushPort',
            label: 'SMTP Port',
            labelKey: 'provider-reolink:emailPushSettings.s_email-push.emailPushPort.label',
            default: DEFAULT_EMAIL_PUSH_PORT,
            min: 1,
            max: 65535,
          },
          {
            type: 'text',
            key: 'emailPushDomain',
            label: 'Virtual Domain',
            labelKey: 'provider-reolink:emailPushSettings.s_email-push.emailPushDomain.label',
            default: DEFAULT_EMAIL_PUSH_DOMAIN,
            placeholder: DEFAULT_EMAIL_PUSH_DOMAIN,
          },
        ],
      },
      {
        id: 'email-push-auth',
        title: 'Email Push Authentication',
        titleKey: 'provider-reolink:emailPushSettings.s_email-push-auth.title',
        description:
          'Random values are generated on first boot; re-run Auto-configure on cameras after changing them.',
        descriptionKey: 'provider-reolink:emailPushSettings.s_email-push-auth.description',
        columns: 2,
        fields: [
          {
            type: 'boolean',
            key: 'emailPushRequireAuth',
            label: 'Require AUTH',
            labelKey:
              'provider-reolink:emailPushSettings.s_email-push-auth.emailPushRequireAuth.label',
            default: true,
          },
          {
            type: 'text',
            key: 'emailPushAuthUsername',
            label: 'Auth Username',
            labelKey:
              'provider-reolink:emailPushSettings.s_email-push-auth.emailPushAuthUsername.label',
          },
          {
            type: 'password',
            key: 'emailPushAuthPassword',
            label: 'Auth Password',
            labelKey:
              'provider-reolink:emailPushSettings.s_email-push-auth.emailPushAuthPassword.label',
            showToggle: true,
          },
        ],
      },
    ],
  }
}
