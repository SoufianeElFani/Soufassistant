/*
 * How Meta reaches this app. The app only listens on the Supervisor network
 * (behind ingress); the one thing the internet can see is Home Assistant
 * itself (here: Tailscale Funnel). So a tiny custom integration,
 * `soufassistant_relay`, adds an unauthenticated view to Home Assistant at
 * /api/soufassistant/whatsapp and passes each request through unchanged to
 * this app's /whatsapp/webhook — the signature check happens here, with the
 * app secret, so the relay holds no secret and trusts nothing.
 *
 * install() writes the integration into /config/custom_components and adds its
 * two lines to configuration.yaml (once); Home Assistant must restart to load
 * it. relayStatus() asks the running Home Assistant whether the view answers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import path from 'path';
import { WORK_DIR, SUPERVISOR_URL } from './config.js';
import { log } from './log.js';

export const RELAY_DOMAIN = 'soufassistant_relay';
export const RELAY_VERSION = '1';
export const RELAY_PATH = '/api/soufassistant/whatsapp';
const DIR = () => path.join(WORK_DIR, 'custom_components', RELAY_DOMAIN);

const MANIFEST = {
  domain: RELAY_DOMAIN,
  name: 'Soufassistant relay',
  version: `1.${RELAY_VERSION}.0`,
  documentation: 'https://github.com/SoufianeElFani/soufassistant',
  codeowners: [],
  requirements: [],
  dependencies: ['http'],
  iot_class: 'local_push',
};

export const RELAY_PY = `"""Soufassistant relay: WhatsApp Cloud API webhooks -> the Soufassistant app.

Home Assistant is the only part of the house the internet can reach, so Meta
calls it here; this view passes each request through unchanged to the app on
the Supervisor network, which checks Meta's signature itself (this relay holds
no secret). Installed and kept up to date by Soufassistant (Hub > WhatsApp).
"""
from __future__ import annotations

import logging

from aiohttp import ClientTimeout, web
import voluptuous as vol

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

DOMAIN = "${RELAY_DOMAIN}"
VERSION = "${RELAY_VERSION}"
MAX_BODY = 1024 * 1024
_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = vol.Schema(
    {DOMAIN: vol.Schema({vol.Required("target"): cv.url})}, extra=vol.ALLOW_EXTRA
)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    target = config[DOMAIN]["target"].rstrip("/")
    hass.http.register_view(WhatsAppRelayView(hass, f"{target}/whatsapp/webhook"))
    return True


class WhatsAppRelayView(HomeAssistantView):
    url = "${RELAY_PATH}"
    name = "api:soufassistant:whatsapp"
    requires_auth = False

    def __init__(self, hass: HomeAssistant, target: str) -> None:
        self._hass = hass
        self._target = target

    async def get(self, request: web.Request) -> web.Response:
        if request.query.get("ping"):
            return self.json({"relay": "ok", "version": VERSION})
        return await self._forward("GET", request, None)

    async def post(self, request: web.Request) -> web.Response:
        if (request.content_length or 0) > MAX_BODY:
            return web.Response(status=413)
        body = await request.read()
        if len(body) > MAX_BODY:
            return web.Response(status=413)
        return await self._forward("POST", request, body)

    async def _forward(self, method: str, request: web.Request, body: bytes | None) -> web.Response:
        headers = {"Content-Type": request.headers.get("Content-Type", "application/json")}
        signature = request.headers.get("X-Hub-Signature-256")
        if signature:
            headers["X-Hub-Signature-256"] = signature
        session = async_get_clientsession(self._hass)
        try:
            async with session.request(
                method, self._target, params=request.query, data=body,
                headers=headers, timeout=ClientTimeout(total=10),
            ) as resp:
                return web.Response(status=resp.status, text=await resp.text(), content_type="text/plain")
        except Exception as err:  # noqa: BLE001 - Meta retries on any non-2xx
            _LOGGER.warning("Soufassistant is unreachable: %s", err)
            return web.Response(status=502, text="Soufassistant unreachable")
`;

/** Pure. The configuration.yaml block, or null when one is already there. */
export function yamlBlock(existing, target) {
  if (new RegExp(`^${RELAY_DOMAIN}\\s*:`, 'm').test(existing)) return null;
  return `${existing.endsWith('\n') || !existing ? '' : '\n'}\n# Soufassistant : relais WhatsApp (Hub › WhatsApp)\n${RELAY_DOMAIN}:\n  target: ${target}\n`;
}

async function selfHostname() {
  try {
    const res = await fetch(`${SUPERVISOR_URL}/addons/self/info`, { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } });
    return res.ok ? (await res.json())?.data?.hostname || null : null;
  } catch { return null; }
}

/** The address Home Assistant forwards to: this app on the Supervisor network. */
export async function relayTarget() {
  if (process.env.WHATSAPP_RELAY_TARGET) return process.env.WHATSAPP_RELAY_TARGET;
  const host = await selfHostname();
  return host ? `http://${host}:${process.env.SERVER_PORT || 7681}` : null;
}

export function installedVersion() {
  try { return readFileSync(path.join(DIR(), 'VERSION'), 'utf8').trim(); } catch { return null; }
}

export async function install() {
  const target = await relayTarget();
  if (!target) return { ok: false, error: 'Adresse de l\'app introuvable (Supervisor injoignable).' };
  mkdirSync(DIR(), { recursive: true });
  writeFileSync(path.join(DIR(), 'manifest.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  writeFileSync(path.join(DIR(), '__init__.py'), RELAY_PY);
  writeFileSync(path.join(DIR(), 'VERSION'), `${RELAY_VERSION}\n`);
  const conf = path.join(WORK_DIR, 'configuration.yaml');
  const text = existsSync(conf) ? readFileSync(conf, 'utf8') : '';
  const block = yamlBlock(text, target);
  if (block) appendFileSync(conf, block);
  log('INFO', `whatsapp relay: installed v${RELAY_VERSION} → ${target}${block ? ' (configuration.yaml updated)' : ''}`);
  return { ok: true, target, yamlAdded: !!block, restartNeeded: true };
}

/** Is the relay loaded by the running Home Assistant? */
export async function relayStatus() {
  const installed = installedVersion();
  let active = false, version = null;
  if (process.env.SUPERVISOR_TOKEN) {
    try {
      const res = await fetch(`${SUPERVISOR_URL}/core${RELAY_PATH}?ping=1`, { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } });
      if (res.ok) { const j = await res.json().catch(() => ({})); active = j.relay === 'ok'; version = j.version || null; }
    } catch { /* Home Assistant restarting */ }
  }
  return { installed, active, version, current: RELAY_VERSION, outdated: !!installed && installed !== RELAY_VERSION };
}

/** Restart Home Assistant (after a config check) so it loads the relay. */
export async function restartHomeAssistant() {
  const h = { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`, 'Content-Type': 'application/json' };
  const check = await fetch(`${SUPERVISOR_URL}/core/api/config/core/check_config`, { method: 'POST', headers: h }).then((r) => r.json()).catch(() => null);
  if (check && check.result === 'invalid') return { ok: false, error: `Configuration invalide, pas de redémarrage : ${check.errors || ''}` };
  // The connection can drop as Core goes down: that is the restart happening, not a failure.
  const res = await fetch(`${SUPERVISOR_URL}/core/api/services/homeassistant/restart`, { method: 'POST', headers: h, body: '{}' }).catch(() => ({ ok: true }));
  return res.ok || res.status >= 502 ? { ok: true } : { ok: false, error: `Redémarrage refusé : HTTP ${res.status}` };
}
