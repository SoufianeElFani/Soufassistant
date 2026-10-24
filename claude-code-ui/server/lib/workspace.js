/*
 * The workspace — a scratch/output folder separate from `/config`, for
 * anything Claude produces that the user will want to keep, download, or
 * reopen later: a report, a generated image, a data export, a self-contained
 * HTML page. It is served read-only at `/workspace/<relPath>` (static) and
 * listed at `/api/workspace`; the Workspace panel in the frontend renders
 * that listing.
 *
 * This is this app's local, honest equivalent of a hosted "Artifact": a page
 * saved to disk and reopenable from the browser, with no claude.ai-hosted URL
 * and nothing to share outside this Home Assistant instance.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { WORKSPACE_DIR } from './config.js';

export const MAX_ENTRIES = 500;

export function ensureWorkspaceDir() {
  try { mkdirSync(WORKSPACE_DIR, { recursive: true }); } catch {}
}

/**
 * Recursively list files under WORKSPACE_DIR (not directories themselves —
 * the UI only needs leaves to link to). Dotfiles/dotdirs are skipped. Pure
 * apart from the filesystem reads, and capped so a runaway write loop cannot
 * hand the browser an enormous payload.
 */
export function listWorkspaceEntries(root = WORKSPACE_DIR) {
  const entries = [];
  if (!existsSync(root)) return entries;

  const walk = (dir, relDir) => {
    if (entries.length >= MAX_ENTRIES) return;
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      if (entries.length >= MAX_ENTRIES) return;
      const abs = path.join(dir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { walk(abs, rel); continue; }
      if (!st.isFile()) continue;
      entries.push({
        path: rel,
        name,
        size: st.size,
        mtime: st.mtimeMs,
        ext: path.extname(name).replace(/^\./, '').toLowerCase(),
      });
    }
  };
  walk(root, '');
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries;
}
