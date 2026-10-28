/**
 * The NODE product's setup window: hub or agent, plus the agent's hub
 * connection.
 *
 * This build stages the `@camstack/server` closure, so both of its roles run a
 * real node. It offers NO viewer option: watching a hub needs none of the
 * 1.1 GB this product carries and ships as its own reduced product instead
 * (ADR-0402). A store still holding the retired `viewer` role arrives here
 * already coerced to `hub` by `roleForProduct`.
 */
import { HUB_PROD_PORT } from '../role/node-url'
import { escapeHtml } from './escape-html'
import type { HubMode } from './hub-mode'
import { setupDocument } from './setup-document'

export interface NodeSetupInitial {
  readonly isAgent: boolean
  readonly hubMode: HubMode
  readonly hubAddress: string
  readonly hubPort: number
  readonly agentName: string
  /** What the agent will be called when the field is left empty. */
  readonly defaultAgentName: string
}

export function renderNodeSetup(initial: NodeSetupInitial): string {
  const isAuto = initial.hubMode === 'auto'
  const isAgent = initial.isAgent
  return setupDocument({
    submitLabel: 'Save and start',
    body: `<h1>Set up this CamStack machine</h1>
<p class="sub">Choose whether this machine runs the CamStack hub or joins an existing hub as a worker.</p>

<div class="label">Role</div>
<div class="toggle">
  <label>
    <input type="radio" name="role" value="hub" ${isAgent ? '' : 'checked'} />
    <span>Hub (full server)</span>
  </label>
  <label>
    <input type="radio" name="role" value="agent" ${isAgent ? 'checked' : ''} />
    <span>Agent (worker)</span>
  </label>
</div>

<div id="roleInfoHub" class="mode-info" style="display:${isAgent ? 'none' : 'block'}">
  This machine runs the full CamStack server and admin UI. Cameras, recording
  and analytics are managed here. The window opens the admin UI on
  https://localhost:${HUB_PROD_PORT}.
</div>
<div id="roleInfoAgent" class="mode-info" style="display:${isAgent ? 'block' : 'none'}">
  This machine joins your CamStack cluster as a worker node and offloads
  inference/decoding for a hub elsewhere on the network.
</div>

<div id="agentConfig" style="display:${isAgent ? 'block' : 'none'}">
  <div class="label">Hub connection</div>
  <div class="toggle">
    <label>
      <input type="radio" name="mode" value="auto" ${isAuto ? 'checked' : ''} />
      <span>Choose later</span>
    </label>
    <label>
      <input type="radio" name="mode" value="manual" ${isAuto ? '' : 'checked'} />
      <span>Manual</span>
    </label>
  </div>

  <div id="modeInfoAuto" class="mode-info" style="display:${isAuto ? 'block' : 'none'}">
    The agent starts without a hub. On the hub open Cluster → Nodes, pick this
    agent under "Agents found on the network" and confirm the same six digits
    on both screens.
  </div>
  <div id="modeInfoManual" class="mode-info" style="display:${isAuto ? 'none' : 'block'}">
    Specify the hub's IP address (or hostname). Use this when the hub is on a
    different subnet or its address is already known.
  </div>

  <div class="row" id="manualFields" style="display:${isAuto ? 'none' : 'flex'}">
    <div class="field-wrap">
      <label class="field" for="hub">Hub address</label>
      <input id="hub" type="text" placeholder="192.168.10.10" value="${escapeHtml(initial.hubAddress)}" ${isAuto ? 'disabled' : ''} />
    </div>
    <div class="field-wrap short">
      <label class="field" for="port">Port</label>
      <input id="port" type="number" min="1" max="65535" value="${initial.hubPort || HUB_PROD_PORT}" />
    </div>
  </div>

  <label class="field" for="name">Agent name <small>(optional)</small></label>
  <input id="name" type="text" placeholder="${escapeHtml(initial.defaultAgentName)}" value="${escapeHtml(initial.agentName)}" />

</div>`,
    script: `  const hubInput = document.getElementById('hub');
  const agentConfig = document.getElementById('agentConfig');
  const roleInfoHub = document.getElementById('roleInfoHub');
  const roleInfoAgent = document.getElementById('roleInfoAgent');
  const infoAuto = document.getElementById('modeInfoAuto');
  const infoManual = document.getElementById('modeInfoManual');
  const manualFields = document.getElementById('manualFields');

  function getRole() { return document.querySelector('input[name="role"]:checked').value; }
  function getMode() { return document.querySelector('input[name="mode"]:checked').value; }

  function applyRole() {
    const agent = getRole() === 'agent';
    agentConfig.style.display = agent ? 'block' : 'none';
    roleInfoHub.style.display = agent ? 'none' : 'block';
    roleInfoAgent.style.display = agent ? 'block' : 'none';
  }
  function applyMode() {
    const m = getMode();
    if (m === 'auto') {
      hubInput.disabled = true;
      manualFields.style.display = 'none';
      infoAuto.style.display = 'block';
      infoManual.style.display = 'none';
    } else {
      hubInput.disabled = false;
      manualFields.style.display = 'flex';
      hubInput.focus();
      infoAuto.style.display = 'none';
      infoManual.style.display = 'block';
    }
  }
  for (const el of document.querySelectorAll('input[name="role"]')) el.addEventListener('change', applyRole);
  for (const el of document.querySelectorAll('input[name="mode"]')) el.addEventListener('change', applyMode);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const role = getRole();
    const mode = getMode();
    const hub = hubInput.value.trim();
    const port = parseInt(document.getElementById('port').value, 10) || ${HUB_PROD_PORT};
    const name = document.getElementById('name').value.trim();
    if (role === 'agent' && mode === 'manual' && !hub) {
      errEl.textContent = 'Hub address is required in Manual mode.';
      hubInput.focus();
      return;
    }
    try {
      await window.camstackSetup.save({ role, hubMode: mode, hubAddress: hub, hubPort: port, agentName: name });
    } catch (err) {
      errEl.textContent = err && err.message ? err.message : String(err);
    }
  });`,
  })
}
