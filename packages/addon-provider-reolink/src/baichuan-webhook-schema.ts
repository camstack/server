import type { ConfigUISchema } from '@camstack/types'
import { DEFAULT_BAICHUAN_WEBHOOK_PORT } from './baichuan-webhook-shared.js'

/**
 * Addon-level settings for the Baichuan HaCfg HTTP intake.
 *
 * Sibling of the Email/SMTP Push sections — same integration home
 * (System → Integrations → Reolink). Declared via
 * `integrationSettingSections()`.
 */
export const BAICHUAN_WEBHOOK_SECTION_IDS: readonly string[] = ['baichuan-webhook']

export function buildBaichuanWebhookSettingsSchema(recommendedHost: string): ConfigUISchema {
  return {
    sections: [
      {
        id: 'baichuan-webhook',
        title: 'Battery-cam Motion (HaCfg Webhook)',
        titleKey: 'provider-reolink:baichuanWebhookSettings.s_baichuan-webhook.title',
        description: 'Preferred over email push when the camera firmware supports it.',
        descriptionKey: 'provider-reolink:baichuanWebhookSettings.s_baichuan-webhook.description',
        columns: 2,
        fields: [
          {
            type: 'boolean',
            key: 'baichuanWebhookEnabled',
            label: 'Enable HaCfg Webhook Server',
            labelKey:
              'provider-reolink:baichuanWebhookSettings.s_baichuan-webhook.baichuanWebhookEnabled.label',
            default: true,
          },
          {
            type: 'info',
            key: 'baichuanWebhookRecommendedHost',
            label: 'Camera-facing host',
            labelKey:
              'provider-reolink:baichuanWebhookSettings.s_baichuan-webhook.baichuanWebhookRecommendedHost.label',
            content: `Point cameras at this host: ${recommendedHost}`,
          },
          {
            type: 'number',
            key: 'baichuanWebhookPort',
            label: 'HTTP Port',
            labelKey:
              'provider-reolink:baichuanWebhookSettings.s_baichuan-webhook.baichuanWebhookPort.label',
            default: DEFAULT_BAICHUAN_WEBHOOK_PORT,
            min: 1,
            max: 65535,
          },
          {
            type: 'text',
            key: 'baichuanWebhookBindHost',
            label: 'Bind host',
            labelKey:
              'provider-reolink:baichuanWebhookSettings.s_baichuan-webhook.baichuanWebhookBindHost.label',
            default: '0.0.0.0',
            description: '0.0.0.0 accepts on every interface (cameras on LAN).',
            descriptionKey:
              'provider-reolink:baichuanWebhookSettings.s_baichuan-webhook.baichuanWebhookBindHost.description',
          },
        ],
      },
    ],
  }
}
