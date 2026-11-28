# packages/addon-provider-zigbee-z2m

Connects to an EXISTING Zigbee2MQTT server over its frontend WebSocket
(`ws[s]://host:port/api[?token=]`, envelope `{ topic, payload }`). One integration
instance = one server (`host`, `port`, `tls`, `token` as a `password` field in the keychain).
One Dominevo device per Zigbee device, keyed by `ieee_address`; `friendly_name` is only the
label and the `<friendly_name>/set` topic, resolved at the moment of a command so a rename is
followed. Independent of `provider-mqtt-ha`: no migration, no dedupe.

- `z2m-protocol.ts` every inbound frame is Zod-parsed here; an unparsable table changes nothing (D49).
- `z2m-client.ts` the socket: injectable factory and timers, bounded backoff, a 4401 close is
  `auth-rejected` and never retried, `request()` correlates by `transaction`.
- `z2m-session.ts` / `z2m-hub.ts` one session per integration, device table, merged state,
  availability; devices subscribe through the hub. Nothing is polled (D224).
- `z2m-exposes.ts` exposes to caps, by standard expose name and unit, never by model. A device
  with several readings is ONE device; power/energy/voltage/current fold into `power-meter`,
  CO2/VOC/PM into `air-quality-sensor`. `fan` is not mapped.
- The first state a device sends after a connect is the server's replay: its `action` is not a press.

## Skills for this package

<!-- camstack-skills-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
Follow the skill; do not reconstruct the procedure (any agent can open the file):

- A new or changed addon or manifest entry; `dominevo deploy` → `camstack-addon` (`.claude/skills/camstack-addon/SKILL.md`)
<!-- camstack-skills-pointer:end -->
