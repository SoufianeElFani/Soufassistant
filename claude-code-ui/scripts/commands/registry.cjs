/*
 * registry — entity, device and area registries. Ported from ha-ws-client (MIT,
 * see NOTICE).
 */
const { globToRegExp } = require('../lib/ha-common.cjs');

function filtered(items, pattern, fields) {
  if (!pattern) return items;
  const re = globToRegExp(pattern);
  return items.filter((item) => fields(item).some((f) => re.test(f || '')));
}

const entities = {
  name: 'entities',
  usage: '[pattern]',
  summary: 'Search the entity registry by entity_id or name (`*` is a wildcard).',
  examples: [['humidity'], ['"light.*" --compact', 'one line each']],
  max: 1,
  async run({ ws, pos, out }) {
    const items = filtered((await ws.send({ type: 'config/entity_registry/list' })) || [], pos[0],
      (e) => [e.entity_id, e.name, e.original_name]);
    out.list(items, {
      title: 'Entity registry',
      command: 'entities',
      formatter: (e) => {
        const name = e.name || e.original_name || '';
        const disabled = e.disabled_by ? ' [disabled]' : '';
        return out.isCompact ? `${e.entity_id} (${name})${disabled}`
          : `${e.entity_id}\n  Name: ${name}\n  Platform: ${e.platform || ''}${disabled}`;
      },
    });
  },
};

const devices = {
  name: 'devices',
  usage: '[pattern]',
  summary: 'Search the device registry by id, name, manufacturer or model.',
  examples: [['phone'], ['ikea --compact']],
  max: 1,
  async run({ ws, pos, out }) {
    const nameOf = (d) => d.name_by_user || d.name || '';
    const items = filtered((await ws.send({ type: 'config/device_registry/list' })) || [], pos[0],
      (d) => [d.id, nameOf(d), d.manufacturer, d.model]);
    out.list(items, {
      title: 'Device registry',
      command: 'devices',
      formatter: (d) => out.isCompact
        ? `${String(d.id).slice(0, 8)}: ${nameOf(d)} (${d.manufacturer || ''} ${d.model || ''})`
        : `${d.id}\n  Name: ${nameOf(d)}\n  Manufacturer: ${d.manufacturer || ''}\n  Model: ${d.model || ''}\n  Area: ${d.area_id || ''}`,
    });
  },
};

const areas = {
  name: 'areas',
  usage: '',
  summary: 'Every area, with its aliases.',
  examples: [[''], ['--json']],
  max: 0,
  async run({ ws, out }) {
    const items = (await ws.send({ type: 'config/area_registry/list' })) || [];
    out.list(items, {
      title: 'Areas',
      command: 'areas',
      formatter: (a) => `${a.area_id}: ${a.name}${a.aliases?.length ? ` (aliases: ${a.aliases.join(', ')})` : ''}`,
    });
  },
};

module.exports = { commands: [entities, devices, areas] };
