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

The orchestrator's routing table (which **caller** currently points which
**destination** at which real target URL) can be changed **at runtime**, via
a REST API or the built-in dashboard — no restarts, no redeploys. This is
the building block that lets a Praxis Lens agent redirect a *specific
service's* traffic (e.g. swap a real third-party API for a mock server)
mid-experiment, without affecting any other service that happens to talk to
the same destination.

## Why header-based routing

Instead of path prefixes, the orchestrator uses two headers so the calling
service barely has to change anything — just point it at the orchestrator's
host instead of the real target, keep the same path, and add two headers:

| Header             | Meaning                                                      |
|--------------------|---------------------------------------------------------------|
| `x-to-service`     | **Required.** Logical name of the destination.                |
| `x-from-service`   | **Required.** Logical name of the caller — routes are keyed by the `(from, to)` pair, not just `to`. |

### Routes are per (caller, destination) pair, not just per destination

A route is keyed by **both** who's calling and where they're going, e.g.
`edi -> axis-api -> http://mock-server:8080`. This matters because
multiple services can call the same logical destination: if `edi` and `mob`
both call `axis-api`, redirecting `edi`'s traffic to a mock server should
**not** silently redirect `mob`'s traffic too. Keying routes only by the
destination (as an earlier version of this design did) meant *any* update
to `axis-api`'s route affected every caller — updating one service's route
would unexpectedly change another's, since they shared a single global
entry.

You can also register a **wildcard** route with `from` set to `*`, which
acts as the fallback target for any caller that doesn't have its own
explicit `(from, to)` override. This keeps bulk-registering a whole
environment simple (`* -> axis-api -> http://mock-server:8080` mocks it for
everyone by default) while still allowing an agent to carve out a
caller-specific override later (`edi -> axis-api -> http://real-axis.com`)
without touching anyone else's route.

On every request, the orchestrator resolves `(x-from-service,
x-to-service)` against its live route table — trying the exact pair first,
then falling back to the wildcard `(*, x-to-service)` route — so changing a
route takes effect on the very next request.

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
curl -X PUT http://localhost:8000/api/routes/serviceA/serviceB \
  -H 'Content-Type: application/json' \
  -d '{"target": "http://localhost:4002"}'
```

Send traffic through the orchestrator as if it were serviceA calling serviceB:

```bash
curl http://localhost:8000/anything/you/want \
  -H 'x-from-service: serviceA' \
  -H 'x-to-service: serviceB'
```

Now redirect `serviceA`'s traffic to `serviceB` elsewhere at runtime, with
zero downtime, **without affecting any other caller of `serviceB`**:

```bash
curl -X PUT http://localhost:8000/api/routes/serviceA/serviceB \
  -H 'Content-Type: application/json' \
  -d '{"target": "http://localhost:4001"}'   # now points at serviceA's echo instead
```

The very next request with `x-from-service: serviceA` and
`x-to-service: serviceB` is now handled by the new target — this is exactly
how the Praxis Lens agent redirects `EDI -> Axis API` to
`EDI -> Mock Server` mid-experiment (see project docs), leaving any other
service's calls to Axis API untouched.

## Admin (control-plane) API

| Method | Path                        | Description                                      |
|--------|-----------------------------|---------------------------------------------------|
| GET    | `/healthz`                  | Liveness/readiness probe. `{ "status": "ok", "routes": <n> }`. |
| GET    | `/api/routes`               | List all registered routes. Each entry is `{ "from", "to", "target", "updatedAt" }`. |
| GET    | `/api/routes/:from/:to`     | Look up which target a single `(from, to)` pair is currently routing to (exact match, no wildcard fallback). Returns `{ "from", "to", "target", "updatedAt" }`, or `404` if unregistered. |
| PUT    | `/api/routes/:from/:to`     | Create/update a single route. Body: `{ "target": "http://host:port" }`. Use `*` as `:from` to register/update the wildcard (any-caller) route for `:to`. |
| POST   | `/api/routes/bulk`          | Register/update many routes in one call. Body: `{ "routes": [ { "from": "edi", "to": "axis-api", "target": "http://mock-server:8080" }, { "from": "*", "to": "mob", "target": "http://mob:9090" } ] }`. Returns `{ registered: [...], errors: [...] }`. **This is what the execution service calls once, right after an environment's containers are up, to wire every service through the orchestrator in one shot.** |
| DELETE | `/api/routes/:from/:to`     | Remove a route.                                    |
| GET    | `/api/events`               | Server-Sent Events stream (`route_changed`, `route_removed`, `request_proxied`) — powers the dashboard and can later feed the Praxis Lens TUI. |

Routes persist to `routes.json` in the project root (gitignored) so they
survive **process** restarts (e.g. `npm start` crashing/restarting, `npm run
dev`'s `--watch` reloads). The path is configurable via the `ROUTES_FILE`
env var, and the parent directory is created automatically if it doesn't
exist yet (useful when pointing it at a mounted volume).

> **Breaking change:** `routes.json` is now a JSON **array** of
> `{ "from", "to", "target", "updatedAt" }` entries, instead of the old flat
> `{ "<service>": { "target", "updatedAt" } }` object keyed only by
> destination. There is no automatic migration — if you have an old-format
> `routes.json` lying around, delete it (or re-run your bulk registration
> call) before starting the orchestrator.

> **Running in Docker?** By default the image sets `ROUTES_FILE=/app/data/routes.json`
> and declares `/app/data` as a volume. Without mounting an actual host
> path/named volume there, that directory is just part of the container's
> writable layer - fine for a process restart, but **wiped whenever the
> container itself is recreated** (redeploy, `docker compose up` after a
> `down`, etc). Mount a persistent volume at `/app/data` (see the Execution
> Service Integration Guide below) if routes need to survive container
> restarts, not just process restarts.

Look up where traffic from a given caller to a given service currently goes:

```bash
curl http://localhost:8000/api/routes/serviceA/serviceB
# -> {"from":"serviceA","to":"serviceB","target":"http://localhost:4002","updatedAt":"..."}
```

> Note: the admin API has **no authentication** — acceptable for a
> hackathon/local demo, but add an API key or network restriction before
> using this anywhere less trusted.

## Project layout

```
index.js                   entrypoint: wires dashboard + admin API + proxy
Dockerfile, .dockerignore  builds the orchestrator as a standalone image
src/
  routeStore.js             in-memory (from,to) route table + routes.json persistence
  eventBus.js                shared EventEmitter (route changes + request logs)
  proxyMiddleware.js          resolves (x-from-service, x-to-service) -> target, proxies the request
  adminApi.js                 REST + SSE control-plane API
  logger.js                   console logging for proxied requests
public/dashboard/            dashboard UI (static, no build step)
examples/serviceA.js, serviceB.js   minimal echo servers for local testing
```

## How this fits into Praxis Lens

This orchestrator is the traffic-control primitive for the "Execution
Infrastructure" layer described in the Praxis Lens architecture: the
LangGraph agent decides *what* should be redirected (e.g. "point EDI's Axis
API calls at the mock server"), and calls `PUT /api/routes/edi/axis-api`
here to make it happen instantly for EDI specifically — without restarting
EDI or any other service, and without affecting any other service that
also calls `axis-api`.

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
caller/destination pair's Docker-network address:

```bash
curl -X POST http://<host>:<port>/api/routes/bulk \
  -H 'Content-Type: application/json' \
  -d '{
    "routes": [
      { "from": "*", "to": "edi", "target": "http://edi:8080" },
      { "from": "*", "to": "mob", "target": "http://mob:9090" },
      { "from": "*", "to": "axis-api", "target": "http://mock-server:8080" }
    ]
  }'
```

Note `{ "from": "*", "to": "axis-api", "target": "http://mock-server:8080" }`
above — this is the key trick: the orchestrator doesn't care what the
*real* service is named, only what logical name callers use, and the
wildcard `from: "*"` means *every* caller gets this target by default.
Registering `axis-api` (a logical/external dependency name) to point at
`mock-server` from the start means every service's calls are mocked from
minute one.

Later, the agent can carve out a **caller-specific override** without
touching anyone else's traffic, e.g. to test EDI against the real Axis API
while every other caller stays mocked:

```bash
curl -X PUT http://<host>:<port>/api/routes/edi/axis-api \
  -H 'Content-Type: application/json' \
  -d '{"target": "http://axis.com"}'
```

This only changes what EDI's `x-to-service: axis-api` calls resolve to;
`mob` (and anyone else without an explicit override) keeps hitting the
wildcard target (`mock-server`). Deleting the override
(`DELETE /api/routes/edi/axis-api`) drops EDI back to the wildcard too.

### 4. What each service needs to do to route through the orchestrator

Since routing is header-based (see above), a service must, for any call it
used to make directly to another service:

1. Send the request to `$ORCHESTRATOR_URL` instead of the real target.
2. Set `x-to-service` to the logical name you registered in step 3.
3. Set `x-from-service` to its own name (from `$SERVICE_NAME`) — **required**,
   since routes are resolved per `(from, to)` pair and this is what makes
   the live activity feed and future TUI traces useful.

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
POST /api/routes/bulk  { *->edi, *->mob, *->axis-api -> mock-server, ... }
        ↓
report {environmentId, dashboardUrl} back to the caller / TUI
        ↓
environment READY — agent can now PUT /api/routes/:from/:to anytime
to redirect a specific caller's traffic mid-experiment
```

