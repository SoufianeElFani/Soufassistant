/*
 * A short-lived note in the corner — for news that does not belong in the
 * transcript on screen, like another conversation finishing.
 */
let host = null;

export function showToast(text, { action, timeout = 9000, kind = 'info' } = {}) {
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  const msg = document.createElement('span');
  msg.className = 'toast-text';
  msg.textContent = text;
  t.appendChild(msg);
  const close = () => { t.classList.add('toast-out'); setTimeout(() => t.remove(), 200); };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => { close(); action.fn(); };
    t.appendChild(b);
  }
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'toast-close';
  x.setAttribute('aria-label', 'Dismiss');
  x.textContent = '✕';
  x.onclick = close;
  t.appendChild(x);
  host.appendChild(t);
  while (host.children.length > 4) host.firstChild.remove();
  if (timeout) setTimeout(close, timeout);
  return t;
}
