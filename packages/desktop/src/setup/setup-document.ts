/**
 * The setup window's shell: one `data:text/html` document, themed to match
 * admin-ui's `camstack-theme.css` palette so it blends with the UI it
 * transitions into. Both products render their own BODY into it — the chrome,
 * the palette and the error line are shared so the two forms cannot drift.
 */
export interface SetupDocument {
  /** Everything above the form. */
  readonly body: string
  /** The form's inline script — one `camstackSetup.save` call per product. */
  readonly script: string
  /** The submit button's text. */
  readonly submitLabel: string
}

export function setupDocument(content: SetupDocument): string {
  return `<!doctype html>
<html><head><meta charset="utf-8" /><title>CamStack — Setup</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    padding: 24px 28px; margin: 0; background: #0c0a09; color: #fafaf9;
  }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 6px; }
  .sub { font-size: 12px; color: #a8a29e; margin: 0 0 18px; }
  .label { font-size: 12px; font-weight: 600; color: #fafaf9; margin: 14px 0 6px; }
  .toggle {
    display: flex; gap: 4px; padding: 3px;
    background: #1c1917; border: 1px solid #292524;
    border-radius: 8px; margin-bottom: 6px;
  }
  .toggle label {
    flex: 1; padding: 7px 10px; text-align: center;
    font-size: 12px; font-weight: 500; border-radius: 6px;
    cursor: pointer; user-select: none;
    color: #a8a29e; transition: background 0.15s, color 0.15s;
  }
  .toggle input[type="radio"] { display: none; }
  .toggle input[type="radio"]:checked + span {
    display: block; padding: 5px 8px; border-radius: 4px;
    background: #f59e42; color: #0c0a09;
    box-shadow: 0 1px 2px rgba(0,0,0,0.3);
  }
  .mode-info {
    font-size: 12px; color: #a8a29e;
    padding: 8px 10px; background: #1c1917;
    border: 1px solid #292524; border-radius: 6px;
    margin-bottom: 14px; line-height: 1.4;
  }
  label.field {
    display: block; font-size: 12px; font-weight: 500;
    margin-top: 12px; margin-bottom: 4px; color: #fafaf9;
  }
  input[type="text"], input[type="number"], input[type="password"] {
    width: 100%; padding: 7px 9px; font-size: 13px;
    background: #0c0a09; color: #fafaf9;
    border: 1px solid #292524; border-radius: 6px;
  }
  input:focus { outline: none; border-color: #f59e42; }
  input:disabled { background: #1c1917; color: #57534e; }
  .row { display: flex; gap: 8px; }
  .row .field-wrap { flex: 1; }
  .row .field-wrap.short { flex: 0 0 100px; }
  button {
    margin-top: 22px; padding: 9px 16px;
    font-size: 13px; font-weight: 600;
    background: #f59e42; color: #0c0a09;
    border: none; border-radius: 6px; cursor: pointer; width: 100%;
    transition: background 0.15s;
  }
  button:hover { background: #fbcd8a; }
  .err { color: #f87171; font-size: 12px; margin-top: 8px; min-height: 14px; }
  small { color: #78716c; }
</style></head>
<body>
${content.body}

<form id="f">
  <div class="err" id="err"></div>
  <button type="submit" id="save">${content.submitLabel}</button>
</form>

<script>
  const form = document.getElementById('f');
  const errEl = document.getElementById('err');
${content.script}
</script>
</body></html>`
}
