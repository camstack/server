import { z } from 'zod'
import { RemoteLayoutComponentSchema } from '../remote/remote-components.js'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * remote-layout-components — the palette of the remote template editor's "Add
 * component" (D973). A provider DECLARES components as data (buttons placed
 * relative to the component, a frame, shapes and tones from closed
 * vocabularies the UI draws); it ships no UI code.
 *
 * Collection: `listComponents` returns an array, so the generated mount
 * concat-fans it across every enabled provider. The core-blocks builtin
 * provides the built-in set (`core:*`); an addon adds its own under
 * `<addonId>:<name>`. The caller dedupes by id, built-ins first.
 */
export const remoteLayoutComponentsCapability = {
  name: 'remote-layout-components',
  scope: 'system',
  mode: 'collection',
  methods: {
    listComponents: method(z.object({}), z.array(RemoteLayoutComponentSchema), {
      auth: 'protected',
    }),
  },
} as const satisfies CapabilityDefinition

export type IRemoteLayoutComponentsProvider = InferProvider<typeof remoteLayoutComponentsCapability>
