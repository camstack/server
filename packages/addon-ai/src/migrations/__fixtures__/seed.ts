/**
 * The legacy data the `ai` catalogue meets on a node that last ran a release which kept flat LLM
 * profile rows: written by hand, in the shape that release stored it, with a MARK in every field a
 * migration that re-built a row would drop. The migration spec seeds from here. Every value is
 * fabricated.
 */
export const KEY = 'fake-key-migration-0001'
/** A value nothing else in the suite uses, so finding it proves it SURVIVED. */
export const MARK = 'marked-7f3a'

export const COMMON = {
  addonId: 'ai',
  enabled: true,
  supportsVision: true,
  temperature: 0.3,
  topK: 17,
  systemPrompt: `be brief ${MARK}`,
  timeoutMs: 61_000,
  connectTimeoutMs: 11_000,
  firstTokenTimeoutMs: 121_000,
  idleTimeoutMs: 59_000,
  retry: { enabled: true, maxAttempts: 3 },
  toolsEnabled: true,
}

export const FLAT_HTTP = {
  ...COMMON,
  name: 'flat anthropic',
  kind: 'anthropic',
  model: 'claude-x',
  baseUrl: `https://gw.example.com/${MARK}/v1`,
  extraHeaders: { 'x-mark': MARK },
}

export const RUNTIME = {
  nodeId: `agent-${MARK}`,
  engine: 'llama-cpp',
  model: { kind: 'catalog', catalogId: 'qwen-mark' },
  extraArgs: ['--jinja'],
  contextSize: 8192,
  gpuLayers: 33,
  parallel: 2,
  flashAttention: true,
  mlock: false,
  noMmap: false,
  autoStart: true,
  idleStopMinutes: 12,
}

export const FLAT_MANAGED = {
  ...COMMON,
  name: 'flat managed',
  kind: 'managed-local',
  model: 'qwen-mark',
  runtime: RUNTIME,
}

export const FLAT_APPLE = {
  ...COMMON,
  name: 'flat apple',
  kind: 'apple-foundation',
  model: 'apple-system',
  appleFoundation: { nodeId: `mac-${MARK}` },
}
