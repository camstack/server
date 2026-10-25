# packages/addon-provider-mqtt-ha

IMPORT addon: subscribes to Home Assistant MQTT discovery on a broker from the
`mqtt-broker` cap (`mqttBroker.getBrokerConfig`), surfaces candidates via
`device-adoption`, materialises v1 `sensor` + `switch` entities as flat devices.

Integration settings must carry `mqttBrokerId` (id from Connectivity → MQTT brokers).

## Skills for this package

<!-- camstack-skills-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
Follow the skill; do not reconstruct the procedure (any agent can open the file):

- A new or changed addon or manifest entry; `camstack deploy` → `camstack-addon` (`.claude/skills/camstack-addon/SKILL.md`)
<!-- camstack-skills-pointer:end -->
