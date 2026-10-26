/*
 * Image generation — a `generate_image` tool Claude can call in every mode.
 *
 * Claude cannot draw by itself, so the app lends it a tool: Claude writes the
 * prompt, this module asks a text-to-image service for the picture and saves it
 * in the workspace, where the usual artifact machinery takes over (a card with
 * a thumbnail after the reply, the viewer opening on it — phones included).
 *
 * The service is Pollinations (https://pollinations.ai): free, no account and
 * no key, which is what was asked for. It is a public service — prompts leave
 * the box, and the free tier stamps a small logo in a corner. The base URL is
 * IMAGE_GEN_URL so tests can point it at a local fake.
 *
 * The tool is served in-process through the Agent SDK's MCP helper
 * (`createSdkMcpServer`), so it needs no shell and works in Chat mode too; it
 * is auto-approved in permissions.js — it only ever writes a new image file
 * inside the workspace.
 */
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { log } from './log.js';
import { IMAGE_SERVER, IMAGE_TOOL } from './config.js';

export { IMAGE_SERVER, IMAGE_TOOL };
const BASE_URL = () => (process.env.IMAGE_GEN_URL || 'https://image.pollinations.ai').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.IMAGE_GEN_TIMEOUT_MS) || 120000;
const MAX_BYTES = 15 * 1024 * 1024;
const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/** `AAAA-MM-JJ_a-few-words-of-the-prompt` — the workspace naming convention. Pure. */
export function imageBaseName(prompt, date = new Date(), name = '') {
  const day = date.toISOString().slice(0, 10);
  const words = String(name || prompt || 'image')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .split('-').filter(Boolean).slice(0, 6).join('-') || 'image';
  return `${day}_${words}`;
}

/** The request URL for one image. Pure. */
export function imageUrl({ prompt, width = 1024, height = 1024, seed, model }) {
  const q = new URLSearchParams({ width: String(width), height: String(height), nologo: 'true', private: 'true' });
  if (Number.isInteger(seed)) q.set('seed', String(seed));
  if (model) q.set('model', model);
  return `${BASE_URL()}/prompt/${encodeURIComponent(prompt)}?${q}`;
}

/** A file name not taken in `dir`: base.ext, base-2.ext, … Pure but for the existence check. */
function freeName(dir, base, ext) {
  let n = 1, name = `${base}.${ext}`;
  while (existsSync(path.join(dir, name))) name = `${base}-${++n}.${ext}`;
  return name;
}

/**
 * Fetch one image and save it under `dir`. Returns { abs, name, bytes, type }.
 * Throws with a message fit to show the model.
 */
export async function generateImage({ prompt, width, height, seed, model, name }, { dir, now = new Date() }) {
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is empty');
  const url = imageUrl({ prompt: String(prompt).trim(), width, height, seed, model });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: ac.signal, headers: { Accept: 'image/*' } });
  } catch (e) {
    throw new Error(ac.signal.aborted ? `the image service did not answer within ${Math.round(TIMEOUT_MS / 1000)} s` : `the image service is unreachable (${e.message})`);
  } finally { clearTimeout(timer); }
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!res.ok) throw new Error(`the image service answered HTTP ${res.status}`);
  if (!EXT_BY_TYPE[type]) throw new Error(`the image service returned ${type || 'no content type'}, not an image`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('the image service returned an empty file');
  if (buf.length > MAX_BYTES) throw new Error('the image is unexpectedly large');
  mkdirSync(dir, { recursive: true });
  const fileName = freeName(dir, imageBaseName(prompt, now, name), EXT_BY_TYPE[type]);
  const abs = path.join(dir, fileName);
  writeFileSync(abs, buf);
  return { abs, name: fileName, bytes: buf.length, type };
}

/**
 * The per-run MCP server. `targetDir()` says where images go (the Cowork
 * project's Images/ folder, else the workspace's), `onSaved(abs)` lets the run
 * count the file as its own artifact.
 */
export function imageMcpServer({ targetDir, onSaved, workspaceRoot }) {
  const generate = tool(
    'generate_image',
    'Generate an image from a text description and save it in the user\'s workspace; the app shows it ' +
    'in the chat and in the viewer next to it (phones included). Write the prompt in English, concrete and ' +
    'visual (subject, style, composition, colours, lighting). Use it when the user asks for a picture, ' +
    'illustration, logo idea, mood board or visual — not for charts or diagrams (build those as SVG/HTML). ' +
    'Free public service: no confidential content in prompts. Each call takes ~5–30 s.',
    {
      prompt: z.string().min(3).max(2000).describe('What the image shows, in English'),
      width: z.number().int().min(256).max(2048).optional().describe('Pixels, default 1024'),
      height: z.number().int().min(256).max(2048).optional().describe('Pixels, default 1024 (e.g. 1792x1024 for a slide)'),
      seed: z.number().int().min(0).max(2147483647).optional().describe('Same seed + prompt = same image; change it for a variant'),
      name: z.string().max(80).optional().describe('A few words for the file name'),
    },
    async (args) => {
      try {
        const dir = targetDir();
        const r = await generateImage(args, { dir });
        onSaved?.(r.abs);
        const rel = workspaceRoot ? path.relative(workspaceRoot(), r.abs) : r.abs;
        log('INFO', `image generated: ${rel} (${r.bytes} bytes)`);
        return { content: [{ type: 'text', text:
          `Image saved: ${r.abs} (${args.width || 1024}×${args.height || 1024}, ${Math.round(r.bytes / 1024)} KB). ` +
          'It is shown to the user in the chat and the viewer — do not describe it at length; you can Read the file to look at it.' }] };
      } catch (e) {
        log('WARN', `image generation failed: ${e.message}`);
        return { isError: true, content: [{ type: 'text', text: `Image generation failed: ${e.message}` }] };
      }
    },
  );
  return createSdkMcpServer({ name: IMAGE_SERVER, version: '1.0.0', tools: [generate] });
}
