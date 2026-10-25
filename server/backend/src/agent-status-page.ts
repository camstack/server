export interface AgentStatusData {
  readonly agentId: string
  readonly agentName: string
  readonly hubUrl: string
  readonly connected: boolean
  readonly activeTaskCount: number
  readonly taskTypes: readonly string[]
  readonly platform: string
  readonly arch: string
  readonly cpuCores: number
  readonly memoryTotalMB: number
  readonly memoryFreeMB: number
  readonly uptime: number
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  parts.push(`${mins}m`)
  return parts.join(' ')
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Render a minimal server-rendered HTML status page for the agent.
 * No React, no build system. Pure HTML + inline CSS.
 * Designed for local debugging only.
 */
export function renderAgentStatusPage(data: AgentStatusData): string {
  const statusColor = data.connected ? '#22c55e' : '#ef4444'
  const statusText = data.connected ? 'Connected' : 'Disconnected'
  const memUsedMB = data.memoryTotalMB - data.memoryFreeMB
  const memPercent = Math.round((memUsedMB / data.memoryTotalMB) * 100)

  const taskTypesList =
    data.taskTypes.length > 0
      ? data.taskTypes.map((t) => `<li>${escapeHtml(t)}</li>`).join('')
      : '<li class="muted">No task handlers registered</li>'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="5">
  <title>CamStack Agent: ${escapeHtml(data.agentName)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0f172a; color: #e2e8f0; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: #94a3b8; font-size: 0.875rem; margin-bottom: 2rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; }
    .card { background: #1e293b; border-radius: 0.75rem; padding: 1.25rem; }
    .card h2 { font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin-bottom: 0.75rem; }
    .stat { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem; }
    .stat-label { font-size: 0.75rem; color: #64748b; }
    .status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 0.5rem; }
    dl { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 1rem; }
    dt { color: #94a3b8; font-size: 0.8125rem; }
    dd { font-size: 0.8125rem; }
    ul { list-style: none; padding: 0; }
    li { font-size: 0.8125rem; padding: 0.25rem 0; font-family: monospace; }
    .muted { color: #64748b; font-style: italic; }
    .bar { height: 6px; background: #334155; border-radius: 3px; overflow: hidden; margin-top: 0.5rem; }
    .bar-fill { height: 100%; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>CamStack Agent</h1>
  <p class="subtitle">${escapeHtml(data.agentId)} &mdash; auto-refreshes every 5s</p>

  <div class="grid">
    <div class="card">
      <h2>Connection</h2>
      <div class="stat">
        <span class="status-dot" style="background:${statusColor}"></span>
        ${statusText}
      </div>
      <dl>
        <dt>Name</dt><dd>${escapeHtml(data.agentName)}</dd>
        <dt>Hub URL</dt><dd>${escapeHtml(data.hubUrl)}</dd>
      </dl>
    </div>

    <div class="card">
      <h2>Hardware</h2>
      <dl>
        <dt>Platform</dt><dd>${escapeHtml(data.platform)} / ${escapeHtml(data.arch)}</dd>
        <dt>CPU Cores</dt><dd>${data.cpuCores}</dd>
        <dt>Uptime</dt><dd>${formatUptime(data.uptime)}</dd>
      </dl>
      <div style="margin-top:0.75rem">
        <div class="stat-label">Memory: ${memUsedMB} / ${data.memoryTotalMB} MB (${memPercent}%)</div>
        <div class="bar"><div class="bar-fill" style="width:${memPercent}%;background:${memPercent > 90 ? '#ef4444' : memPercent > 70 ? '#f59e0b' : '#22c55e'}"></div></div>
      </div>
    </div>

    <div class="card">
      <h2>Tasks</h2>
      <div class="stat">${data.activeTaskCount}</div>
      <div class="stat-label">Active tasks</div>
    </div>

    <div class="card">
      <h2>Registered Task Handlers</h2>
      <ul>${taskTypesList}</ul>
    </div>
  </div>
</body>
</html>`
}
