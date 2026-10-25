/**
 * System → Data → Records, an entry kind opened with Manage (`/system/data?tab=records`).
 */
import { REDACTED_SECRET } from '@camstack/types'
import { defineFixtures } from './_define'
import { NOW } from './_time'

const LLM_FIELDS = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    kind: { type: 'string', enum: ['openai-compatible', 'managed-local'] },
    addonId: { type: 'string' },
    enabled: { type: 'boolean' },
    model: { type: 'string' },
    apiKey: { type: 'string', secret: true },
    supportsVision: { type: 'boolean' },
  },
  required: ['name', 'kind', 'addonId', 'enabled', 'model', 'supportsVision'],
}

export default defineFixtures({
  area: 'record-entries',
  description: 'Generic record entry kinds and rows',
  handlers: {
    'recordEntries.listEntryKinds': {
      kinds: [
        {
          owner: 'ml',
          kind: 'llm-profiles',
          title: 'LLM profiles',
          nameField: 'name',
          fields: LLM_FIELDS,
          secretPaths: ['apiKey'],
          rows: 2,
        },
        {
          owner: 'notifiers',
          kind: 'notification-targets',
          title: 'Notification targets',
          nameField: 'name',
          fields: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              kind: { type: 'string' },
              addonId: { type: 'string' },
              enabled: { type: 'boolean' },
              config: { type: 'object', additionalProperties: {} },
            },
            required: ['name', 'kind', 'addonId', 'enabled', 'config'],
          },
          secretPaths: [],
          rows: 1,
        },
      ],
    },
    'recordEntries.listEntries': (input: unknown) => {
      const req = input as { owner?: string; kind?: string }
      if (req.owner === 'ml' && req.kind === 'llm-profiles') {
        return {
          entries: [
            {
              id: 'prof-1',
              name: 'Local Ollama',
              rev: 3,
              updatedAt: NOW - 3600_000,
              data: {
                name: 'Local Ollama',
                kind: 'managed-local',
                addonId: 'ai',
                enabled: true,
                model: 'llama3.2',
                apiKey: REDACTED_SECRET,
                supportsVision: false,
              },
            },
            {
              id: 'prof-2',
              name: 'Cloud backup',
              rev: 1,
              updatedAt: NOW - 86_400_000,
              data: {
                name: 'Cloud backup',
                kind: 'openai-compatible',
                addonId: 'ai',
                enabled: false,
                model: 'gpt-4o-mini',
                supportsVision: true,
              },
            },
          ],
        }
      }
      return { entries: [] }
    },
    'mut:recordEntries.putEntry': { id: 'prof-new', rev: 1 },
    'mut:recordEntries.deleteEntry': { deleted: true },
  },
})
