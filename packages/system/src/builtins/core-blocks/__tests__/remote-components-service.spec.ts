import {
  BUILTIN_REMOTE_COMPONENTS,
  RemoteLayoutComponentSchema,
  remoteLayoutComponentsCapability,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RemoteComponentsService } from '../remote-components-service.js'

describe('RemoteComponentsService', () => {
  it('serves the built-in palette, every entry valid for the cap output', async () => {
    const listed = await new RemoteComponentsService().listComponents()
    expect(listed.map((c) => c.id)).toEqual(BUILTIN_REMOTE_COMPONENTS.map((c) => c.id))
    const output = remoteLayoutComponentsCapability.methods.listComponents.output
    expect(output.safeParse(listed).success).toBe(true)
    for (const component of listed) {
      expect(RemoteLayoutComponentSchema.safeParse(component).success).toBe(true)
    }
  })

  it('returns a copy, so a caller cannot reorder the palette', async () => {
    const service = new RemoteComponentsService()
    const first = await service.listComponents()
    first.reverse()
    const second = await service.listComponents()
    expect(second[0]?.id).toBe(BUILTIN_REMOTE_COMPONENTS[0]?.id)
  })
})
