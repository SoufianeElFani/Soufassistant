/*
 * The app's own tools, as one in-process MCP server ("soufassistant") given
 * to every run — the chat, Cowork, scheduled tasks:
 *
 *   generate_image                    image-gen.js
 *   browser_*                         browser.js (when Chromium is installed)
 *   gmail_* / calendar_*              google.js (when Google is connected)
 *   publish_app / list_published_apps apps.js
 *   search_conversations / read_conversation   past conversations (session-tools.js)
 *   send_whatsapp / send_whatsapp_file          a household member (whatsapp.js, when set up)
 *
 * `allowed` lists the ones that run without asking (they only read, or only
 * write a picture into the workspace); everything else goes through the run's
 * permission mode like any other action.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { IMAGE_SERVER } from './config.js';
import { imageTools } from './image-gen.js';
import { browserTools, browserAvailable, BROWSER_READ_TOOLS } from './browser.js';
import { googleTools, googleConnected, GOOGLE_READ_TOOLS } from './google.js';
import { publishApp, listApps } from './apps.js';
import { decoratedSessions, searchSessions, sessionToMarkdown } from './session-tools.js';
import { parseSession } from './sessions.js';
import { isAliasLike, protectedRoots } from './vault.js';
import { resolveInWorkspace, workspaceRoot } from './workspace.js';
import * as wa from './whatsapp.js';

const full = (name) => `mcp__${IMAGE_SERVER}__${name}`;

function appTools() {
  return [
    tool('publish_app', 'Publish a web app built in a workspace project so the user can open it any time at <app>/apps/<slug>/ (behind Home Assistant\'s login, phone included) — like Lovable/Bolt "publish". kind "static": the project\'s files are served (entry, default index.html, relative URLs only). kind "server": `command` is run in the project folder and must listen on 127.0.0.1:$PORT; it is restarted if it stops and when the app restarts. Published pages run sandboxed (opaque origin): no localStorage, sessionStorage or cookies — keep state in memory or on the server. Publishing again with the same name updates it.',
      { name: z.string().min(2).max(80), project: z.string().max(120), kind: z.enum(['static', 'server']), entry: z.string().max(200).optional(), command: z.string().max(500).optional() },
      async (a) => {
        const r = publishApp(a);
        return r.ok
          ? { content: [{ type: 'text', text: `Published "${r.app.name}" at apps/${r.app.slug}/ (${r.app.kind}${r.app.port ? `, port ${r.app.port}` : ''}). The user finds it in the Hub → Apps tab; tell them it is there.` }] }
          : { isError: true, content: [{ type: 'text', text: r.error }] };
      }),
    tool('list_published_apps', 'The apps already published (name, slug, project, kind, running).', {},
      async () => ({ content: [{ type: 'text', text: listApps().map((a) => `- ${a.name} → apps/${a.slug}/ (${a.kind}, project "${a.project}"${a.kind === 'server' ? `, ${a.running ? 'running' : 'stopped'}` : ''})`).join('\n') || 'None yet.' }] })),
  ];
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ isError: true, content: [{ type: 'text', text: t }] });
/** A conversation held under the confidential shield: its pseudonyms stay where they are. */
const looksConfidential = (items) => items.some((it) => (it.kind === 'user' || it.kind === 'text') && isAliasLike(it.text || ''));

/** Recall across conversations (Hermes Agent's session search), read-only. */
export function recallTools(ctx = {}) {
  return [
    tool('search_conversations', 'Search the user\'s past conversations with you (every mode, WhatsApp included) for a word or phrase — to recall what was decided, said or done before ("last time", "as we said", "the X we set up"). Returns matching conversations, newest first, with a snippet. Then read_conversation for the whole of one.',
      { query: z.string().min(2).max(200), limit: z.number().int().min(1).max(20).optional() },
      async ({ query, limit = 8 }) => {
        const own = ctx.key?.();
        const hits = searchSessions(query, { limit: 40 })
          .filter((h) => h.id !== own && !looksConfidential(parseSession(h.id)))
          .slice(0, limit);
        if (!hits.length) return text(`No past conversation mentions "${query}".`);
        return text(hits.map((h) => `- ${h.id} · ${h.updatedAt ? new Date(h.updatedAt).toISOString().slice(0, 10) : '?'} · ${h.title} (${h.hits} hit${h.hits === 1 ? '' : 's'})\n  ${h.snippet}`).join('\n'));
      }),
    tool('read_conversation', 'Read one past conversation found with search_conversations: its prompts and replies as Markdown (tool calls shortened). Long ones are cut; pass `from_end` to read the end instead.',
      { id: z.string().min(8).max(80), max_chars: z.number().int().min(1000).max(60000).optional(), from_end: z.boolean().optional() },
      async ({ id, max_chars = 15000, from_end = false }) => {
        const s = decoratedSessions().find((x) => x.id === id);
        if (!s) return fail('No such conversation.');
        const items = parseSession(id);
        if (looksConfidential(items)) return fail('That conversation was held in confidential mode: it is not readable from here.');
        const md = sessionToMarkdown(s.title, items);
        if (md.length <= max_chars) return text(md);
        return text(from_end ? `[…cut: the first ${md.length - max_chars} characters]\n${md.slice(-max_chars)}` : `${md.slice(0, max_chars)}\n[…cut: ${md.length - max_chars} more characters; read with from_end for the end]`);
      }),
  ];
}

/** Sending to a household member over WhatsApp (only to the contacts set up in Hub › WhatsApp). */
function whatsappTools() {
  const names = wa.contacts().map((c) => c.name).join(', ');
  const recipient = (to) => {
    const c = wa.resolveRecipient(to);
    if (!c) throw new Error(`"${to}" is not one of the WhatsApp contacts (${names}).`);
    return c;
  };
  const why = (e) => fail(`Not sent: ${e.message}`);
  return [
    tool('send_whatsapp', `Send a WhatsApp message to a household member (${names}) — e.g. "préviens Maysa que j'arrive". ${wa.isWeb() ? '' : 'It reaches them only if they wrote to the assistant in the last 24 hours (WhatsApp\'s rule); otherwise say so. '}Never send anything confidential.`,
      { to: z.string().min(1).max(40), text: z.string().min(1).max(3000) },
      async ({ to, text: body }) => {
        try { const c = recipient(to); await wa.sendText(c.number, body); return text(`Sent to ${c.name}.`); } catch (e) { return why(e); }
      }),
    tool('send_whatsapp_file', `Send a workspace file (PDF, Word, Excel, picture…) to a household member (${names}) over WhatsApp. \`path\` is relative to the workspace; never a file from a Confidentiel folder.`,
      { to: z.string().min(1).max(40), path: z.string().min(1).max(400), caption: z.string().max(1000).optional() },
      async ({ to, path: rel, caption = '' }) => {
        try {
          const c = recipient(to);
          const abs = resolveInWorkspace(rel);
          if (!abs) throw new Error('that path is not in the workspace.');
          if (protectedRoots(workspaceRoot()).some((r) => abs === r || abs.startsWith(r + '/')) || /(^|\/)(Confidentiel|Depot_confidentiel)(\/|$)/.test(rel)) throw new Error('confidential files never go over WhatsApp.');
          await wa.sendFile(c.number, abs, caption);
          return text(`Sent ${rel} to ${c.name}.`);
        } catch (e) { return why(e); }
      }),
  ];
}

/**
 * ctx: { targetDir, onSaved, workspaceRoot, key: () => conversation key,
 *        onFrame: ({url,title}) => void, chat: bool }
 */
export function internalTools(ctx) {
  const tools = [...imageTools(ctx)];
  const allowed = [full('generate_image'), full('list_published_apps')];
  if (browserAvailable()) {
    tools.push(...browserTools({ key: ctx.key, onFrame: ctx.onFrame }));
    allowed.push(...BROWSER_READ_TOOLS.map(full));
  }
  if (googleConnected()) {
    tools.push(...googleTools());
    allowed.push(...GOOGLE_READ_TOOLS.map(full));
  }
  if (!ctx.chat) tools.push(...appTools());
  tools.push(...recallTools(ctx));
  allowed.push(full('search_conversations'), full('read_conversation'));
  if (wa.whatsappReady() && wa.contacts().length && !ctx.noWhatsapp) tools.push(...whatsappTools());
  return { server: createSdkMcpServer({ name: IMAGE_SERVER, version: '1.0.0', tools }), allowed, names: tools.map((t) => t.name) };
}
