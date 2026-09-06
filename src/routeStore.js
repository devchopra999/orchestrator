const fs = require('fs');
const path = require('path');
const { eventBus } = require('./eventBus');

// The routes file location can be overridden with ROUTES_FILE (e.g. pointed
// at a mounted volume such as /app/data/routes.json in a container) so
// registered routes survive container restarts/recreation, not just process
// restarts. Falls back to routes.json in the project root for local dev.
const ROUTES_FILE = process.env.ROUTES_FILE || path.join(__dirname, '..', 'routes.json');

/**
 * RouteStore keeps the live mapping of logical service name -> target base URL
 * (e.g. "axis-api" -> "http://mock-server:8080"). It's the single source of
 * truth the proxy middleware reads on every request, and the thing the admin
 * API / Praxis Lens agent mutates at runtime to redirect traffic without
 * restarting anything.
 *
 * Mutations are broadcast on the shared eventBus:
 *  - "route_changed" { service, target, updatedAt } on set
 *  - "route_removed" { service } on delete
 */
class RouteStore {
  constructor(filePath = ROUTES_FILE) {
    this.filePath = filePath;
    this.routes = new Map();
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      for (const [service, entry] of Object.entries(parsed)) {
        this.routes.set(service, entry);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[routeStore] Failed to load ${this.filePath}:`, err.message);
      }
    }
  }

  _persist() {
    const obj = Object.fromEntries(this.routes);
    // Create the parent directory if it doesn't exist yet - needed the first
    // time we write to a freshly mounted volume path (e.g. /app/data/...).
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
  }

  getAll() {
    return Array.from(this.routes.entries()).map(([service, entry]) => ({
      service,
      ...entry,
    }));
  }

  get(service) {
    return this.routes.get(service);
  }

  set(service, target) {
    const entry = { target, updatedAt: new Date().toISOString() };
    this.routes.set(service, entry);
    this._persist();
    eventBus.emit('route_changed', { service, ...entry });
    return entry;
  }

  remove(service) {
    const existed = this.routes.delete(service);
    if (existed) {
      this._persist();
      eventBus.emit('route_removed', { service });
    }
    return existed;
  }
}

module.exports = { RouteStore, ROUTES_FILE };
