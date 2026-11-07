/**
 * The retrain assist and the rule picker read LLM profiles as `integration-instances` of the `ai`
 * addon. The facts carry model, kind, baseUrl, enabled and vision support, and never a key: the
 * stored key arrives as a secret view and must not be copied into the facts. Every value is fabricated.
 */
import type { IntegrationInstance } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type LlmProfileApi, listLlmProfileFacts } from '../llm-profile-instances.js'

const KEY = 'fake-key-facts-0001'

function instance(
  partial: Pick<IntegrationInstance, 'id'> & Partial<IntegrationInstance>,
): IntegrationInstance {
  return {
    name: partial.id,
    configured: true,
    enabled: true,
    kind: 'openai',
    formValues: {},
    ...partial,
  }
}

function fakeApi(instances: readonly IntegrationInstance[], asked: string[] = []): LlmProfileApi {
  return {
    integrationInstances: {
      listInstances: {
        query: async ({ addonId }) => {
          asked.push(addonId)
          return instances
        },
      },
    },
  }
}

describe('listLlmProfileFacts', () => {
  it('maps model, kind, baseUrl, enabled and vision, asking only the ai addon', async () => {
    const asked: string[] = []
    const facts = await listLlmProfileFacts(
      fakeApi(
        [
          instance({
            id: 'cloud',
            name: 'Cloud',
            kind: 'anthropic',
            formValues: {
              model: 'claude-x',
              baseUrl: 'https://gw.example.com/v1',
              supportsVision: true,
            },
          }),
          instance({
            id: 'local',
            kind: 'managed-local',
            enabled: false,
            formValues: { model: 'qwen' },
          }),
        ],
        asked,
      ),
    )
    expect(asked).toEqual(['ai'])
    expect(facts).toEqual([
      {
        id: 'cloud',
        name: 'Cloud',
        model: 'claude-x',
        kind: 'anthropic',
        baseUrl: 'https://gw.example.com/v1',
        enabled: true,
        supportsVision: true,
      },
      {
        id: 'local',
        name: 'local',
        model: 'qwen',
        kind: 'managed-local',
        enabled: false,
        supportsVision: false,
      },
    ])
  })

  it('never carries the api key or its secret view', async () => {
    const facts = await listLlmProfileFacts(
      fakeApi([
        instance({
          id: 'keyed',
          formValues: { model: 'm', apiKey: { $secret: 'ref', v: 1, set: true }, rawKey: KEY },
        }),
      ]),
    )
    const text = JSON.stringify(facts)
    expect(text).not.toContain(KEY)
    expect(text).not.toContain('apiKey')
    expect(text).not.toContain('$secret')
  })
})
