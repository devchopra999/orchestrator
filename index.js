const path = require('path');
const express = require('express');

const { RouteStore } = require('./src/routeStore');
const { NameLabelStore } = require('./src/nameLabelStore');
const { createAdminApi } = require('./src/adminApi');
const { createOrchestratorProxy } = require('./src/proxyMiddleware');

const PORT = process.env.PORT || 9000;

const app = express();
const routeStore = new RouteStore();
const nameLabelStore = new NameLabelStore();

app.use(express.json());

// Liveness/readiness probe for the execution service's healthcheck - wait
// for this before registering routes or starting dependent containers.
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', routes: routeStore.getAll().length });
});

// Dashboard (view + edit routes, live activity feed).
app.use('/', express.static(path.join(__dirname, 'public', 'dashboard')));

// Control plane: REST + SSE for managing routes at runtime.
app.use('/api', createAdminApi(routeStore, nameLabelStore));

// Data plane: everything else is treated as service-to-service traffic and
// proxied according to the `x-from-service` / `x-to-service` headers.
app.use(createOrchestratorProxy(routeStore));

app.listen(PORT, () => {
  console.log(`\nPraxis Lens orchestrator listening on http://localhost:${PORT}`);
  console.log(`  Dashboard:  http://localhost:${PORT}/`);
  console.log(`  Admin API:  http://localhost:${PORT}/api/routes`);
  console.log(`  Health:     http://localhost:${PORT}/healthz`);
  console.log(`  Registered routes: ${routeStore.getAll().length}\n`);
});
