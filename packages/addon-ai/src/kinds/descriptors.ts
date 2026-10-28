/**
 * The kinds this addon serves, declared as data (D893).
 *
 * A descriptor is everything the admin editor knows about a kind: the
 * provider's own fields (`connectionSchema`, `advancedSchema` — rendered by
 * `ConfigFormBuilder` into `providerConfig`), which common profile fields mean
 * something on its wire (`profileFields`), what its models can do by default
 * (`features`), where its model list comes from (`modelCatalog`) and any part
 * the provider draws itself (`providerWidgets`, by a generic widget id). The
 * editor has NO branch on a kind id: a field exists in the UI exactly when it
 * exists here, and `provider-config.ts` is what validates it on save — read the
 * two together.
 */
import type { ConfigUISchema, LlmProfileField, LlmProfileKindDescriptor } from '@camstack/types'
import { APPLE_SYSTEM_MODEL } from '../runtime/apple/afm-protocol.js'
import type { HttpKind } from './http-connection.js'

export type KindDescriptor = Omit<LlmProfileKindDescriptor, 'addonId'>

/** Every common field; a kind lists the ones its wire carries. */
const ALL_HTTP_FIELDS: readonly LlmProfileField[] = [
  'temperature',
  'topP',
  'topK',
  'maxTokens',
  'contextLength',
  'systemPrompt',
  'timeoutMs',
  'connectTimeoutMs',
  'firstTokenTimeoutMs',
  'idleTimeoutMs',
  'retry',
  'toolsEnabled',
]

/** NEITHER OpenAI wire carries top-k (measured: the body gets `top_p`, no `top_k`). */
const OPENAI_WIRE_FIELDS: readonly LlmProfileField[] = ALL_HTTP_FIELDS.filter(
  (f) => f !== 'topK' && f !== 'reasoningEffort',
)

/**
 * `reasoning_effort` is sent only on the openai-compatible wire (LM Studio,
 * llama-server, Ollama's /v1) where 'none' is measured to switch thinking off.
 * The OpenAI cloud rejects it on non-reasoning models, Anthropic has no 'off',
 * so those kinds do not offer it.
 */
const OPENAI_COMPATIBLE_FIELDS: readonly LlmProfileField[] = [
  ...OPENAI_WIRE_FIELDS,
  'reasoningEffort',
]

interface HttpConnectionOptions {
  readonly baseUrlRequired: boolean
  readonly baseUrlPlaceholder: string
  readonly apiKeyRequired: boolean
}

/** Endpoint + key — the HTTP kinds' connection form. `apiKey` is the one secret. */
function httpConnectionSchema(opts: HttpConnectionOptions): ConfigUISchema {
  return {
    sections: [
      {
        id: 'connection',
        title: 'Connection',
        fields: [
          {
            type: 'text',
            key: 'baseUrl',
            label: 'Base URL',
            inputType: 'url',
            required: opts.baseUrlRequired,
            placeholder: opts.baseUrlPlaceholder,
          },
          {
            type: 'password',
            key: 'apiKey',
            label: 'API key',
            required: opts.apiKeyRequired,
            showToggle: true,
          },
        ],
      },
    ],
  }
}

const HTTP_ADVANCED_SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'headers',
      title: 'Extra headers',
      fields: [
        {
          type: 'editable-array',
          key: 'extraHeaders',
          label: 'Extra request headers',
          description: 'Sent on every request of this profile, after the provider’s own.',
          itemIdKey: 'name',
          addLabel: 'Add header',
          emptyMessage: 'No extra headers',
          rowTitleTemplate: '{name}',
          itemFields: [
            { type: 'text', key: 'name', label: 'Header', required: true },
            { type: 'text', key: 'value', label: 'Value' },
          ],
        },
      ],
    },
  ],
}

function httpKind(
  kind: HttpKind,
  label: string,
  icon: string,
  connection: HttpConnectionOptions,
  features: KindDescriptor['features'],
  profileFields: readonly LlmProfileField[],
): KindDescriptor {
  return {
    kind,
    label,
    icon,
    connectionSchema: httpConnectionSchema(connection),
    advancedSchema: HTTP_ADVANCED_SCHEMA,
    features,
    visionEditable: true,
    modelCatalog: 'fetch',
    profileFields: [...profileFields],
  }
}

export const HTTP_KIND_DESCRIPTORS: readonly KindDescriptor[] = [
  httpKind(
    'openai-compatible',
    'OpenAI-compatible endpoint',
    'plug',
    {
      baseUrlRequired: true,
      baseUrlPlaceholder: 'http://ollama.lan:11434/v1',
      apiKeyRequired: false,
    },
    // An arbitrary server: assume the least, let the operator say more.
    { vision: false, tools: false, streaming: true },
    OPENAI_COMPATIBLE_FIELDS,
  ),
  httpKind(
    'openai',
    'OpenAI',
    'cloud',
    {
      baseUrlRequired: false,
      baseUrlPlaceholder: 'https://api.openai.com/v1',
      apiKeyRequired: true,
    },
    { vision: true, tools: true, streaming: true },
    OPENAI_WIRE_FIELDS,
  ),
  httpKind(
    'anthropic',
    'Anthropic',
    'cloud',
    {
      baseUrlRequired: false,
      baseUrlPlaceholder: 'https://api.anthropic.com/v1',
      apiKeyRequired: true,
    },
    { vision: true, tools: true, streaming: true },
    ALL_HTTP_FIELDS,
  ),
  httpKind(
    'google',
    'Google Gemini',
    'cloud',
    {
      baseUrlRequired: false,
      baseUrlPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
      apiKeyRequired: true,
    },
    { vision: true, tools: true, streaming: true },
    ALL_HTTP_FIELDS,
  ),
]

const CACHE_TYPE_OPTIONS = [
  { value: 'f16', label: 'f16' },
  { value: 'q8_0', label: 'q8_0' },
  { value: 'q5_1', label: 'q5_1' },
  { value: 'q5_0', label: 'q5_0' },
  { value: 'q4_1', label: 'q4_1' },
  { value: 'q4_0', label: 'q4_0' },
]

/**
 * The managed llama.cpp runtime's knobs — every one of them a real
 * `llama-server` flag that `buildLlamaArgs` puts on the command line. Keys are
 * `ManagedRuntimeConfig` keys: `providerConfig` of this kind IS that object.
 * The first-time fields stay open; memory/throughput tuning is Advanced.
 */
const MANAGED_LOCAL_CONNECTION_SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'runtime',
      title: 'Runtime',
      fields: [
        {
          type: 'node-select',
          key: 'nodeId',
          label: 'Runtime node',
          required: true,
          default: 'hub',
          description: 'Where llama-server runs — the hub or any agent.',
        },
        {
          type: 'number',
          key: 'contextSize',
          label: 'Context size',
          min: 512,
          default: 4096,
          unit: 'tokens',
          description:
            'llama.cpp -c. The KV cache scales with this — it is usually what runs a node out of RAM.',
        },
        {
          type: 'number',
          key: 'gpuLayers',
          label: 'GPU layers',
          min: 0,
          default: 0,
          description: 'llama.cpp -ngl. 0 = CPU only.',
        },
        {
          type: 'number',
          key: 'idleStopMinutes',
          label: 'Idle stop (min)',
          min: 0,
          default: 30,
          description:
            'Stops the process after this long with no call, freeing its RAM. 0 = never.',
        },
        {
          type: 'tags',
          key: 'extraArgs',
          label: 'Additional llama-server arguments',
          suggestions: ['--jinja', '--cont-batching'],
          creatable: true,
          description:
            'One flag or value per entry, for flags this form does not own. Vision models generally need --jinja. Repeating a flag a field above owns is rejected at start.',
        },
      ],
    },
  ],
}

const MANAGED_LOCAL_ADVANCED_SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'runtime-tuning',
      title: 'Memory and throughput',
      fields: [
        {
          type: 'number',
          key: 'threads',
          label: 'Threads',
          min: 1,
          description:
            'llama.cpp -t. Defaults to cpus-2, clamped to at least 1, resolved on the node.',
        },
        { type: 'number', key: 'parallel', label: 'Parallel slots', min: 1, default: 1 },
        { type: 'number', key: 'batchSize', label: 'Batch size (-b)', min: 1 },
        { type: 'number', key: 'ubatchSize', label: 'Micro-batch (-ub)', min: 1 },
        {
          type: 'boolean',
          key: 'flashAttention',
          label: 'Flash attention',
          description:
            'llama.cpp --flash-attn. Cuts KV-cache memory where the backend implements it; a no-op elsewhere.',
        },
        {
          type: 'select',
          key: 'cacheTypeK',
          label: 'KV cache type (K)',
          options: CACHE_TYPE_OPTIONS,
          description:
            'Quantising the KV cache is the cheapest way to fit a longer context in the same RAM.',
        },
        {
          type: 'select',
          key: 'cacheTypeV',
          label: 'KV cache type (V)',
          options: CACHE_TYPE_OPTIONS,
        },
        {
          type: 'boolean',
          key: 'mlock',
          label: 'Lock weights in RAM (--mlock)',
          description:
            'Stops the OS paging the model out mid-inference. Costs the full model size, resident.',
        },
        {
          type: 'boolean',
          key: 'noMmap',
          label: 'Disable mmap (--no-mmap)',
          description:
            'Reads the GGUF up front. Slower to start, but avoids page-fault stalls on a network model store.',
        },
      ],
    },
  ],
}

export const MANAGED_LOCAL_DESCRIPTOR: KindDescriptor = {
  kind: 'managed-local',
  label: 'Managed local (llama.cpp)',
  icon: 'cpu',
  connectionSchema: MANAGED_LOCAL_CONNECTION_SCHEMA,
  advancedSchema: MANAGED_LOCAL_ADVANCED_SCHEMA,
  // A node-side generation is one unary call; the test chat falls back to it.
  features: { vision: false, tools: false, streaming: false },
  visionEditable: true,
  // `listModels` answers the curated catalogue (+ the node's own files); the
  // widget below is what turns a pick into a pinned `ManagedModelRef`.
  modelCatalog: 'fetch',
  // The node-side runtime receives the caller's input as-is: the profile's
  // sampling defaults never reach llama-server, so only the bound is offered.
  profileFields: ['timeoutMs'],
  providerWidgets: [{ id: 'ai/managed-model', placement: 'model', requires: ['model'] }],
}

/**
 * `apple-foundation` — no key, no URL, one model. WHERE it runs is a node
 * picker the provider draws (restricted to nodes reporting `available`), and
 * whether it sees images is what that node REPORTS, never a switch (D62).
 */
export const APPLE_FOUNDATION_DESCRIPTOR: KindDescriptor = {
  kind: 'apple-foundation',
  label: 'Apple on-device (Foundation Models)',
  icon: 'cpu',
  connectionSchema: { sections: [] },
  // The node answers one whole result per call (`completeApple`).
  features: { vision: false, tools: false, streaming: false },
  visionEditable: false,
  modelCatalog: 'static',
  staticModels: [{ id: APPLE_SYSTEM_MODEL, label: 'Apple on-device model' }],
  profileFields: ['temperature', 'topP', 'topK', 'maxTokens', 'systemPrompt', 'timeoutMs'],
  providerWidgets: [{ id: 'ai/apple-node', placement: 'connection', requires: ['nodeId'] }],
}

/** Every kind this addon serves, in pre-modal order. */
export const AI_KIND_DESCRIPTORS: readonly KindDescriptor[] = [
  ...HTTP_KIND_DESCRIPTORS,
  MANAGED_LOCAL_DESCRIPTOR,
  APPLE_FOUNDATION_DESCRIPTOR,
]

export function descriptorOf(kind: string): KindDescriptor | null {
  return AI_KIND_DESCRIPTORS.find((d) => d.kind === kind) ?? null
}
