const express = require('express');
const { eventBus } = require('./eventBus');

/**
 * Admin (control-plane) API.
 *
 * This is what the Praxis Lens agent / execution layer calls at runtime to
 * redirect traffic, e.g.:
 *
 *   PUT /api/routes/axis-api
 *   { "target": "http://mock-server:8080" }
 *
 * ...instantly redirects any request carrying `x-to-service: axis-api`
 * to the mock server instead of the real Axis API, with no restart.
 */
function createAdminApi(routeStore) {
  const router = express.Router();

  router.get('/routes', (req, res) => {
    res.json(routeStore.getAll());
  });

  // Single-service lookup - answers "which target is <service> currently
  // routing to?" without having to fetch and scan the full list.
  router.get('/routes/:service', (req, res) => {
    const { service } = req.params;
    const entry = routeStore.get(service);
    if (!entry) {
      return res.status(404).json({ error: `No route registered for "${service}".` });
    }
    res.json({ service, ...entry });
  });

  router.put('/routes/:service', (req, res) => {
    const { service } = req.params;
    const { target } = req.body || {};

    if (!target || typeof target !== 'string') {
      return res.status(400).json({ error: '"target" (string URL) is required in the request body.' });
    }
    try {
      // eslint-disable-next-line no-new
      new URL(target);
    } catch {
      return res.status(400).json({ error: `"${target}" is not a valid absolute URL.` });
    }

    const entry = routeStore.set(service, target);
    res.json({ service, ...entry });
  });

  // Bulk registration - lets the execution service wire up every service in
  // a freshly created environment with a single call, instead of one PUT per
  // service. Body: { "routes": { "edi": "http://edi:8080", "mob": "http://mob:9090" } }
  router.post('/routes/bulk', (req, res) => {
    const { routes: incoming } = req.body || {};

    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({
        error: 'Body must be { "routes": { "<service>": "<target-url>", ... } }.',
      });
    }

    const registered = [];
    const errors = [];

    for (const [service, target] of Object.entries(incoming)) {
      if (!target || typeof target !== 'string') {
        errors.push({ service, error: '"target" must be a non-empty string URL.' });
        continue;
      }
      try {
        // eslint-disable-next-line no-new
        new URL(target);
      } catch {
        errors.push({ service, error: `"${target}" is not a valid absolute URL.` });
        continue;
      }
      const entry = routeStore.set(service, target);
      registered.push({ service, ...entry });
    }

    const status = errors.length > 0 && registered.length === 0 ? 400 : 200;
    res.status(status).json({ registered, errors });
  });

  router.delete('/routes/:service', (req, res) => {
    const { service } = req.params;
    const existed = routeStore.remove(service);
    if (!existed) {
      return res.status(404).json({ error: `No route registered for "${service}".` });
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
