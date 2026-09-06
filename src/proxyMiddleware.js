const { createProxyMiddleware } = require('http-proxy-middleware');
const { eventBus } = require('./eventBus');
const { logProxiedRequest } = require('./logger');

/**
 * Builds the data-plane middleware stack for the orchestrator.
 *
 * Contract: every request that should be routed through the orchestrator
 * must carry:
 *   x-to-service:   logical name of the destination
 *   x-from-service: logical name of the caller (both are Required)
 *
 * The target is resolved from `routeStore` as the (from, to) pair on
 * *every* request - falling back to the wildcard ("*", to) route if the
 * caller has no explicit override - so changing a route via the admin API
 * takes effect immediately on the next request, and redirecting one
 * caller's traffic never affects other callers of the same destination.
 */
function createOrchestratorProxy(routeStore) {
  // 1) Validate + resolve the target before handing off to the proxy.
  function resolveTarget(req, res, next) {
    const to = req.headers['x-to-service'];
    const from = req.headers['x-from-service'];

    if (!to) {
      return res.status(400).json({
        error: 'Missing required "x-to-service" header. The orchestrator needs to know which logical service to route this request to.',
      });
    }
    if (!from) {
      return res.status(400).json({
        error: 'Missing required "x-from-service" header. The orchestrator needs to know which caller is making this request, since routes are per (from, to) pair.',
      });
    }

    const route = routeStore.resolve(from, to);
    if (!route) {
      return res.status(404).json({
        error: `No route for "${from}" -> "${to}". Register one via PUT /api/routes/${from}/${to}, or a fallback for any caller via PUT /api/routes/*/${to}.`,
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
