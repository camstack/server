# packages/addon-provider-mqtt-ha

IMPORT addon: subscribes to Home Assistant MQTT discovery on a broker from the
`mqtt-broker` cap (`mqttBroker.getBrokerConfig`), surfaces candidates via
`device-adoption`. One candidate = one physical device (all entities sharing a
discovery `device` block; a multi-actuator box is ONE Container with a child per gang, `mqtt-ha-container-plan.ts`). Mapping is by
component + `device_class` + unit, never by model (`mqtt-ha-domain-mapping.ts`);
power / energy / voltage / current fold into `power-meter` (D951); battery is the
`battery` cap. State is decoded per entity with its `value_template`
(`mqtt-ha-template.ts`), so zigbee2mqtt's JSON topics and plain topics share a path.
Not exposed: link quality, `update`/`select`/`number`/`lock`/`cover`, diagnostic and config entities.

Integration settings must carry `mqttBrokerId` (id from Connectivity → MQTT brokers).

## Skills for this package

<!-- camstack-skills-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
Follow the skill; do not reconstruct the procedure (any agent can open the file):

- A new or changed addon or manifest entry; `camstack deploy` → `camstack-addon` (`.claude/skills/camstack-addon/SKILL.md`)
<!-- camstack-skills-pointer:end -->
