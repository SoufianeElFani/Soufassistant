/*
 * The app's own tools, as one in-process MCP server ("soufassistant") given
 * to every run — the chat, Cowork, scheduled tasks:
 *
 *   generate_image                    image-gen.js
 *   browser_*                         browser.js (when Chromium is installed)
 *   gmail_* / calendar_*              google.js (when Google is connected)
 *   publish_app / list_published_apps apps.js
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
  return { server: createSdkMcpServer({ name: IMAGE_SERVER, version: '1.0.0', tools }), allowed, names: tools.map((t) => t.name) };
}
