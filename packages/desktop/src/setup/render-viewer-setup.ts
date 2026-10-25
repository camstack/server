/**
 * The VIEWER product's setup window: one field, the hub's address.
 *
 * There is no role picker, because there is no role to pick — this build ships
 * without the `@camstack/server` closure and can only ever watch a hub
 * (ADR-0402). Anything else on this page would be a choice the product cannot
 * honour.
 *
 * Two omissions are deliberate and asserted in the spec:
 *
 *   - it names no agent credential: the viewer holds no credentials at all (it
 *     signs in through the hub's own login page, in the window);
 *   - it never says "auto discovery". The agent's UDP option is Moleculer's
 *     transporter discovery of a NODE; there
 *     is no discovery of an HTTPS UI origin anywhere in this system, and
 *     borrowing the word would promise one.
 */
import { escapeHtml } from './escape-html'
import { setupDocument } from './setup-document'

export function renderViewerSetup(hubUrl: string): string {
  return setupDocument({
    submitLabel: 'Save and connect',
    body: `<h1>Connect to your CamStack hub</h1>
<p class="sub">This app watches a hub you already run. Tell it where that hub is.</p>

<label class="field" for="viewerHub">Hub address</label>
<input id="viewerHub" type="text" placeholder="https://192.168.10.9:4443" value="${escapeHtml(hubUrl)}" />
<div class="mode-info" style="margin-top:8px">
  The full address of the hub, including the port when it is not the default —
  for example <code>https://192.168.10.9:4443</code>, or
  <code>https://camstack.example.com</code> when the hub is reachable through a
  tunnel. CamStack does not search the network for hubs: type the address the
  hub's admin UI shows.
</div>`,
    script: `  const viewerHubInput = document.getElementById('viewerHub');
  viewerHubInput.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const viewerHubUrl = viewerHubInput.value.trim();
    if (!viewerHubUrl) {
      errEl.textContent = "Enter the hub's address, e.g. https://192.168.10.9:4443";
      viewerHubInput.focus();
      return;
    }
    try {
      await window.camstackSetup.save({ role: 'viewer', viewerHubUrl });
    } catch (err) {
      errEl.textContent = err && err.message ? err.message : String(err);
    }
  });`,
  })
}
