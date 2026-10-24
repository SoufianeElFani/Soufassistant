/*
 * Guard for routes meant only for processes inside this same container (the
 * claude-tasks CLI talking back to the server that spawned it as a tool call).
 *
 * Loopback-only is a real boundary here, not security theatre: each Docker
 * container has its own network namespace, so 127.0.0.1 inside this container
 * is unreachable from any other container, from Home Assistant Core, or from
 * the LAN — only a process actually running inside this app's container (i.e.
 * a tool call Claude itself made) can ever reach it. That is the same trust
 * boundary a Bash tool call already sits inside, so no additional secret is
 * layered on top.
 */
export function requireLoopback(req, res, next) {
  const addr = req.socket?.remoteAddress || '';
  const isLoopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!isLoopback) return res.status(403).json({ error: 'forbidden' });
  next();
}
