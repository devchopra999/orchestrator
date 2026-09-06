const { createProxyMiddleware } = require('http-proxy-middleware');
const { eventBus } = require('./eventBus');
const { logProxiedRequest } = require('./logger');

/**
 * Builds the data-plane middleware stack for the orchestrator.
 *
 * Contract: every request that should be routed through the orchestrator
 * must carry:
 *   x-to-service:   logical name of the destination (looked up in routeStore)
 *   x-from-service: logical name of the caller (used only for logging/observability)
 *
 * The actual target for `x-to-service` is resolved from `routeStore` on
 * *every* request, so changing a route via the admin API takes effect
 * immediately on the next request - no restart needed.
 */
function createOrchestratorProxy(routeStore) {
  // 1) Validate + resolve the target before handing off to the proxy.
  function resolveTarget(req, res, next) {
    const to = req.headers['x-to-service'];
    const from = req.headers['x-from-service'] || 'unknown';

    if (!to) {
      return res.status(400).json({
        error: 'Missing required "x-to-service" header. The orchestrator needs to know which logical service to route this request to.',
      });
    }

    const route = routeStore.get(to);
    if (!route) {
      return res.status(404).json({
        error: `Unknown target service "${to}". Register it first via PUT /api/routes/${to}.`,
      });
    }

    req._praxis = { from, to, target: route.target, startedAt: Date.now() };
    next();
  }

  // 2) Proxy using a dynamic router so it always reads the latest target.
  const proxy = createProxyMiddleware({
    router: (req) => req._praxis.target,
    changeOrigin: true,
    ws: true,
    logger: undefined,
    on: {
      proxyRes: (proxyRes, req) => {
        const { from, to, target, startedAt } = req._praxis;
        const durationMs = Date.now() - startedAt;
        const entry = {
          from,
          to,
          target,
          method: req.method,
          path: req.originalUrl,
          status: proxyRes.statusCode,
          durationMs,
        };
        logProxiedRequest(entry);
        eventBus.emit('request_proxied', entry);
      },
      error: (err, req, res) => {
        const info = req._praxis || {};
        const durationMs = info.startedAt ? Date.now() - info.startedAt : null;
        const entry = {
          from: info.from,
          to: info.to,
          target: info.target,
          method: req.method,
          path: req.originalUrl,
          status: null,
          durationMs,
          error: err.message,
        };
        logProxiedRequest(entry);
        eventBus.emit('request_proxied', entry);

        if (res && typeof res.writeHead === 'function' && !res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bad gateway', detail: err.message, target: info.target }));
        }
      },
    },
  });

  return [resolveTarget, proxy];
}

module.exports = { createOrchestratorProxy };
