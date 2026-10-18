/*
 * lovelace — dashboards. Storage-mode dashboard config is WebSocket-only; the
 * REST /api/lovelace/* endpoints return 404 on modern HA.
 *
 * The default output is the bare JSON (so `lovelace get x > f.json` then
 * `lovelace save f.json` round-trips); `--json` wraps it in the usual envelope,
 * and `save` accepts either.
 */
const fs = require('fs');
const { UsageError } = require('../lib/ha-args.cjs');

const lovelace = {
  name: 'lovelace',
  mutates: true,
  mutatesNote: 'save, create and delete change Home Assistant; list and get only read.',
  usage: '<list | get [url_path] | save <file|-> [url_path] | create <url_path> <title> | delete <url_path>>',
  summary: 'Dashboards over the WebSocket API: list, read, save, create and delete storage-mode dashboards.',
  details: '  list                        the dashboards\n' +
    '  get [url_path]              a dashboard\'s config (the default dashboard when omitted), always read live\n' +
    '  save <file|-> [url_path]    replace a dashboard\'s config from a JSON file, or stdin with "-"\n' +
    '  create <url_path> <title>   a new storage-mode dashboard (url_path needs a hyphen)\n' +
    '  delete <url_path>           remove a storage-mode dashboard',
  flags: { icon: 'string', 'no-sidebar': 'bool', admin: 'bool' },
  flagHelp: { '--icon mdi:x': 'create: sidebar icon', '--no-sidebar': 'create: hide it from the sidebar', '--admin': 'create: admins only' },
  examples: [
    ['list'],
    ['get energy > energy.json', 'edit the file, then:'],
    ['save energy.json energy'],
    ['create my-room "My room" --icon mdi:sofa'],
  ],
  min: 1,
  async run({ ws, pos, opt, out }) {
    const [action, ...rest] = pos;
    switch (action) {
      case 'list':
        out.data(await ws.send({ type: 'lovelace/dashboards/list' }), { command: 'lovelace' });
        return;

      case 'get': {
        const message = { type: 'lovelace/config', force: true };
        if (rest[0]) message.url_path = rest[0];
        out.data(await ws.send(message), { command: 'lovelace' });
        return;
      }

      case 'save': {
        const [file, urlPath] = rest;
        if (!file) throw new UsageError('save needs a file (or "-" for stdin)');
        let raw;
        try {
          raw = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
        } catch (e) {
          throw new Error(`reading config: ${e.message}`);
        }
        let config;
        try {
          config = JSON.parse(raw);
        } catch (e) {
          throw new UsageError(`config must be valid JSON — ${e.message}`);
        }
        // A file saved from `get --json` is the envelope; the config is inside it.
        if (config && typeof config === 'object' && config.success === true && 'data' in config && !('views' in config)) config = config.data;
        const message = { type: 'lovelace/config/save', config };
        if (urlPath) message.url_path = urlPath;
        out.data(await ws.send(message), { command: 'lovelace' });
        return;
      }

      case 'create': {
        const [urlPath, title] = rest;
        if (!urlPath || !title) throw new UsageError('create needs a url_path and a title');
        if (!urlPath.includes('-')) throw new UsageError('url_path must contain a hyphen (e.g. "my-room")');
        const message = {
          type: 'lovelace/dashboards/create',
          url_path: urlPath,
          title,
          mode: 'storage',
          show_in_sidebar: !opt.noSidebar,
          require_admin: Boolean(opt.admin),
        };
        if (opt.icon) message.icon = opt.icon;
        out.data(await ws.send(message), { command: 'lovelace' });
        return;
      }

      case 'delete': {
        // Delete takes a dashboard_id, but url_path is what humans and agents
        // know — list first and resolve it.
        const urlPath = rest[0];
        if (!urlPath) throw new UsageError('delete needs a url_path');
        const dashboards = await ws.send({ type: 'lovelace/dashboards/list' });
        const match = (dashboards || []).find((d) => d.url_path === urlPath);
        if (!match) throw new Error(`no storage-mode dashboard with url_path "${urlPath}"`);
        await ws.send({ type: 'lovelace/dashboards/delete', dashboard_id: match.id });
        out.data({ deleted: urlPath, dashboard_id: match.id }, { command: 'lovelace' });
        return;
      }

      default:
        throw new UsageError(`unknown action "${action}" (expected list, get, save, create or delete)`);
    }
  },
};

module.exports = { commands: [lovelace] };
