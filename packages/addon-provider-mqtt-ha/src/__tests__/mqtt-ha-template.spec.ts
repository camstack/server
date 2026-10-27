import { describe, expect, it } from 'vitest'
import { renderTemplate } from '../mqtt-ha-template.js'

describe('renderTemplate', () => {
  it('returns the trimmed payload when there is no template', () => {
    expect(renderTemplate(null, ' ON \n')).toBe('ON')
  })

  it('reads a top-level JSON field', () => {
    expect(renderTemplate('{{ value_json.power }}', '{"power": 12.5, "state": "ON"}')).toBe('12.5')
  })

  it('reads bracket and nested paths', () => {
    expect(renderTemplate("{{ value_json['state'] }}", '{"state":"ON"}')).toBe('ON')
    expect(renderTemplate('{{ value_json.color.x }}', '{"color":{"x":0.3}}')).toBe('0.3')
  })

  it('renders booleans in lower case', () => {
    expect(renderTemplate('{{ value_json.contact }}', '{"contact": false}')).toBe('false')
  })

  it('applies float, int and round filters', () => {
    expect(renderTemplate('{{ value_json.t | float }}', '{"t":"21.50"}')).toBe('21.5')
    expect(renderTemplate('{{ value_json.t | int }}', '{"t":21.9}')).toBe('21')
    expect(renderTemplate('{{ value_json.t | round(1) }}', '{"t":21.46}')).toBe('21.5')
  })

  it('embeds expressions in surrounding text', () => {
    expect(renderTemplate('{"event_type": "{{ value_json.action }}"}', '{"action":"single"}')).toBe(
      '{"event_type": "single"}',
    )
  })

  it('is null when the field is missing, the payload is not JSON, or the template needs statements', () => {
    expect(renderTemplate('{{ value_json.power }}', '{"state":"ON"}')).toBeNull()
    expect(renderTemplate('{{ value_json.power }}', 'online')).toBeNull()
    expect(renderTemplate('{% if value_json.a %}x{% endif %}', '{"a":1}')).toBeNull()
  })

  it('exposes the raw payload as `value`', () => {
    expect(renderTemplate('{{ value }}', 'online')).toBe('online')
  })
})
