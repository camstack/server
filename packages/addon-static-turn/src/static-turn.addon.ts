import type { AddonInitResult, InferProvider } from '@camstack/types'
import { BaseAddon, turnProviderCapability } from '@camstack/types'

export interface StaticTurnConfig {
  /** One or more STUN/TURN URLs, comma- or newline-separated, e.g.
   *  `turn:88.153.65.170:3478?transport=udp, stun:88.153.65.170:3478`. */
  readonly urls: string
  /** Long-term-credential username (coturn `user=NAME:PASS`). */
  readonly username: string
  /** Long-term-credential password. */
  readonly credential: string
}

type TurnProvider = InferProvider<typeof turnProviderCapability>

/**
 * Static TURN/STUN provider — points CamStack at a self-hosted coturn (or any
 * static TURN server) entered by the operator in the TURN Servers page. The
 * broker aggregates this alongside any other `turn-provider` (e.g.
 * cloudflare-turn) and sends the ICE servers to both the hub and the browser.
 */
export class StaticTurnAddon extends BaseAddon<StaticTurnConfig> {
  constructor() {
    super({ urls: '', username: '', credential: '' })
  }

  protected async onInitialize(): Promise<AddonInitResult> {
    const provider: TurnProvider = {
      getTurnServers: async () => {
        const urls = this.parseUrls()
        if (urls.length === 0) return []
        const username = this.config.username.trim()
        const credential = this.config.credential.trim()
        return [
          {
            urls,
            ...(username.length > 0 ? { username } : {}),
            ...(credential.length > 0 ? { credential } : {}),
          },
        ]
      },
    }
    this.ctx.logger.info('Static TURN initialized', {
      meta: {
        urlCount: this.parseUrls().length,
        hasCredential: this.config.credential.trim().length > 0,
      },
    })
    return { providers: [{ capability: turnProviderCapability, provider }] }
  }

  private parseUrls(): string[] {
    return this.config.urls
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'turn',
          title: 'TURN / STUN server',
          titleKey: 'static-turn:globalSettings.s_turn.title',
          description:
            'Self-hosted (coturn) or any static TURN/STUN server. CamStack sends these ICE servers to both the hub and the browser so WebRTC can traverse NAT/CGNAT.',
          descriptionKey: 'static-turn:globalSettings.s_turn.description',
          immediate: true,
          fields: [
            {
              type: 'info' as const,
              key: 'help',
              label: 'How to fill',
              labelKey: 'static-turn:globalSettings.s_turn.help.label',
              format: 'html' as const,
              variant: 'info' as const,
              content:
                '<ul>' +
                '<li><strong>URLs</strong>: one per line or comma-separated, e.g. ' +
                '<code>turn:&lt;public-ip&gt;:3478?transport=udp</code> and optionally ' +
                '<code>stun:&lt;public-ip&gt;:3478</code>.</li>' +
                '<li><strong>Username / Credential</strong>: the coturn long-term user ' +
                '(<code>user=NAME:PASS</code> + <code>lt-cred-mech</code> in turnserver.conf).</li>' +
                '<li>The TURN host must be reachable from the public internet: ' +
                'port-forward UDP 3478 + the relay range (e.g. 49152–49200) and set ' +
                '<code>external-ip</code> in coturn to your public IP.</li>' +
                '</ul>',
            },
            this.field({
              type: 'text',
              key: 'urls',
              label: 'TURN / STUN URLs',
              labelKey: 'static-turn:globalSettings.s_turn.urls.label',
              description: 'One per line or comma-separated.',
              descriptionKey: 'static-turn:globalSettings.s_turn.urls.description',
              placeholder: 'turn:88.153.65.170:3478?transport=udp, stun:88.153.65.170:3478',
              required: true,
            }),
            this.field({
              type: 'text',
              key: 'username',
              label: 'Username',
              labelKey: 'static-turn:globalSettings.s_turn.username.label',
              description: 'coturn long-term-credential username.',
              descriptionKey: 'static-turn:globalSettings.s_turn.username.description',
              placeholder: 'camstack',
            }),
            this.field({
              type: 'password',
              key: 'credential',
              label: 'Credential / password',
              labelKey: 'static-turn:globalSettings.s_turn.credential.label',
              description: 'coturn long-term-credential password.',
              descriptionKey: 'static-turn:globalSettings.s_turn.credential.description',
              showToggle: true,
            }),
          ],
        },
      ],
    })
  }
}
