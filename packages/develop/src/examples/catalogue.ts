import type { ExampleEntry } from '../types.js'

/**
 * Curated examples from core packages — mirrors the public Develop
 * "Examples from core addons" page. Tags drive `find_example` ranking.
 */
export const CORE_EXAMPLES: readonly ExampleEntry[] = [
  {
    id: 'provider-rtsp',
    packageDir: 'packages/addon-provider-rtsp',
    kind: 'provider',
    demonstrates: 'Minimal device provider — RTSP streams, adoption, binding layout.',
    tags: ['provider', 'device', 'rtsp', 'camera', 'stream', 'beginner'],
  },
  {
    id: 'provider-hikvision',
    packageDir: 'packages/addon-provider-hikvision',
    kind: 'provider',
    demonstrates: 'Full camera provider — streams, accessories, vendor protocol.',
    tags: ['provider', 'device', 'camera', 'hikvision', 'isapi'],
  },
  {
    id: 'provider-reolink',
    packageDir: 'packages/addon-provider-reolink',
    kind: 'provider',
    demonstrates: 'Device provider with Baichuan/HTTP paths, doorbells, PTZ.',
    tags: ['provider', 'device', 'camera', 'reolink', 'doorbell', 'ptz'],
  },
  {
    id: 'provider-amcrest',
    packageDir: 'packages/addon-provider-amcrest',
    kind: 'provider',
    demonstrates: 'Amcrest/Dahua-style provider patterns.',
    tags: ['provider', 'device', 'camera', 'amcrest'],
  },
  {
    id: 'provider-homeassistant',
    packageDir: 'packages/addon-provider-homeassistant',
    kind: 'provider',
    demonstrates: 'Broker + many device classes from one integration.',
    tags: ['provider', 'homeassistant', 'broker', 'devices', 'ha'],
  },
  {
    id: 'notifiers',
    packageDir: 'packages/addon-notifiers',
    kind: 'notifier',
    demonstrates: 'Collection of notification delivery targets.',
    tags: ['notifier', 'notifications', 'telegram', 'webhook', 'delivery'],
  },
  {
    id: 'smtp-nodemailer',
    packageDir: 'packages/addon-smtp-nodemailer',
    kind: 'notifier',
    demonstrates: 'Small hub-only collection provider (SMTP) with settings UI.',
    tags: ['smtp', 'email', 'collection', 'provider', 'settings', 'small'],
  },
  {
    id: 'osd-manager',
    packageDir: 'packages/addon-osd-manager',
    kind: 'osd',
    demonstrates: 'Admin page + per-camera bindings + named templates.',
    tags: ['osd', 'admin-page', 'bindings', 'templates', 'ui'],
  },
  {
    id: 'model-studio',
    packageDir: 'packages/addon-model-studio',
    kind: 'model-studio',
    demonstrates: 'Detection-adjacent Admin tool as a separate addon.',
    tags: ['models', 'detection', 'admin-page', 'catalog'],
  },
  {
    id: 'benchmark',
    packageDir: 'packages/addon-benchmark',
    kind: 'model-studio',
    demonstrates: 'Detection benchmarks on a device pool.',
    tags: ['benchmark', 'detection', 'admin-page'],
  },
  {
    id: 'post-analysis',
    packageDir: 'packages/addon-post-analysis',
    kind: 'post-analysis',
    demonstrates: 'Notification center, alarm, pipeline-analytics consumer.',
    tags: ['post-analysis', 'notifications', 'alarm', 'pipeline', 'analytics'],
  },
  {
    id: 'admin-ui',
    packageDir: 'packages/addon-admin-ui',
    kind: 'admin-ui',
    demonstrates: 'Host shell — merges builtin nav + addon pages.',
    tags: ['admin-ui', 'pages', 'shell', 'nav'],
  },
  {
    id: 'system-builtins',
    packageDir: 'packages/system',
    kind: 'builtin',
    demonstrates: 'Builtins that must ship with the server (logging, core-blocks, …).',
    tags: ['builtin', 'system', 'logging', 'core-blocks'],
  },
]
