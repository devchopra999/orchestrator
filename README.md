# Praxis Lens — Runtime Orchestrator

A small always-on Node.js service that sits between your services as a
**dynamic reverse proxy**. Instead of:

```
serviceA -> serviceB
```

you get:

```
serviceA -> Orchestrator -> serviceB
```

The orchestrator's routing table (which logical service name currently
points to which real target URL) can be changed **at runtime**, via a REST
API or the built-in dashboard — no restarts, no redeploys. This is the
building block that lets a Praxis Lens agent redirect a service's traffic
(e.g. swap a real third-party API for a mock server) mid-experiment.

## Why header-based routing

Instead of path prefixes, the orchestrator uses two headers so the calling
service barely has to change anything — just point it at the orchestrator's
host instead of the real target, keep the same path, and add two headers:

| Header             | Meaning                                                      |
|--------------------|---------------------------------------------------------------|
| `x-to-service`     | **Required.** Logical name of the destination (looked up in the route table). |
| `x-from-service`   | Optional. Logical name of the caller — used purely for logging/observability. |

The orchestrator resolves `x-to-service` against its live route table on
**every request**, so changing a route takes effect on the very next
request.

## Quick start

```bash
npm install

# terminal 1: the orchestrator itself
npm start                # http://localhost:8000 (override with PORT=xxxx)

# terminal 2 & 3: two example echo services to try it against
npm run example:a        # http://localhost:4001
npm run example:b        # http://localhost:4002
```

Open the dashboard at **http://localhost:8000** to add/edit/remove routes
and watch live traffic.

Register a route (this is the call an agent would make at runtime):

```bash
curl -X PUT http://localhost:8000/api/routes/serviceB \
  -H 'Content-Type: application/json' \
  -d '{"target": "http://localhost:4002"}'
```

Send traffic through the orchestrator as if it were serviceB:

```bash
curl http://localhost:8000/anything/you/want \
  -H 'x-from-service: serviceA' \
  -H 'x-to-service: serviceB'
```

Now redirect `serviceB` traffic elsewhere at runtime, with zero downtime:

```bash
curl -X PUT http://localhost:8000/api/routes/serviceB \
  -H 'Content-Type: application/json' \
  -d '{"target": "http://localhost:4001"}'   # now points at serviceA's echo instead
```

The very next request with `x-to-service: serviceB` is now handled by the
new target — this is exactly how the Praxis Lens agent redirects
`EDI -> Axis API` to `EDI -> Mock Server` mid-experiment (see project docs).

## Admin (control-plane) API

| Method | Path                    | Description                                      |
|--------|-------------------------|---------------------------------------------------|
| GET    | `/healthz`              | Liveness/readiness probe. `{ "status": "ok", "routes": <n> }`. |
| GET    | `/api/routes`           | List all registered routes.                       |
| GET    | `/api/routes/:service`  | Look up which target a single service is currently routing to. Returns `{ "service", "target", "updatedAt" }`, or `404` if unregistered. |
| PUT    | `/api/routes/:service`  | Create/update a single route. Body: `{ "target": "http://host:port" }`. |
| POST   | `/api/routes/bulk`      | Register/update many routes in one call. Body: `{ "routes": { "edi": "http://edi:8080", "mob": "http://mob:9090" } }`. Returns `{ registered: [...], errors: [...] }`. **This is what the execution service calls once, right after an environment's containers are up, to wire every service through the orchestrator in one shot.** |
| DELETE | `/api/routes/:service`  | Remove a route.                                    |
| GET    | `/api/events`           | Server-Sent Events stream (`route_changed`, `route_removed`, `request_proxied`) — powers the dashboard and can later feed the Praxis Lens TUI. |

Routes persist to `routes.json` in the project root (gitignored) so they
survive **process** restarts (e.g. `npm start` crashing/restarting, `npm run
dev`'s `--watch` reloads). The path is configurable via the `ROUTES_FILE`
env var, and the parent directory is created automatically if it doesn't
exist yet (useful when pointing it at a mounted volume).

> **Running in Docker?** By default the image sets `ROUTES_FILE=/app/data/routes.json`
> and declares `/app/data` as a volume. Without mounting an actual host
> path/named volume there, that directory is just part of the container's
> writable layer - fine for a process restart, but **wiped whenever the
> container itself is recreated** (redeploy, `docker compose up` after a
> `down`, etc). Mount a persistent volume at `/app/data` (see the Execution
> Service Integration Guide below) if routes need to survive container
> restarts, not just process restarts.

Look up where traffic for a given service currently goes:

```bash
curl http://localhost:8000/api/routes/serviceB
# -> {"service":"serviceB","target":"http://localhost:4002","updatedAt":"..."}
```

> Note: the admin API has **no authentication** — acceptable for a
> hackathon/local demo, but add an API key or network restriction before
> using this anywhere less trusted.

## Project layout

```
index.js                   entrypoint: wires dashboard + admin API + proxy
Dockerfile, .dockerignore  builds the orchestrator as a standalone image
src/
  routeStore.js             in-memory route table + routes.json persistence
  eventBus.js                shared EventEmitter (route changes + request logs)
  proxyMiddleware.js          resolves x-to-service -> target, proxies the request
  adminApi.js                 REST + SSE control-plane API
  logger.js                   console logging for proxied requests
public/dashboard/            dashboard UI (static, no build step)
examples/serviceA.js, serviceB.js   minimal echo servers for local testing
```

## How this fits into Praxis Lens

This orchestrator is the traffic-control primitive for the "Execution
Infrastructure" layer described in the Praxis Lens architecture: the
LangGraph agent decides *what* should be redirected (e.g. "point EDI's Axis
API calls at the mock server"), and calls `PUT /api/routes/axis-api` here to
make it happen instantly, without restarting EDI or any other service.

---

## Execution Service Integration Guide

This section is for whoever is building the **execution service** (the
component that spins up a Docker Compose project per debugging environment,
e.g. `praxis-env-a81f3c`). It describes exactly how to wire the orchestrator
into every environment automatically.

### 1. Run one orchestrator container per environment

Build the image once from this repo:

```bash
docker build -t praxis-orchestrator:latest .
```

Then add it as a service in the environment's `docker-compose.yml`, on the
same Compose project/network as everything else (`edi`, `mob`,
`mock-server`, ...):

```yaml
services:
  orchestrator:
    image: praxis-orchestrator:latest
    environment:
      - PORT=8000
    ports:
      - "0:8000"        # publish to a host-assigned ephemeral port (see below)
    volumes:
      - orchestrator-data:/app/data   # persists routes.json across container restarts/recreation
    healthcheck:         # already baked into the image, shown here for clarity
      test: ["CMD", "node", "-e", "fetch('http://localhost:8000/healthz').then(r=>process.exit(r.ok?0:1))"]
      interval: 5s
      timeout: 3s
      retries: 5

  edi:
    image: ${EDI_IMAGE}
    environment:
      - ORCHESTRATOR_URL=http://orchestrator:8000
      - SERVICE_NAME=edi
    depends_on:
      orchestrator:
        condition: service_healthy
  # ...mob, mock-server, mysql, vault, etc.

volumes:
  orchestrator-data:   # backs /app/data - keeps routes.json across container restarts/recreation
```

Because `orchestrator` shares the Compose network, every other container can
reach it at `http://orchestrator:8000` using Docker's built-in service
discovery — no extra networking setup needed.

The `orchestrator-data` volume is what makes registered routes survive the
orchestrator container being restarted or recreated (e.g. on a redeploy) -
without it, routes only survive a plain process restart inside the same
container, not the container's own recreation. If instead you want a fresh
route table every time an environment is (re)created, drop the `volumes:`
entry and re-run step 3 (`POST /api/routes/bulk`) after the container comes
back up.

### 2. Expose the dashboard publicly

Publishing with `"0:8000"` (host port `0`) tells Docker to pick any free
host port instead of hardcoding one — important since multiple environments
(each with their own orchestrator) may run concurrently on the same host.
After `docker compose up -d orchestrator`, ask Docker which port it picked:

```bash
docker compose -p praxis-env-a81f3c port orchestrator 8000
# -> 0.0.0.0:54321
```

Combine that port with the host's reachable address (its public IP / DNS
name, or an ngrok/cloudflared tunnel if you're demoing from a laptop) to get
a public dashboard URL, e.g. `http://<host>:54321/`. Report this URL back to
the developer/TUI as part of the environment's status payload so they can
watch traffic and flip routes live during the demo.

If you'd rather have a stable, predictable port instead of a random one,
derive it deterministically from the environment id (e.g. hash `env-a81f3c`
into a port range) and use that instead of `0`.

### 3. Auto-register every service as a route on environment creation

As soon as each service container is up (or right after the whole Compose
project reports healthy), call the bulk endpoint **once** with every
service's Docker-network address:

```bash
curl -X POST http://<host>:<port>/api/routes/bulk \
  -H 'Content-Type: application/json' \
  -d '{
    "routes": {
      "edi": "http://edi:8080",
      "mob": "http://mob:9090",
      "axis-api": "http://mock-server:8080"
    }
  }'
```

Note `"axis-api": "http://mock-server:8080"` above — this is the key trick:
the orchestrator doesn't care what the *real* service is named, only what
logical name callers use. Registering `axis-api` (a logical/external
dependency name) to point at `mock-server` from the start means EDI's calls
are mocked from minute one; later, the agent can `PUT /api/routes/axis-api`
with the real Axis endpoint to test against production-like behavior, or
back to the mock to reproduce a failure — all without touching containers.

### 4. What each service needs to do to route through the orchestrator

Since routing is header-based (see above), a service must, for any call it
used to make directly to another service:

1. Send the request to `$ORCHESTRATOR_URL` instead of the real target.
2. Set `x-to-service` to the logical name you registered in step 3.
3. Set `x-from-service` to its own name (from `$SERVICE_NAME`) — optional,
   but strongly recommended since it's what makes the live activity feed
   and future TUI traces useful.

If the execution service controls how a cloned repo's HTTP client/base URLs
are configured (e.g. via env vars already read by that service's config
loader), it can often achieve this with **no code changes**: just point the
existing "MOB base URL" / "Axis API base URL" config value at
`$ORCHESTRATOR_URL` and inject the two headers via whatever HTTP client
default-headers mechanism the service already has (most HTTP clients/SDKs
support default/global headers). If a service's code truly cannot be
touched, it will need a thin outbound adapter (e.g. a thin sidecar/library)
that injects these two headers — flag this as a per-service integration
cost when planning which services go through the orchestrator first.

### 5. Suggested end-to-end sequence for the execution service

```
create environment (env-a81f3c)
        ↓
docker compose -p praxis-env-a81f3c up -d orchestrator
        ↓
wait for orchestrator healthy (GET /healthz, or Compose healthcheck)
        ↓
docker compose -p praxis-env-a81f3c port orchestrator 8000  -> public URL
        ↓
clone/build/start remaining services (edi, mob, mock-server, ...)
        ↓
wait for each service healthy
        ↓
POST /api/routes/bulk  { edi, mob, axis-api -> mock-server, ... }
        ↓
report {environmentId, dashboardUrl} back to the caller / TUI
        ↓
environment READY — agent can now PUT /api/routes/:service anytime
to redirect traffic mid-experiment
```

