import type { AddonInitResult } from '@camstack/types'
import { BaseAddon, turnProviderCapability } from '@camstack/types'
import { CloudflareTurnService } from './cloudflare-turn'
import type { CloudflareTurnConfig } from './cloudflare-turn'
import { cloudflareTurnActions, type CloudflareTurnActions } from './cloudflare-turn-actions'

/**
 * Static `customActions` re-export — picked up by the addon-service-factory
 * when this addon runs in a forked group-runner (the factory reads the
 * module's named export so the Moleculer actions get registered with the
 * canonical schemas). Without this the hub's custom-action dispatch
 * surfaces "no custom action X" because the catalog isn't visible.
 */
export { cloudflareTurnActions as customActions } from './cloudflare-turn-actions'

/**
 * Settings redesign Phase 3: cloudflare-turn is node-level credentials
 * storage. Implements `getGlobalSettings`.
 */
export class CloudflareTurnAddon extends BaseAddon<CloudflareTurnConfig> {
  private service: CloudflareTurnService | null = null

  constructor() {
    super({ apiToken: '', accountId: '' })
  }

  protected async onInitialize(): Promise<AddonInitResult<CloudflareTurnActions>> {
    this.service = new CloudflareTurnService(this.config, this.ctx.logger)
    this.ctx.logger.info('Cloudflare TURN initialized')
    return {
      providers: [{ capability: turnProviderCapability, provider: this.service }],
      customActions: cloudflareTurnActions,
      actionHandlers: {
        testCredentials: async () => {
          // Bypass the cache so the test reflects the LIVE config (operator
          // just edited it). The service stays the canonical impl.
          const svc = new CloudflareTurnService(this.config, this.ctx.logger)
          return svc.testCredentials()
        },
      },
    }
  }

  protected async onShutdown(): Promise<void> {
    this.service = null
  }

  getService(): CloudflareTurnService {
    if (!this.service) throw new Error('Cloudflare TURN not initialized')
    return this.service
  }

  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'credentials',
          title: 'Cloudflare Credentials',
          titleKey: 'cloudflare:globalSettings.s_credentials.title',
          description: 'API credentials for fetching TURN relay tokens from Cloudflare Realtime.',
          descriptionKey: 'cloudflare:globalSettings.s_credentials.description',
          immediate: true,
          fields: [
            {
              type: 'info' as const,
              key: 'turnHelp',
              label: 'How to get the TURN Key ID + API Token',
              labelKey: 'cloudflare:globalSettings.s_credentials.turnHelp.label',
              format: 'html' as const,
              content:
                '<ul>' +
                '<li>Open ' +
                '<a href="https://dash.cloudflare.com/?to=/:account/realtime/turn/overview" ' +
                'target="_blank" rel="noopener noreferrer">' +
                'Cloudflare Dashboard → Realtime → TURN</a>.</li>' +
                '<li>Pick the <strong>TURN</strong> section and click ' +
                '<strong>Create TURN App</strong> (or pick an existing one).</li>' +
                '<li>Cloudflare generates a pair: <strong>Token ID</strong> ' +
                '(hex string, also shown as "Key ID" in some docs) and an ' +
                '<strong>API Token</strong>. Both are app-scoped — they are ' +
                '<em>NOT</em> the same as your Cloudflare Account ID.</li>' +
                '<li>Paste them in the fields below.</li>' +
                '<li>The integration calls ' +
                '<code>rtc.live.cloudflare.com/v1/turn/keys/&lt;TokenId&gt;/credentials/generate-ice-servers</code> ' +
                'to mint short-lived ICE credentials per WebRTC session.</li>' +
                '</ul>',
              variant: 'info' as const,
            },
            this.field({
              type: 'text',
              key: 'accountId',
              label: 'TURN Key ID',
              labelKey: 'cloudflare:globalSettings.s_credentials.accountId.label',
              description:
                "Token ID of the Realtime TURN app (NOT your Cloudflare Account ID — it's a separate hex id generated when you create the TURN app).",
              descriptionKey: 'cloudflare:globalSettings.s_credentials.accountId.description',
              placeholder: 'a1b2c3d4e5f6...',
              required: true,
            }),
            this.field({
              type: 'password',
              key: 'apiToken',
              label: 'API Token',
              labelKey: 'cloudflare:globalSettings.s_credentials.apiToken.label',
              description:
                'The API Token shown alongside the Token ID when you created the TURN app. App-scoped — separate from any Cloudflare global API token.',
              descriptionKey: 'cloudflare:globalSettings.s_credentials.apiToken.description',
              showToggle: true,
              required: true,
            }),
            {
              type: 'addon-action-button' as const,
              key: 'testCredentials',
              label: 'Test credentials',
              labelKey: 'cloudflare:globalSettings.s_credentials.testCredentials.label',
              description:
                'Hit the Cloudflare TURN API with the current Key ID + API Token. On success shows the URL count + whether credentials came back; on failure shows the raw response with an operator hint.',
              descriptionKey: 'cloudflare:globalSettings.s_credentials.testCredentials.description',
              addonId: 'cloudflare-turn',
              action: 'testCredentials',
              buttonLabel: 'Test',
              successMessage: '✓ Fetched {urlCount} URL(s) — credentials: {hasCredentials}',
            },
            {
              type: 'info' as const,
              key: 'usageHelp',
              label: 'Usage & free quota',
              labelKey: 'cloudflare:globalSettings.s_credentials.usageHelp.label',
              format: 'html' as const,
              content:
                "<p>Cloudflare's TURN credentials endpoint we use (<code>Calls:Read</code> " +
                'scope) does not return usage / remaining-free-credit. Check current ' +
                'consumption + free quota in the dashboard:</p>' +
                '<ul>' +
                '<li><a href="https://dash.cloudflare.com/?to=/:account/realtime/turn/overview" ' +
                'target="_blank" rel="noopener noreferrer">' +
                'Cloudflare Dashboard → Realtime → TURN</a> — overview of TURN apps ' +
                'with usage graphs and current-month consumption.</li>' +
                '</ul>' +
                '<p class="text-foreground-subtle text-xs">Wiring a live counter requires ' +
                'a separate API token with <code>Account → Analytics → Read</code> scope ' +
                "and Cloudflare's GraphQL Analytics endpoint. Filed as a follow-up; " +
                'use the dashboard link above in the meantime.</p>',
              variant: 'info' as const,
            },
          ],
        },
      ],
    })
  }
}
