/**
 * The first-launch / change-config setup window, as a `data:text/html`
 * document — dispatched BY PRODUCT (ADR-0402).
 *
 * The window differs by build, not by preference:
 *
 *   - the NODE product picks a role — hub or agent — and configures the
 *     agent's hub connection (`render-node-setup.ts`);
 *   - the VIEWER product picks nothing. Its role is fixed by construction, so
 *     the window is the hub address and a confirm (`render-viewer-setup.ts`),
 *     and it is also what `Change hub…` reopens.
 *
 * Shipping the viewer option inside the 508 MB node build is what made the
 * two-product split look self-contradictory; a role a product cannot run is
 * never offered by it.
 */
import type { DesktopProduct } from '../product/desktop-product'
import type { NodeRole } from '../types'
import type { HubMode } from './hub-mode'
import { renderNodeSetup } from './render-node-setup'
import { renderViewerSetup } from './render-viewer-setup'

export type { HubMode } from './hub-mode'

export interface SetupInitial {
  /** Which build this is. Decides the whole form. */
  readonly product: DesktopProduct
  /** The effective role (`roleForProduct`), used only to preselect a radio. */
  readonly role: NodeRole
  readonly hubMode: HubMode
  readonly hubAddress: string
  readonly hubPort: number
  readonly agentName: string
  /** The agent's default name (`<short host name>-<arch>`), shown as the name field's placeholder. */
  readonly defaultAgentName: string
  /** The viewer product's target hub, a full URL (`https://host[:port]`). */
  readonly viewerHubUrl: string
}

export function renderSetupHtml(initial: SetupInitial): string {
  if (initial.product === 'viewer') {
    return renderViewerSetup(initial.viewerHubUrl)
  }
  return renderNodeSetup({
    isAgent: initial.role === 'agent',
    hubMode: initial.hubMode,
    hubAddress: initial.hubAddress,
    hubPort: initial.hubPort,
    agentName: initial.agentName,
    defaultAgentName: initial.defaultAgentName,
  })
}
