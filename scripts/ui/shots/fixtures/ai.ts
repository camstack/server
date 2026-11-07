/**
 * System → AI (`/system/ai?tab=profiles|runtimes|usage|test`): four profile
 * instances of four kinds (one disabled, one vision-capable, one on a managed runtime),
 * the two purpose defaults, four runtime nodes (one ready, one downloading on
 * a Mac with Apple on-device, one stopped, one unreachable) and a week of usage
 * rollups. Invented data only.
 */
import { AI_KIND_DESCRIPTORS } from '../../../../packages/addon-ai/src/kinds/descriptors'
import { defineFixtures } from './_define'
import { D, NOW } from './_time'

const SET = { $secret: 'ref', v: 1, set: true }

/** The `ai` provider's kinds as it declares them to `integration-instances` (one function cap). */
const KINDS = AI_KIND_DESCRIPTORS.map((d) => ({
  id: d.kind,
  label: d.label,
  functionCap: 'llm',
  canTest: true,
  ...(d.providerWidgets !== undefined && d.providerWidgets.length > 0
    ? { widgets: d.providerWidgets.map(({ id, placement }) => ({ id, placement })) }
    : {}),
}))

const INSTANCES = [
  {
    id: 'p-local-vision',
    name: 'Local vision',
    kind: 'managed-local',
    configured: true,
    enabled: true,
    status: { state: 'ok', label: 'Ready' },
    formValues: {
      model: 'qwen2.5-vl-7b-instruct-q4_k_m',
      supportsVision: true,
      nodeId: 'hub',
      modelRef: { kind: 'catalog', catalogId: 'qwen2.5-vl-7b' },
      contextLength: 4096,
    },
  },
  {
    id: 'p-cloud-text',
    name: 'Cloud text',
    kind: 'openai',
    configured: true,
    enabled: true,
    status: { state: 'ok', label: 'Reachable' },
    formValues: { model: 'example-chat-large', supportsVision: false, apiKey: SET },
  },
  {
    id: 'p-lan-server',
    name: 'LAN inference server',
    kind: 'openai-compatible',
    configured: true,
    enabled: false,
    status: { state: 'off' },
    formValues: {
      model: 'llama-3.1-8b-instruct',
      supportsVision: false,
      baseUrl: 'http://192.0.2.40:11434/v1',
    },
  },
  {
    id: 'p-mac-on-device',
    name: 'Mac on-device',
    kind: 'apple-foundation',
    configured: true,
    enabled: true,
    status: { state: 'ok', label: 'Available' },
    formValues: { model: 'apple-system', supportsVision: false, nodeId: 'mac-agent' },
  },
]

const RUNTIME_NODES = [
  {
    nodeId: 'hub',
    reachable: true,
    status: {
      nodeId: 'hub',
      state: 'ready',
      modelId: 'qwen2.5-vl-7b',
      crashesInWindow: 0,
    },
    disk: {
      nodeId: 'hub',
      modelsBytes: 5_400_000_000,
      freeBytes: 120_000_000_000,
    },
  },
  {
    nodeId: 'mac-agent',
    reachable: true,
    status: {
      nodeId: 'mac-agent',
      state: 'downloading',
      modelId: 'llama-3.1-8b-instruct',
      downloadProgress: 0.42,
      crashesInWindow: 0,
    },
    disk: { nodeId: 'mac-agent', modelsBytes: 2_100_000_000 },
    apple: {
      state: 'available',
      osVersion: '26.1',
      contextSize: 4096,
      languages: ['en', 'it'],
      imageInput: false,
    },
  },
  {
    nodeId: 'nas-agent',
    reachable: true,
    status: { nodeId: 'nas-agent', state: 'stopped', crashesInWindow: 0 },
    disk: { nodeId: 'nas-agent', modelsBytes: 0 },
    apple: { state: 'unsupported-platform', platform: 'linux' },
  },
  {
    nodeId: 'garage-agent',
    reachable: false,
    error: 'connect ETIMEDOUT 192.0.2.61:4480',
  },
]

const day = (offset: number): string => new Date(NOW - offset * D).toISOString().slice(0, 10)

const USAGE = [0, 1, 2, 3, 4, 5, 6].flatMap((o) => [
  {
    day: day(o),
    consumer: 'scene-monitor',
    profileId: 'p-local-vision',
    calls: 40 + o * 3,
    okCalls: 40 + o * 3 - (o % 3),
    errorCalls: o % 3,
    inputTokens: 18_000 + o * 900,
    outputTokens: 2_400 + o * 110,
    avgLatencyMs: 1_840 + o * 37,
  },
  {
    day: day(o),
    consumer: 'event-summary',
    profileId: 'p-cloud-text',
    calls: 12 + o,
    okCalls: 12 + o,
    errorCalls: 0,
    inputTokens: 6_200 + o * 300,
    outputTokens: 1_100 + o * 40,
    avgLatencyMs: 920 + o * 11,
  },
])

export default defineFixtures({
  area: 'ai',
  description: 'System → AI: profiles, defaults, runtime nodes and a week of usage.',
  handlers: {
    // The page asks the registry for `llm` before it renders its sections.
    'capabilities.getCapability': (i: { name: string }) => ({
      name: i.name,
      mode: 'collection',
      providers: ['ai'],
      activeProvider: null,
      disabledProviders: [],
    }),
    'addons.listCapabilityProviders': (i: { capName: string }) =>
      i.capName === 'llm' || i.capName === 'integration-instances'
        ? [{ addonId: 'ai', capName: i.capName, isActive: true }]
        : [],
    'integrationInstances.describe': {
      instanceMode: 'multiple',
      kind: 'profile',
      canTest: true,
      mintsId: true,
      kinds: KINDS,
    },
    'integrationInstances.listInstances': INSTANCES,
    'integrationInstances.getInstance': (i: { id: string }) =>
      INSTANCES.find((p) => p.id === i.id) ?? null,
    'mut:integrationInstances.updateInstance': { ok: true },
    'mut:integrationInstances.setInstanceEnabled': { ok: true },
    'mut:integrationInstances.testInstance': { success: true, status: 'validated' },
    'llm.getDefaults': [
      { selector: { purpose: 'text' }, profileId: 'p-cloud-text' },
      { selector: { purpose: 'vision' }, profileId: 'p-local-vision' },
    ],
    'llm.listRuntimeNodes': RUNTIME_NODES,
    'llm.getUsage': USAGE,
    'llm.listModelCatalog': [
      {
        id: 'qwen2.5-vl-7b',
        label: 'Qwen2.5-VL 7B Instruct',
        family: 'qwen',
        purpose: 'vision',
        url: 'https://example.com/qwen2.5-vl-7b.gguf',
        sha256: '0'.repeat(64),
        sizeBytes: 4_680_000_000,
        quantization: 'Q4_K_M',
        minRamBytes: 8_000_000_000,
        contextSizeDefault: 4096,
      },
    ],
    'mut:llm.listModels': {
      ok: true,
      models: [
        {
          id: 'example-chat-large',
          label: 'Example Chat Large',
          features: { vision: true },
        },
        { id: 'example-chat-small', label: 'Example Chat Small' },
        { id: 'example-reasoner', label: 'Example Reasoner' },
      ],
    },
    'llm.listNodeModels': [],
    'pipelineAnalytics.listRecentTracks': { items: [], nextCursor: null },
  },
})
