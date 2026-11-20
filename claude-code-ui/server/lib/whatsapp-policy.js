/*
 * What a WhatsApp conversation may do without asking — pure, unit-tested.
 *
 * Nobody is looking at a screen: a tool call is either allowed, put to the
 * person as Oui / Non buttons in the chat ('ask'), or refused ('deny').
 *
 *   owner   everything the app can do. Reads and ordinary house actions run
 *           straight away; writing files, other commands, sending a message
 *           to someone, and the sensitive devices (locks, the alarm, sirens,
 *           the garage door, restarting Home Assistant) ask first.
 *   family  the house only: entity states, history, ordinary actions; the
 *           sensitive devices ask; files, other commands, connectors refused.
 *
 * A Bash command is only recognised when it is ONE plain command: any shell
 * operator outside single quotes (; | & $ ` < > or a newline) makes it "something else" — asked for
 * the owner, refused for family — so nothing can ride along a harmless call.
 */

export const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Skill', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
const FAMILY_TOOLS = new Set(['WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** ha-tools commands that only read. */
export const HA_READ = new Set([
  'running', 'trace-stuck', 'trace-timeline', 'trace-summary', 'traces', 'trace-latest', 'trace', 'trace-vars',
  'trace-actions', 'trace-trigger', 'automation-config', 'blueprint-inputs', 'automation', 'config-check',
  'history', 'stats', 'stats-multi', 'timeline', 'logbook', 'attrs', 'syslog', 'context',
  'state', 'states', 'states-filter', 'config', 'services', 'template', 'device-health', 'compare', 'ping',
  'entities', 'devices', 'areas', 'analyze', 'logs',
]);
/** What family may read: the house, not its logs or automations' internals. */
const HA_FAMILY_READ = new Set(['state', 'states', 'states-filter', 'history', 'stats', 'stats-multi', 'timeline', 'logbook', 'template', 'device-health', 'entities', 'devices', 'areas', 'analyze', 'compare', 'config', 'ping']);

/** Service domains for everyday actions. */
export const HOUSE_DOMAINS = new Set([
  'light', 'switch', 'climate', 'cover', 'fan', 'media_player', 'scene', 'script', 'vacuum', 'water_heater',
  'humidifier', 'select', 'number', 'button', 'input_boolean', 'input_number', 'input_select', 'input_text',
  'input_datetime', 'input_button', 'todo', 'timer', 'counter', 'remote', 'notify', 'tts', 'valve', 'lawn_mower', 'shopping_list',
]);
/** Always confirmed first, whoever asks. */
export const SENSITIVE_DOMAINS = new Set(['lock', 'alarm_control_panel', 'siren', 'homeassistant', 'hassio', 'backup', 'update', 'recorder', 'camera']);
const SENSITIVE_ENTITY = /garage|portail|gate|porte_d_entree|front_door|alarm|alarme|serrure|verrou/i;

/** Plain read-only commands the owner may run without being asked. */
const OWNER_READ_CMDS = new Set(['date', 'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'whoami', 'uptime', 'df', 'free', 'stat', 'file']);

const SHELL_OPERATOR = /[;&|`$<>\n\r\\]/;

/** Pure. Split one plain command into words, honouring simple quotes. */
export function words(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Pure. `ha-tools call light turn_on '{"entity_id": "light.x"}'` → its parts. */
export function parseHaCall(w) {
  const args = w.filter((x) => !x.startsWith('--'));
  const domain = args[2] || '';
  const service = args[3] || '';
  let entities = [];
  const data = args.slice(4).join(' ');
  try {
    const j = JSON.parse(data || '{}');
    const e = j.entity_id ?? j.target?.entity_id;
    entities = Array.isArray(e) ? e : e ? [e] : [];
  } catch { entities = (data.match(/[a-z_]+\.[a-z0-9_]+/g) || []); }
  return { domain, service, entities: entities.map(String) };
}

/**
 * Pure. → { decision: 'allow' | 'ask' | 'deny', summary, reason? }.
 * `summary` is the one line the Oui / Non question shows.
 */
export function classify(toolName, input = {}, profile = 'family', { allowedMcp = [] } = {}) {
  const owner = profile === 'owner';
  const deny = (reason) => ({ decision: 'deny', reason, summary: toolName });
  const ask = (summary) => ({ decision: 'ask', summary });
  const allow = (summary = toolName) => ({ decision: 'allow', summary });

  if (toolName === 'AskUserQuestion') return allow();
  if (owner ? READ_TOOLS.has(toolName) : FAMILY_TOOLS.has(toolName)) return allow();
  if (toolName === 'Agent' || toolName === 'Task') return owner ? allow() : deny('Pas de sous-agent depuis ce profil.');
  if (WRITE_TOOLS.has(toolName)) return owner ? ask(`Modifier le fichier ${input.file_path || input.notebook_path || ''}`.trim()) : deny('Ce profil ne peut pas modifier de fichiers.');
  if (toolName.startsWith('mcp__')) {
    if (!owner) return deny('Ce profil n\'a pas accès aux connecteurs.');
    if (allowedMcp.includes(toolName)) return allow();
    const short = toolName.split('__').pop();
    if (short === 'send_whatsapp') return ask(`Envoyer à ${input.to} : « ${String(input.text || '').slice(0, 300)} »`);
    if (short === 'send_whatsapp_file') return ask(`Envoyer le fichier ${input.path} à ${input.to}`);
    return ask(`Utiliser ${short}`);
  }
  if (toolName === 'Bash') {
    const cmd = String(input.command || '').trim();
    const shown = cmd.length > 300 ? `${cmd.slice(0, 300)}…` : cmd;
    if (!cmd) return deny('Commande vide.');
    // Inside single quotes nothing is special to the shell (a Jinja `| float`, JSON).
    if (SHELL_OPERATOR.test(cmd.replace(/'[^']*'/g, "''"))) return owner ? ask(`Lancer : ${shown}`) : deny('Une seule commande ha-tools à la fois, sans opérateur shell.');
    const w = words(cmd);
    if (w[0] === 'ha-tools') {
      const sub = w.slice(1).find((x) => !x.startsWith('--')) || '';
      if (sub === 'call') {
        const { domain, service, entities } = parseHaCall(w);
        const what = `${domain}.${service}${entities.length ? ` → ${entities.join(', ')}` : ''}`;
        if (SENSITIVE_DOMAINS.has(domain) || entities.some((e) => SENSITIVE_ENTITY.test(e))) return ask(`Action sensible : ${what}`);
        if (HOUSE_DOMAINS.has(domain)) return allow(what);
        return owner ? ask(`Action : ${what}`) : deny(`Le domaine ${domain || '?'} n'est pas ouvert à ce profil.`);
      }
      if (sub === 'automation' && !owner) return deny('Ce profil ne lit pas la configuration des automatisations.');
      if (owner ? HA_READ.has(sub) : HA_FAMILY_READ.has(sub)) return allow(`ha-tools ${sub}`);
      return owner ? ask(`Lancer : ${shown}`) : deny(`ha-tools ${sub} n'est pas ouvert à ce profil.`);
    }
    if (owner && OWNER_READ_CMDS.has(w[0])) return allow(shown);
    return owner ? ask(`Lancer : ${shown}`) : deny('Ce profil ne peut lancer que ha-tools.');
  }
  return owner ? ask(`Utiliser ${toolName}`) : deny(`${toolName} n'est pas ouvert à ce profil.`);
}

/** Pure. "oui" / "non" typed instead of pressing a button. */
export function yesNo(text) {
  const t = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[.!\s]+$/, '');
  if (/^(oui|ouais|yes|ok|okay|vas-y|vas y|go|d'accord|daccord|ja|confirme|👍)$/.test(t)) return 'allow';
  if (/^(non|no|nee|nein|annule|stop|👎)$/.test(t)) return 'deny';
  return null;
}
