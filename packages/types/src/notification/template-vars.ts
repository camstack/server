/**
 * THE declared `{{var}}` vocabulary of notification templates.
 *
 * Before this file the only source was the maps three producers build at
 * render time (`buildTemplateVars`, the timelapse and the digest
 * `templateVars`), and every editor kept its own hand list — one advertised
 * `{{tiles}}`, which nothing ever supplied. The parity specs in
 * `addon-post-analysis` run each producer and compare its keys with this list,
 * so the two cannot drift silently again.
 */
import {
  NcRuleKindSchema,
  NcTemplateFamilySchema,
  NcTemplateFieldSchema,
  NcTemplateVarContextSchema,
  NcTemplateVarDescriptorSchema,
  NcTemplateVarGroupSchema,
  type NcSystemEventKind,
  type NcTemplateVarContext,
  type NcTemplateVarDescriptor,
  type NcTemplateVarKind,
} from '../capabilities/notification-rules.cap.js'
import { isSystemRuleKind, type NcRuleKind, systemFamilyOfKind } from './rule-kinds.js'
import { systemEventKindsOfFamily } from './system-event-families.js'

export {
  NcRuleKindSchema,
  NcTemplateFamilySchema,
  NcTemplateFieldSchema,
  NcTemplateVarContextSchema,
  NcTemplateVarDescriptorSchema,
  NcTemplateVarGroupSchema,
}
export type {
  NcTemplateFamily,
  NcTemplateField,
  NcTemplateVarContext,
  NcTemplateVarDescriptor,
  NcTemplateVarGroup,
} from '../capabilities/notification-rules.cap.js'

const RULE_BODY_ONLY = ['body'] as const
const RULE_TEXT = ['title', 'body'] as const

const BATTERY: readonly NcSystemEventKind[] = ['device-battery-low', 'device-battery-normal']
const CONSUMABLE: readonly NcSystemEventKind[] = [
  'device-consumable-low',
  'device-consumable-normal',
]
const ALERT_EPISODE: readonly NcSystemEventKind[] = [
  'alert-critical',
  'alert-error',
  'alert-critical-resolved',
]
const DEVICE_ATTENTION: readonly NcSystemEventKind[] = [
  'device-attention-required',
  'device-attention-resolved',
]
const UPDATES: readonly NcSystemEventKind[] = [
  'addon-update-available',
  'server-update-available',
  'wrapper-update-available',
]
// `wrapper-update-available`'s textParams (event-intake.ts, `incomingFromWrapperUpdate`)
// carry only currentVersion/latestVersion/nodeId — never a package name or a
// count. Those two vars are offered for the other two UPDATES members only.
const PACKAGE_UPDATES: readonly NcSystemEventKind[] = [
  'addon-update-available',
  'server-update-available',
]
const ALARM: readonly NcSystemEventKind[] = [
  'alarm-triggered',
  'alarm-armed',
  'alarm-disarmed',
  'alarm-arming',
  'alarm-arm-refused',
  'alarm-pending',
  'alarm-rearmed',
  // The row is about the SENSOR (its name is the title).
  'alarm-sensor-bypass',
  'alarm-check-failed',
]
// The COMBINED alarm row (event-intake.ts `combinedAlarmText`): an alarm a
// DETECTION rule set off speaks that rule's vocabulary — class, identity, zones,
// confidence — frozen on `alarmSource` and read by `buildTemplateVars`
// (dispatcher.ts). Empty on a manual trigger, like `label` on an unrecognised
// person.
const COMBINED_ALARM: readonly NcSystemEventKind[] = ['alarm-triggered']
const DEVICE_EVENTS: readonly NcSystemEventKind[] = [
  'device-online',
  'device-offline',
  'device-disabled',
  'device-enabled',
  ...BATTERY,
  ...CONSUMABLE,
  'stream-online',
  'stream-offline',
  'detection-blind',
  'motion-noisy',
  'motion-calm',
  'package-llm-silent',
  'package-llm-answered',
  'recording-stalled',
  'recording-healthy',
  'recording-degraded',
  ...DEVICE_ATTENTION,
  ...ALARM,
]

/** Every kind a summary may speak about — the two summarisable families. */
const SUMMARISABLE: readonly NcSystemEventKind[] = [
  ...systemEventKindsOfFamily('device-events'),
  ...systemEventKindsOfFamily('system'),
]

/** One per summary SECTION (`NC_STATE_SUMMARY_SECTIONS` in the notification
 *  centre): the section's lines, offered when one of its kinds is selected. */
const STATE_SUMMARY_SECTION_VARS: readonly {
  readonly name: string
  readonly label: string
  readonly example: string
  readonly kinds: readonly NcSystemEventKind[]
}[] = [
  {
    name: 'summaryDevices',
    label: 'Summary: devices offline / switched off',
    example: 'Garage — offline since 07:12',
    kinds: ['device-offline', 'device-online', 'device-disabled', 'device-enabled'],
  },
  {
    name: 'summaryStreams',
    label: 'Summary: streams offline',
    example: 'Front door (high) — since 06:40',
    kinds: ['stream-offline', 'stream-online'],
  },
  {
    name: 'summaryBattery',
    label: 'Summary: low batteries',
    example: 'Sensore porta — 8 %',
    kinds: BATTERY,
  },
  {
    name: 'summaryConsumables',
    label: 'Summary: consumables',
    example: 'Robot — filter 10 %',
    kinds: CONSUMABLE,
  },
  {
    name: 'summaryDetection',
    label: 'Summary: cameras detecting nothing',
    example: 'Front door — since 05:10',
    kinds: ['detection-blind'],
  },
  {
    name: 'summaryNodes',
    label: 'Summary: nodes',
    example: 'agent-a — offline since 03:00',
    kinds: ['node-offline', 'node-online', 'node-restarting', 'node-inference-unavailable'],
  },
  {
    name: 'summaryAddons',
    label: 'Summary: addons stopped',
    example: 'hub — recorder stopped after repeated crashes',
    kinds: ['addon-crash-loop'],
  },
  {
    name: 'summaryAddonUpdates',
    label: 'Summary: addon updates',
    example: 'hub:\n• @camstack/addon-recorder 1.2.3 → 1.2.4',
    kinds: ['addon-update-available', 'addon-updated'],
  },
  {
    name: 'summaryUpdates',
    label: 'Summary: server & container updates',
    example: 'server 1.2.377 → 1.2.378',
    kinds: [
      'server-update-available',
      'node-updating',
      'server-updated',
      'wrapper-update-available',
    ],
  },
]

const STATE_SUMMARY_VARS: readonly NcTemplateVarDescriptor[] = [
  {
    name: 'summaryText',
    label: 'Summary: every section',
    description: 'One block per section with something to report, one line per item.',
    example: 'Batterie scariche: Sensore porta — 8 %',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...SUMMARISABLE],
    systemEventDeliveries: ['summary'],
  },
  {
    name: 'summaryCount',
    label: 'Summary: items reported',
    example: '3',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...SUMMARISABLE],
    systemEventDeliveries: ['summary'],
  },
  {
    name: 'summarySection',
    label: 'Summary: this section',
    description:
      'The section a per-section summary row is about; on a summary sent as one message, every section it reports, comma-separated.',
    example: 'Batterie scariche',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...SUMMARISABLE],
    systemEventDeliveries: ['summary'],
  },
  ...STATE_SUMMARY_SECTION_VARS.map(
    (v): NcTemplateVarDescriptor => ({
      name: v.name,
      label: v.label,
      example: v.example,
      group: 'system',
      families: ['rule'],
      fields: [...RULE_TEXT],
      kinds: ['system'],
      systemEventKinds: [...v.kinds],
      systemEventDeliveries: ['summary'],
    }),
  ),
]

export const NC_TEMPLATE_VARS: readonly NcTemplateVarDescriptor[] = [
  // ── Ordinary rules: subject ────────────────────────────────────────────
  {
    name: 'camera',
    label: 'Camera',
    example: 'Front door',
    group: 'subject',
    families: ['rule', 'timelapse'],
    // Every non-system kind has a camera. On a SYSTEM rule only the kinds whose
    // intake freezes a device (event-intake.ts: `deviceTextParams` / the export's
    // optional `deviceId`) have one — a node, backup or update row renders the
    // filler `NC_DEVICELESS_CAMERA_NAME` ('system', dispatcher.ts
    // `notificationDeviceName`), which is not a name worth offering.
    systemEventKinds: [...DEVICE_EVENTS, 'export-completed'],
  },
  {
    name: 'class',
    label: 'Detected class',
    description: 'The wire class id (e.g. "person", "cat"); the counted class on an occupancy row.',
    example: 'person',
    group: 'subject',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['detection', 'sensor', 'sound', 'occupancy', 'system'],
    systemEventKinds: [...COMBINED_ALARM],
  },
  {
    name: 'classLabel',
    label: 'Detected class (translated)',
    description:
      'Human label of {{class}} in the notification language (EVENT_KIND_LABELS); falls back to the raw id.',
    example: 'Persona',
    group: 'subject',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['detection', 'sensor', 'sound', 'occupancy', 'system'],
    systemEventKinds: [...COMBINED_ALARM],
  },
  {
    name: 'label',
    label: 'Name or plate',
    description: 'Recognised person or read plate; empty otherwise.',
    example: 'Mario',
    group: 'subject',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['detection', 'system'],
    systemEventKinds: [...COMBINED_ALARM],
  },
  // `system` is deliberately absent: on a system row `buildTemplateVars`
  // (dispatcher.ts) resolves `subject` to the event's DEDUP SLOT key (e.g.
  // `battery:102`, `wrapper:hub` — event-intake.ts), never a composed sentence.
  {
    name: 'subject',
    label: 'Subject sentence',
    description: 'Composed in the notification language, e.g. "person (Mario)".',
    example: 'persona (Mario)',
    group: 'subject',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['detection', 'sensor', 'sound', 'occupancy'],
  },
  {
    name: 'confidence',
    label: 'Confidence',
    example: '87%',
    group: 'subject',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['detection', 'system'],
    systemEventKinds: [...COMBINED_ALARM],
  },
  {
    name: 'count',
    label: 'Count',
    description:
      'Occupancy count, subjects in a grouped notification, or the event count of a system notice.',
    example: '3',
    group: 'subject',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['detection', 'occupancy', 'system'],
    systemEventKinds: ['addon-crash-loop', ...PACKAGE_UPDATES, 'addon-updated'],
  },
  {
    name: 'detectionSummary',
    label: 'Detection summary',
    description: 'Class composition, e.g. "2 persons and 1 car".',
    example: '2 persone e 1 auto',
    group: 'subject',
    families: ['rule', 'timelapse', 'summary'],
    fields: [...RULE_TEXT],
    kinds: ['detection'],
  },
  // ── Ordinary rules: place ──────────────────────────────────────────────
  {
    name: 'zones',
    label: 'Zones',
    example: 'Cancello, Vialetto',
    group: 'place',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['detection', 'system'],
    systemEventKinds: [...COMBINED_ALARM],
  },
  {
    name: 'zone',
    label: 'Zone',
    example: 'Cancello',
    group: 'place',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['detection', 'occupancy', 'system'],
    systemEventKinds: [...COMBINED_ALARM],
  },
  {
    name: 'inZones',
    label: '"in <zones>" fragment',
    description: 'Leading space included; empty when no zone.',
    example: ' in Cancello',
    group: 'place',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['detection', 'system'],
    systemEventKinds: [...COMBINED_ALARM],
  },
  {
    name: 'scope',
    label: 'Occupancy scope',
    example: 'Cancello',
    group: 'place',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['occupancy'],
  },
  // ── Time / rule ────────────────────────────────────────────────────────
  {
    name: 'time',
    label: 'Time',
    description: 'Hours and minutes, in the notification language.',
    example: '20:05',
    group: 'time',
    families: ['rule', 'timelapse', 'summary'],
    fields: [...RULE_TEXT],
  },
  {
    name: 'rule',
    label: 'Rule name',
    example: 'Front door notte',
    group: 'rule',
    families: ['rule', 'timelapse', 'summary'],
  },
  {
    name: 'from',
    label: 'Window start',
    example: '07:00',
    group: 'time',
    families: ['timelapse', 'summary'],
  },
  {
    name: 'to',
    label: 'Window end',
    example: '08:00',
    group: 'time',
    families: ['timelapse', 'summary'],
  },
  // ── Occupancy ──────────────────────────────────────────────────────────
  {
    name: 'capacity',
    label: 'Capacity',
    example: '2',
    group: 'occupancy',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['occupancy'],
  },
  {
    name: 'op',
    label: 'Occupied / free',
    example: 'occupata',
    group: 'occupancy',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['occupancy'],
  },
  // ── Sound (NEW) ────────────────────────────────────────────────────────
  {
    name: 'sounds',
    label: 'Sounds heard',
    example: 'abbaio, clacson',
    group: 'sound',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['sound'],
  },
  {
    name: 'hitPercent',
    label: 'Share of the window',
    description: 'Level mode only: percentage of samples above the threshold.',
    example: '42',
    group: 'sound',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['sound'],
  },
  {
    name: 'db',
    label: 'Peak level (dBFS)',
    example: '-18',
    group: 'sound',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['sound'],
  },
  // ── Sensor (NEW) ───────────────────────────────────────────────────────
  {
    name: 'eventType',
    label: 'Event type',
    description:
      'Raw device event token, e.g. "press" or "open"; empty when the device sends none.',
    example: 'press',
    group: 'sensor',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['sensor'],
  },
  // ── AI ─────────────────────────────────────────────────────────────────
  {
    name: 'ai',
    label: 'AI sentence',
    description: 'Where the AI description goes; appended on its own line when absent.',
    example: 'Una persona lascia un pacco.',
    group: 'ai',
    families: ['rule', 'summary'],
    fields: [...RULE_BODY_ONLY],
    kinds: ['detection', 'occupancy'],
  },
  // ── System events ──────────────────────────────────────────────────────
  {
    name: 'eventKind',
    label: 'Event kind',
    example: 'device-offline',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    // A state summary (D647) is about every kind of its rule at once: no one
    // kind is "the" event, so the row leaves it empty.
    systemEventDeliveries: ['instant'],
  },
  {
    name: 'deviceName',
    label: 'Device',
    example: 'Front door',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...DEVICE_EVENTS],
  },
  {
    // D706: where an alarm a rule set off went — the location (else name) of the device
    // that started it and of every match during its entry delay, in arrival order.
    name: 'locations',
    label: 'Intrusion locations',
    example: 'Front door, Hallway, Hall',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...COMBINED_ALARM],
  },
  {
    name: 'deviceId',
    label: 'Device id',
    example: '102',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...DEVICE_EVENTS, 'export-completed'],
  },
  {
    name: 'percentage',
    label: 'Percentage',
    example: '15',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...BATTERY, ...CONSUMABLE],
  },
  {
    name: 'item',
    label: 'Consumable',
    description: "The device's own name for the item: a filter, a brush, the salt, a tank.",
    example: 'Filtro',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...CONSUMABLE],
  },
  {
    name: 'profile',
    label: 'Stream profile',
    example: 'high',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['stream-online', 'stream-offline'],
  },
  {
    name: 'node',
    label: 'Node',
    example: 'hub',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    // `systemEvent.nodeId` (dispatcher.ts `buildTemplateVars`) — set by every
    // node-scoped intake, including the completed updates, whose TEXT params
    // carry no `nodeId` on `addon-updated`. A node-less event (e.g.
    // `backup-completed`) leaves it blank.
    systemEventKinds: [
      'node-online',
      'node-offline',
      'node-restarting',
      'node-updating',
      'node-inference-unavailable',
      'addon-crash-loop',
      ...UPDATES,
      'addon-updated',
      'server-updated',
      'storage-location-low',
      'storage-location-critical',
      'storage-location-ok',
      ...ALERT_EPISODE,
    ],
  },
  {
    name: 'nodeId',
    label: 'Node id',
    example: 'hub',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [
      'node-online',
      'node-offline',
      'node-restarting',
      'node-updating',
      'node-inference-unavailable',
      'addon-crash-loop',
      ...UPDATES,
      'server-updated',
      'storage-location-low',
      'storage-location-critical',
      'storage-location-ok',
      ...ALERT_EPISODE,
    ],
  },
  {
    // Frozen at intake as the id, swapped for the node directory's display
    // name after the node liveness hold-off (notification-center
    // `withNodeLivenessFacts`). Never blank on a node liveness row.
    name: 'nodeName',
    label: 'Node name',
    example: 'agent-a',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['node-online', 'node-offline'],
  },
  {
    // Recovery only: how long the node was offline ("44 min"). Blank when the
    // outage start is unknown (the offline state was only seeded at boot).
    name: 'offlineFor',
    label: 'Offline for',
    example: '44 min',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['node-online'],
  },
  {
    name: 'devices',
    label: 'Devices',
    description:
      'node-inference-unavailable: the affected cameras, comma-joined. Alarm arm / arming / refusal: HOW MANY devices are armed (or open).',
    example: 'Front door, Garage',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [
      'node-inference-unavailable',
      'alarm-armed',
      'alarm-arming',
      'alarm-arm-refused',
    ],
  },
  {
    name: 'addons',
    label: 'Addons',
    example: 'stream-broker',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['addon-crash-loop'],
  },
  {
    name: 'minutes',
    label: 'Minutes',
    example: '12',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['detection-blind', 'motion-noisy', 'motion-calm', 'recording-stalled'],
  },
  {
    name: 'duty',
    label: 'Motion share (%)',
    example: '55',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['motion-noisy', 'motion-calm'],
  },
  {
    name: 'sessions',
    label: 'Detection sessions',
    example: '96',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['detection-blind', 'motion-noisy', 'motion-calm'],
  },
  {
    name: 'message',
    label: 'Detail',
    example: 'writer restart budget exhausted',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [
      'recording-degraded',
      ...DEVICE_ATTENTION,
      ...ALERT_EPISODE,
      'package-llm-silent',
    ],
  },
  {
    name: 'ruleName',
    label: 'Rule name',
    example: 'Robot',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['rule-broken', 'rule-repaired'],
  },
  {
    name: 'ruleId',
    label: 'Rule id',
    example: '3db3e226-9b82-4681-a200-de13b260aa48',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['rule-broken', 'rule-repaired'],
  },
  {
    name: 'brokenReason',
    label: 'Why the rule is broken',
    description: 'unparseable, device-deleted or target-deleted',
    example: 'device-deleted',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['rule-broken'],
  },
  {
    name: 'offendingIds',
    label: 'Deleted devices or destinations',
    example: '4483',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['rule-broken'],
  },
  {
    name: 'locationName',
    label: 'Storage location',
    example: 'Recordings',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['storage-location-low', 'storage-location-critical', 'storage-location-ok'],
  },
  {
    name: 'locationId',
    label: 'Storage location id',
    example: 'recordings:default',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['storage-location-low', 'storage-location-critical', 'storage-location-ok'],
  },
  {
    name: 'freePercent',
    label: 'Free space (%)',
    example: '12',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    // Only when the probe returned a number — a critical unreadable probe
    // leaves it unset (null → omitted), so critical is not listed here.
    systemEventKinds: ['storage-location-low'],
  },
  {
    name: 'reason',
    label: 'Reason',
    example: 'capacity-unreadable',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [
      'storage-location-low',
      'storage-location-critical',
      'storage-location-ok',
      'package-llm-silent',
    ],
  },
  {
    name: 'package',
    label: 'Package',
    example: '@camstack/addon-recorder',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...UPDATES, 'addon-updated', 'node-updating', 'server-updated'],
  },
  {
    name: 'packageName',
    label: 'Package',
    example: '@camstack/addon-recorder',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...PACKAGE_UPDATES, 'node-updating', 'server-updated'],
  },
  {
    name: 'nodes',
    label: 'Nodes',
    description:
      'Comma-joined node ids, when an update spans more than one — the single-node case names it through {{nodeId}} instead. `incomingFromUpdateAvailable` (event-intake.ts) fills `nodes` from ONE shared textParams object for both addon- and server-update-available, exactly like packageName/currentVersion/latestVersion/count — only the shipped TEXT (system.server-update-available.body.onNodes) reads it today, but the var is real on both kinds.',
    example: 'hub, agent-a',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...PACKAGE_UPDATES],
  },
  {
    name: 'currentVersion',
    label: 'Current version',
    example: '1.2.377',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...UPDATES],
  },
  {
    name: 'latestVersion',
    label: 'Latest version',
    example: '1.2.378',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...UPDATES],
  },
  {
    name: 'list',
    label: 'Updated packages',
    description:
      'One line per package. `incomingFromUpdateAvailable` fills it for addon-/server-update-available too (the SAME shared textParams object as `nodes`) — `system.addon-update-available.body` reads it; `incomingFromAddonUpdates` fills it again, independently, for the completed `addon-updated` event.',
    example: 'recorder, notifiers',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...PACKAGE_UPDATES, 'addon-updated'],
  },
  {
    name: 'fromVersion',
    label: 'From version',
    example: '1.2.377',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['node-updating', 'server-updated'],
  },
  {
    name: 'toVersion',
    label: 'To version',
    example: '1.2.378',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['node-updating', 'server-updated'],
  },
  {
    name: 'destinationsOk',
    label: 'Destinations ok',
    example: '2',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['backup-completed'],
  },
  {
    name: 'destinationsTotal',
    label: 'Destinations',
    example: '2',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['backup-completed'],
  },
  {
    name: 'destinationsFailed',
    label: 'Destinations failed',
    example: '0',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['backup-completed'],
  },
  {
    name: 'sizeMB',
    label: 'Size (MB)',
    example: '412',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['backup-completed'],
  },
  {
    name: 'backupId',
    label: 'Backup id',
    example: 'bk-20260924',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['backup-completed'],
  },
  {
    name: 'title',
    label: 'Export or alert title',
    example: 'Front door 08:00',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['export-completed', ...DEVICE_ATTENTION, ...ALERT_EPISODE],
  },
  {
    name: 'severity',
    label: 'Alert severity',
    example: 'critical',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...ALERT_EPISODE],
  },
  {
    name: 'category',
    label: 'Alert category',
    example: 'addon.runner-failed',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: [...DEVICE_ATTENTION, ...ALERT_EPISODE],
  },
  {
    name: 'source',
    label: 'Alert source (addon, node or runner)',
    example: 'recorder',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    // Empty when the alert names no source.
    systemEventKinds: [...ALERT_EPISODE],
  },
  {
    name: 'actionUrl',
    label: 'Alert action link',
    example: '/system/addons',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    // Empty when the alert carries no action link.
    systemEventKinds: [...DEVICE_ATTENTION, ...ALERT_EPISODE],
  },
  {
    name: 'exportId',
    label: 'Export id',
    example: 'exp-20260924',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['export-completed'],
  },
  {
    name: 'bytes',
    label: 'Export size (bytes)',
    example: '10485760',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['export-completed'],
  },
  {
    name: 'mode',
    label: 'Alarm mode',
    example: 'away',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    // A disarm, a trigger and a sensor bypass carry no mode
    // (`NcAlarmTransition.mode`).
    systemEventKinds: [
      'alarm-armed',
      'alarm-arming',
      'alarm-arm-refused',
      'alarm-pending',
      'alarm-rearmed',
      'alarm-check-failed',
    ],
  },
  {
    name: 'seconds',
    label: 'Seconds',
    description: 'Arming: the exit delay left. Pending: the entry delay left to disarm.',
    example: '30',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['alarm-arming', 'alarm-pending'],
  },
  // The coverage params the alarm's arm / arming / refusal bodies freeze
  // (alarm-mode-coverage.ts `buildArm*Announcement`).
  {
    name: 'rules',
    label: 'Covering rules',
    description: 'How many enabled rules the armed / arming mode gates.',
    example: '2',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['alarm-armed', 'alarm-arming'],
  },
  {
    name: 'names',
    label: 'Device names',
    description:
      'Armed / arming: the Active devices (or every skipped name when none are Active). Refusal: the open sensors.',
    example: 'Front door, Garage',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['alarm-armed', 'alarm-arming', 'alarm-arm-refused'],
  },
  {
    name: 'skippedNames',
    label: 'Skipped devices',
    description: 'Devices the mode names but cannot arm (muted, detection off, offline).',
    example: 'Garage',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['alarm-armed', 'alarm-arming'],
  },
  {
    name: 'active',
    label: 'Active count',
    description:
      'How many named devices the armed / arming mode is watching (title: n attivi / n active).',
    example: '3',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['alarm-armed', 'alarm-arming'],
  },
  {
    name: 'skipped',
    label: 'Skipped count',
    description:
      'How many named devices the mode cannot arm — muted, detection off, offline, or Arm-anyway exclusions (title: m saltati).',
    example: '1',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['alarm-armed', 'alarm-arming'],
  },
  {
    name: 'bypassedNames',
    label: 'Bypassed sensors',
    description: 'Sensors the operator armed around because they were open.',
    example: 'Finestra porch',
    group: 'system',
    families: ['rule'],
    fields: [...RULE_TEXT],
    kinds: ['system'],
    systemEventKinds: ['alarm-armed', 'alarm-arming'],
  },
  // ── Timelapse / digest ─────────────────────────────────────────────────
  {
    name: 'coverage',
    label: 'Coverage %',
    example: '96',
    group: 'digest',
    families: ['timelapse'],
    fields: [...RULE_TEXT],
  },
  {
    name: 'events',
    label: 'Events',
    example: '4',
    group: 'digest',
    families: ['timelapse', 'summary'],
    fields: [...RULE_TEXT],
  },
  {
    name: 'detections',
    label: 'Detections',
    example: '7',
    group: 'digest',
    families: ['timelapse', 'summary'],
    fields: [...RULE_TEXT],
  },
  {
    name: 'count_person',
    label: 'Count of one class',
    description: 'count_<class>, e.g. count_person, count_car.',
    example: '3',
    group: 'digest',
    families: ['timelapse', 'summary'],
    fields: [...RULE_TEXT],
    dynamic: { prefix: 'count_', from: 'classes' },
  },
  {
    name: 'cameras',
    label: 'Cameras',
    example: '3',
    group: 'digest',
    families: ['summary'],
    fields: [...RULE_TEXT],
  },
  {
    name: 'matched',
    label: 'Matched events',
    example: '12',
    group: 'digest',
    families: ['summary'],
    fields: [...RULE_TEXT],
  },
  {
    name: 'shown',
    label: 'Events shown',
    example: '9',
    group: 'digest',
    families: ['summary'],
    fields: [...RULE_TEXT],
  },
  {
    name: 'total',
    label: 'Events total',
    example: '12',
    group: 'digest',
    families: ['summary'],
    fields: [...RULE_TEXT],
  },
  // ── The STATE SUMMARY of a system rule (D647) ──────────────────────────
  //
  // Filled only on a summary row (`systemEventDeliveries: ['summary']`), and
  // HELD BACK from the served catalog: an installed viewer ignores the axis
  // and would offer them on every instant system rule, where they are empty.
  ...STATE_SUMMARY_VARS,
]

/**
 * System-event kinds the SERVED catalog holds back (D642): the kinds the hub
 * produces before the installed viewers can parse them.
 *
 * The viewer parses `getTemplateCatalog` WHOLE, with its own strict
 * `NcSystemEventKindSchema` on every descriptor's `systemEventKinds`, so one
 * kind it does not know — in `{{deviceName}}`, which every device event names —
 * empties every {{var}} picker on every phone (the same trap
 * `NcTemplateVarKindSchema` froze the rule kinds for). The in-process catalog
 * keeps them: the producer parity and the preview render read it.
 *
 * SELF-EXPIRING: `scripts/check-nc-mirrors-in-sync.ts` reads this list as the
 * viewer's allowance and fails the day the viewer mirrors one of these kinds —
 * delete it from here then, and the served catalog names it again.
 */
export const NC_TEMPLATE_HELD_BACK_SYSTEM_EVENT_KINDS: readonly NcSystemEventKind[] = [
  // D723: a phone that has not installed the OTA mirroring these two would
  // fail the whole catalog parse on `{{node}}` — held back like the tanks.
  'node-restarting',
  'node-updating',
  // The alert-centre episode kinds: a phone that has not installed the OTA
  // mirroring them would fail the catalog parse on `{{severity}}`.
  'alert-critical',
  'alert-error',
  'alert-critical-resolved',
  // D911: the device-attention kinds share the alert vocabulary (`{{title}}`,
  // `{{actionUrl}}`) a phone without the OTA does not know.
  'device-attention-required',
  'device-attention-resolved',
  // D905: a phone that has not installed the OTA mirroring the rule-health
  // kinds would fail the whole catalog parse on them.
  'rule-broken',
  'rule-repaired',
  // D931: the package-confirm pair. A phone that has not mirrored the kinds
  // would fail the catalog parse on them. `message` carries the last latency.
  'package-llm-silent',
  'package-llm-answered',
]

/**
 * The catalog as `getTemplateCatalog` SERVES it: every descriptor, with the
 * held-back kinds removed from its `systemEventKinds`. A descriptor that named
 * only held-back kinds is served with an empty list — offered to no system
 * rule an installed viewer can author, which is exactly true.
 */
export function servedTemplateVars(): NcTemplateVarDescriptor[] {
  return NC_TEMPLATE_VARS.filter((d) => !isHeldBackTemplateVar(d)).map((d) =>
    d.systemEventKinds === undefined
      ? d
      : {
          ...d,
          systemEventKinds: d.systemEventKinds.filter(
            (kind) => !NC_TEMPLATE_HELD_BACK_SYSTEM_EVENT_KINDS.includes(kind),
          ),
        },
  )
}

/**
 * Is this descriptor held back from the SERVED catalog as a whole (D647)?
 * A summary-only variable is: an installed viewer does not read the delivery
 * axis, and would offer it on every instant system rule. The admin, built
 * from the workspace, restores it from its own `NC_TEMPLATE_VARS`.
 */
export function isHeldBackTemplateVar(d: NcTemplateVarDescriptor): boolean {
  return d.systemEventDeliveries !== undefined && !d.systemEventDeliveries.includes('instant')
}

/**
 * Does a descriptor have a value on a system rule of this DELIVERY (D647)?
 * Read only for a system rule kind. An absent axis is `instant` for a
 * descriptor that names `systemEventKinds` (a per-event fact: a summary row
 * has no one device, node or package) and BOTH for one that does not
 * (`{{rule}}`, `{{time}}`).
 */
export function templateVarDeliveryApplies(
  d: NcTemplateVarDescriptor,
  ctx: NcTemplateVarContext,
): boolean {
  if (!isSystemRuleKind(ctx.kind)) return true
  const mode = ctx.systemEventDelivery ?? 'instant'
  const declared =
    d.systemEventDeliveries ?? (d.systemEventKinds !== undefined ? ['instant'] : [mode])
  return declared.includes(mode)
}

/** The caption fields see a fixed, smaller vocabulary (`timelapsePreviewText`,
 *  `summaryCaptionText`). Declared here rather than as `fields` on every
 *  descriptor so the whole rule stays in one line of code. */
const CAPTION_VARS: Readonly<Record<'previewText' | 'captionText', readonly string[]>> = {
  previewText: ['camera', 'rule', 'from', 'to'],
  captionText: ['rule', 'from', 'to'],
}

function onAxis<T>(declared: readonly T[] | undefined, asked: T | undefined): boolean {
  return declared === undefined || asked === undefined || declared.includes(asked)
}

/**
 * Does a descriptor declared for `declared` kinds have a value for a rule of
 * `kind`?
 *
 * `system` on the WIRE stands for every system rule kind (D637): the served
 * catalog keeps the five pre-D637 tokens so installed viewers still parse it
 * (`NcTemplateVarKindSchema`), and the family split lives here, in the match.
 * Exported so the admin's local interpreter of the served catalog asks the
 * same question instead of restating it.
 */
export function templateVarKindApplies(
  declared: readonly NcTemplateVarKind[] | undefined,
  kind: NcRuleKind | undefined,
): boolean {
  if (declared === undefined || kind === undefined) return true
  if (declared.some((k) => k === kind)) return true
  return isSystemRuleKind(kind) && declared.includes('system')
}

/**
 * Is a descriptor that names `systemEventKinds` on the event-kind axis of a
 * system rule? Read only for a system rule kind; any other kind ignores it.
 *
 * Event kinds chosen: the descriptor must speak about one of them. None chosen
 * yet: a FAMILY kind watches its own family's event kinds (a device-events rule
 * is never offered the alarm's `{{mode}}`), and `mixed` watches all of them.
 */
export function templateVarSystemEventApplies(
  d: NcTemplateVarDescriptor,
  ctx: NcTemplateVarContext,
): boolean {
  if (!isSystemRuleKind(ctx.kind) || d.systemEventKinds === undefined) return true
  const declared = d.systemEventKinds
  const asked = ctx.systemEventKinds ?? []
  if (asked.length > 0) return asked.some((k) => declared.includes(k))
  const family = ctx.kind === undefined ? undefined : systemFamilyOfKind(ctx.kind)
  if (family === undefined) return true
  const own = systemEventKindsOfFamily(family)
  return declared.some((k) => own.includes(k))
}

/**
 * The variables that have a value in `ctx`, in catalog order. Pure.
 *
 * `ctx` is trusted, typed input — untrusted input (a served/RPC boundary) is
 * validated once against {@link NcTemplateVarContextSchema} at the cap/bridge
 * boundary, not re-parsed on every call here (Task 4).
 */
export function templateVarsFor(ctx: NcTemplateVarContext): NcTemplateVarDescriptor[] {
  if (ctx.field === 'previewText' || ctx.field === 'captionText') {
    const allowed = CAPTION_VARS[ctx.field]
    return NC_TEMPLATE_VARS.filter(
      (d) => d.families.includes(ctx.family) && allowed.includes(d.name) && d.dynamic === undefined,
    )
  }
  return NC_TEMPLATE_VARS.filter(
    (d) =>
      d.families.includes(ctx.family) &&
      onAxis(d.fields, ctx.field) &&
      templateVarKindApplies(d.kinds, ctx.kind) &&
      onAxis(d.deliveries, ctx.delivery) &&
      templateVarSystemEventApplies(d, ctx) &&
      templateVarDeliveryApplies(d, ctx),
  )
}

/** True when `name` is supplied in `ctx`, dynamic families (`count_<class>`) included. */
export function isKnownTemplateVar(name: string, ctx: NcTemplateVarContext): boolean {
  return templateVarsFor(ctx).some((d) =>
    d.dynamic !== undefined
      ? name.startsWith(d.dynamic.prefix) && name.length > d.dynamic.prefix.length
      : d.name === name,
  )
}
