const express = require('express');
const { eventBus } = require('./eventBus');

function isValidTarget(target) {
  if (!target || typeof target !== 'string') return false;
  try {
    // eslint-disable-next-line no-new
    new URL(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Admin (control-plane) API.
 *
 * Routes are keyed by the (from, to) pair - the caller and the logical
 * destination - not just the destination. This is what the Praxis Lens
 * agent / execution layer calls at runtime to redirect traffic for a
 * *specific caller only*, e.g.:
 *
 *   PUT /api/routes/edi/axis-api
 *   { "target": "http://mock-server:8080" }
 *
 * ...instantly redirects EDI's requests carrying `x-to-service: axis-api`
 * to the mock server, without touching any other caller's traffic to
 * axis-api. Use the wildcard caller name "*" in place of `:from` to
 * register a fallback that applies to any caller without its own explicit
 * override, e.g. `PUT /api/routes/*\/axis-api`.
 */
function createAdminApi(routeStore) {
  const router = express.Router();

  router.get('/routes', (req, res) => {
    res.json(routeStore.getAll());
  });

  // Single-route lookup - answers "which target does <from> currently use
  // for <to>?" This is an exact-match lookup (does not fall back to the
  // wildcard route) so the admin API always reflects literal registrations.
  router.get('/routes/:from/:to', (req, res) => {
    const { from, to } = req.params;
    const entry = routeStore.get(from, to);
    if (!entry) {
      return res.status(404).json({ error: `No route registered for "${from}" -> "${to}".` });
    }
    res.json(entry);
  });

  router.put('/routes/:from/:to', (req, res) => {
    const { from, to } = req.params;
    const { target } = req.body || {};

    if (!isValidTarget(target)) {
      return res.status(400).json({
        error: !target || typeof target !== 'string'
          ? '"target" (string URL) is required in the request body.'
          : `"${target}" is not a valid absolute URL.`,
      });
    }

    const entry = routeStore.set(from, to, target);
    res.json(entry);
  });

  // Bulk registration - lets the execution service wire up every caller/
  // destination pair in a freshly created environment with a single call,
  // instead of one PUT per route. Body:
  //   { "routes": [
  //       { "from": "edi", "to": "axis-api", "target": "http://mock-server:8080" },
  //       { "from": "*",   "to": "axis-api", "target": "http://axis.com" },
  //       { "from": "*",   "to": "mob",      "target": "http://mob:9090" }
  //   ] }
  // Mixing explicit callers and wildcard ("*") entries in one call lets you
  // mock a single caller's traffic while leaving everyone else's untouched.
  router.post('/routes/bulk', (req, res) => {
    const { routes: incoming } = req.body || {};

    if (!Array.isArray(incoming)) {
      return res.status(400).json({
        error: 'Body must be { "routes": [ { "from": "<caller>", "to": "<service>", "target": "<target-url>" }, ... ] }.',
      });
    }

    const registered = [];
    const errors = [];

    for (const item of incoming) {
      const { from, to, target } = item || {};

      if (!from || typeof from !== 'string' || !to || typeof to !== 'string') {
        errors.push({ from, to, error: '"from" and "to" must be non-empty strings.' });
        continue;
      }
      if (!isValidTarget(target)) {
        errors.push({ from, to, error: '"target" must be a valid absolute URL.' });
        continue;
      }
      const entry = routeStore.set(from, to, target);
      registered.push(entry);
    }

    const status = errors.length > 0 && registered.length === 0 ? 400 : 200;
    res.status(status).json({ registered, errors });
  });

  router.delete('/routes/:from/:to', (req, res) => {
    const { from, to } = req.params;
    const existed = routeStore.remove(from, to);
    if (!existed) {
      return res.status(404).json({ error: `No route registered for "${from}" -> "${to}".` });
    }
    res.status(204).end();
  });

  // Live activity + route-change feed for the dashboard (and later, the
  // Praxis Lens TUI). Plain Server-Sent Events, no extra dependency needed.
  router.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');

    const send = (type, data) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onRouteChanged = (data) => send('route_changed', data);
    const onRouteRemoved = (data) => send('route_removed', data);
    const onRequestProxied = (data) => send('request_proxied', data);

    eventBus.on('route_changed', onRouteChanged);
    eventBus.on('route_removed', onRouteRemoved);
    eventBus.on('request_proxied', onRequestProxied);

    // Keep the connection alive through proxies/load balancers.
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      eventBus.off('route_changed', onRouteChanged);
      eventBus.off('route_removed', onRouteRemoved);
      eventBus.off('request_proxied', onRequestProxied);
    });
  });

  return router;
}

module.exports = { createAdminApi };
