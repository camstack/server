/**
 * The Logs → Destinations list with Loki as a `multiple` provider holding two records, so the
 * Add button is enabled and the Loki pill counts 2. Use instead of `provider-instances`
 * (`--fixtures provider-instances-loki-multi,logs`). Invented data.
 */
import { defineFixtures } from './_define'
import base from './provider-instances'

const SET = { $secret: 'ref', v: 1, set: true }

export default defineFixtures({
  area: 'provider-instances-loki-multi',
  description: 'provider-instances with Loki multiple and two records',
  handlers: {
    ...base.handlers,
    'integrationInstances.describe': (i: { addonId: string }) =>
      i.addonId === 'loki-logging'
        ? { instanceMode: 'multiple', kind: 'destination', canTest: true }
        : (base.handlers['integrationInstances.describe'] as (x: { addonId: string }) => unknown)(
            i,
          ),
    'integrationInstances.listInstances': (i: { addonId: string }) =>
      i.addonId === 'loki-logging'
        ? [
            {
              id: 'loki-logging',
              name: 'Loki prod',
              configured: true,
              formValues: {
                url: 'http://loki.example.com:3100',
                job: 'camstack',
                password: SET,
              },
            },
            {
              id: 'inst-4c1d9e07',
              name: 'Loki staging',
              configured: true,
              status: { state: 'ok' },
              formValues: {
                url: 'http://loki-stg.example.com:3100',
                job: 'camstack-stg',
              },
            },
          ]
        : (
            base.handlers['integrationInstances.listInstances'] as (x: {
              addonId: string
            }) => unknown
          )(i),
  },
})
