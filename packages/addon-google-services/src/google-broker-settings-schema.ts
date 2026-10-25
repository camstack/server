/**
 * Per-kind broker creation/edit form for kind=`google`.
 * Account linking (Sign in) is driven by `listProviders.interactiveConnectPath`
 * in BrokerManager — not a hard-coded Connect link in this form.
 */
import {
  GOOGLE_CONSOLE_APIS_URL,
  GOOGLE_CONSOLE_CREDENTIALS_URL,
  redirectUriDisplay,
  type GoogleSettingsCap,
} from './google-settings-copy.js'

function consoleLinksHtml(): string {
  return [
    `<a href="${GOOGLE_CONSOLE_APIS_URL}">API library</a>`,
    ` · `,
    `<a href="${GOOGLE_CONSOLE_CREDENTIALS_URL}">Credentials</a>`,
  ].join('')
}

/** Setup steps shown on Add / Edit — includes Audience / Test users. */
export function googleBrokerSetupHtml(publicOrigin: string | null): string {
  const redirect = escapeHtml(redirectUriDisplay(publicOrigin))
  return [
    '<ol>',
    `<li>Open Google Cloud Console (${consoleLinksHtml()}). Create a <strong>new project</strong> (or pick an existing one) from the project picker at the top.</li>`,
    '<li>In that project, enable <strong>Google Calendar API</strong> and/or <strong>Gmail API</strong> (API library).</li>',
    '<li>Open <strong>Google Auth Platform → Audience</strong> (or APIs &amp; Services → OAuth consent screen → <strong>Audience</strong>). User type <strong>External</strong> + publishing status <strong>Testing</strong> is fine for a personal hub. Under <strong>Test users</strong>, add the Google account(s) that will Sign in — otherwise Google returns <code>403: access_denied</code>. (If you only see Branding / Data Access, open the <strong>Audience</strong> tab in the left sidebar of Google Auth Platform.) Publishing / verification is optional for a private hub.</li>',
    '<li>Under Credentials, create an OAuth client of type <strong>Web application</strong>.</li>',
    `<li>Add this authorized redirect URI (Network → <strong>Public endpoint</strong>, not Internal): <code>${redirect}</code></li>`,
    '<li>Paste Client ID and Client secret below. <strong>Test connection</strong> checks those with Google (not the account yet).</li>',
    '<li>Add the broker — the hub then opens Google sign-in in a popup to link the account (Calendar + Gmail). Use <strong>Sign in</strong> on the row if you skip or cancel.</li>',
    '</ol>',
  ].join('')
}

/** @deprecated Kept for specs that still assert Connect HTML shape; prefer Sign in via listProviders. */
export function googleBrokerConnectHtml(publicOrigin: string | null): string {
  const redirect = escapeHtml(redirectUriDisplay(publicOrigin))
  return [
    'After Save, use <strong>Sign in</strong> on the broker row (or Add opens the popup). ',
    'Scopes: <code>calendar.readonly</code> + <code>gmail.send</code>. ',
    `Redirect URI must be exactly <code>${redirect}</code>. `,
    `Console: ${consoleLinksHtml()}.`,
  ].join('')
}

export function buildGoogleBrokerSettingsSchema(publicOrigin: string | null) {
  return {
    sections: [
      {
        id: 'setup-intro',
        title: 'Setup',
        titleKey: 'google-services:googleBrokerSettings.s_setup-intro.title',
        description: 'Google Cloud Console — register the hub redirect before Add / Sign in.',
        descriptionKey: 'google-services:googleBrokerSettings.s_setup-intro.description',
        columns: 1,
        fields: [
          {
            type: 'info' as const,
            key: '_setupSteps',
            label: 'Steps',
            labelKey: 'google-services:googleBrokerSettings.s_setup-intro._setupSteps.label',
            format: 'html' as const,
            content: googleBrokerSetupHtml(publicOrigin),
          },
        ],
      },
      {
        id: 'google-oauth-client',
        title: 'Google OAuth client',
        titleKey: 'google-services:googleBrokerSettings.s_google-oauth-client.title',
        description:
          'Web application client from Google Cloud Console. The same Cloud project can be reused across Google brokers.',
        descriptionKey: 'google-services:googleBrokerSettings.s_google-oauth-client.description',
        columns: 1,
        fields: [
          {
            type: 'text' as const,
            key: 'clientId',
            label: 'Client ID',
            labelKey: 'google-services:googleBrokerSettings.s_google-oauth-client.clientId.label',
          },
          {
            type: 'password' as const,
            key: 'clientSecret',
            label: 'Client secret',
            labelKey:
              'google-services:googleBrokerSettings.s_google-oauth-client.clientSecret.label',
            showToggle: true,
          },
        ],
      },
      {
        id: 'gmail-send',
        title: 'Gmail send',
        titleKey: 'google-services:googleBrokerSettings.s_gmail-send.title',
        description:
          'From must be this connected account or a verified send-as. Disable Email on Connectivity to turn Gmail off without removing the broker.',
        descriptionKey: 'google-services:googleBrokerSettings.s_gmail-send.description',
        columns: 1,
        fields: [
          {
            type: 'text' as const,
            key: 'fromAddress',
            label: 'From address',
            labelKey: 'google-services:googleBrokerSettings.s_gmail-send.fromAddress.label',
            description: 'Defaults to the connected Google account email when empty.',
            descriptionKey:
              'google-services:googleBrokerSettings.s_gmail-send.fromAddress.description',
          },
          {
            type: 'text' as const,
            key: 'fromName',
            label: 'From display name (optional)',
            labelKey: 'google-services:googleBrokerSettings.s_gmail-send.fromName.label',
          },
        ],
      },
    ],
  } as const
}

/** Connectivity Calendars / Email pages — calendar import picker lives here (not on broker Add). */
export function buildGoogleFeatureSettingsSchema(
  cap: GoogleSettingsCap,
  publicOrigin: string | null,
) {
  const redirect = escapeHtml(redirectUriDisplay(publicOrigin))
  if (cap === 'calendar-source') {
    return {
      sections: [
        {
          id: 'setup-intro',
          title: 'Google brokers',
          titleKey: 'google-services:googleFeatureSettings.s_setup-intro.title',
          columns: 1,
          fields: [
            {
              type: 'info' as const,
              key: '_setupSteps',
              label: 'Setup',
              labelKey: 'google-services:googleFeatureSettings.s_setup-intro._setupSteps.label',
              format: 'html' as const,
              content: [
                '<p>Link a Google account under Connectivity → <strong>Brokers</strong> ',
                '(Client ID / secret + Sign in). Then pick calendars below. ',
                `OAuth redirect URI: <code>${redirect}</code>.</p>`,
              ].join(''),
            },
          ],
        },
        {
          id: 'google-calendars-import',
          title: 'Calendars to import',
          titleKey: 'google-services:googleFeatureSettings.s_google-calendars-import.title',
          description:
            'Nothing selected = no calendars imported. Options appear after at least one Google broker is signed in.',
          descriptionKey:
            'google-services:googleFeatureSettings.s_google-calendars-import.description',
          columns: 1,
          fields: [
            {
              type: 'multiselect' as const,
              key: 'calendarIds',
              label: 'Calendars',
              labelKey:
                'google-services:googleFeatureSettings.s_google-calendars-import.calendarIds.label',
              options: [] as const,
              optionsFrom: '_calendarCatalog',
              description:
                'Ids are stamped as brokerId:googleCalendarId across every Google broker.',
              descriptionKey:
                'google-services:googleFeatureSettings.s_google-calendars-import.calendarIds.description',
            },
          ],
        },
      ],
    } as const
  }
  const title = cap === 'smtp-provider' ? 'Gmail send uses Google brokers' : 'Google brokers'
  const body =
    cap === 'smtp-provider'
      ? [
          '<p>Add or edit a <strong>Google</strong> broker under Connectivity → <strong>Brokers</strong> ',
          '(Client ID / secret + Sign in). From address and send-as live on that broker. ',
          `OAuth redirect URI: <code>${redirect}</code>.</p>`,
        ].join('')
      : [
          '<p>Add or edit a <strong>Google</strong> broker under Connectivity → <strong>Brokers</strong> ',
          '(Client ID / secret + Sign in). ',
          `OAuth redirect URI: <code>${redirect}</code>.</p>`,
        ].join('')
  return {
    sections: [
      {
        id: 'setup-intro',
        title,
        columns: 1,
        fields: [
          {
            type: 'info' as const,
            key: '_setupSteps',
            label: 'Setup',
            labelKey: 'google-services:googleFeatureSettings._setupSteps.label',
            format: 'html' as const,
            content: body,
          },
        ],
      },
    ],
  } as const
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
