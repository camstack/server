/**
 * The `remote-layout-components` provider of core-blocks (D973): the built-in
 * palette of the remote template editor. The definitions are data in
 * `@camstack/types` (the presets compose from the same entries); this is only
 * the door the cap opens on them.
 */
import {
  BUILTIN_REMOTE_COMPONENTS,
  type IRemoteLayoutComponentsProvider,
  type RemoteLayoutComponent,
} from '@camstack/types'

export class RemoteComponentsService implements IRemoteLayoutComponentsProvider {
  async listComponents(): Promise<RemoteLayoutComponent[]> {
    return [...BUILTIN_REMOTE_COMPONENTS]
  }
}
