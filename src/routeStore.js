const fs = require('fs');
const path = require('path');
const { eventBus } = require('./eventBus');

// The routes file location can be overridden with ROUTES_FILE (e.g. pointed
// at a mounted volume such as /app/data/routes.json in a container) so
// registered routes survive container restarts/recreation, not just process
// restarts. Falls back to routes.json in the project root for local dev.
const ROUTES_FILE = process.env.ROUTES_FILE || path.join(__dirname, '..', 'routes.json');

// Wildcard caller name: a route registered with this `from` applies to any
// caller that doesn't have its own explicit (from, to) override.
const WILDCARD_FROM = '*';

/**
 * RouteStore keeps the live mapping of (caller, destination) -> target base
 * URL, e.g. ("edi", "axis-api") -> "http://mock-server:8080". Routes are
 * keyed by the *pair*, not just the destination, so redirecting one caller's
 * traffic (e.g. EDI's calls to axis-api) never affects other callers of the
 * same logical destination (e.g. MOB's calls to axis-api).
 *
 * A route may also be registered with `from` set to the wildcard "*", which
 * acts as the fallback target for any caller that doesn't have its own
 * explicit override for that destination.
 *
 * This is the single source of truth the proxy middleware reads on every
 * request, and the thing the admin API / Praxis Lens agent mutates at
 * runtime to redirect traffic without restarting anything.
 *
 * Mutations are broadcast on the shared eventBus:
 *  - "route_changed" { from, to, target, updatedAt } on set
 *  - "route_removed" { from, to } on delete
 */
class RouteStore {
  constructor(filePath = ROUTES_FILE) {
    this.filePath = filePath;
    this.routes = new Map();
    this._load();
  }

  static get WILDCARD_FROM() {
    return WILDCARD_FROM;
  }

  _key(from, to) {
    return `${from}\u0000${to}`;
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      // routes.json is a flat array of { from, to, target, updatedAt }
      // entries (see README for the on-disk format and its history).
      for (const entry of parsed) {
        const { from, to, target, updatedAt } = entry;
        this.routes.set(this._key(from, to), { from, to, target, updatedAt });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[routeStore] Failed to load ${this.filePath}:`, err.message);
      }
    }
  }

  _persist() {
    const arr = Array.from(this.routes.values());
    // Create the parent directory if it doesn't exist yet - needed the first
    // time we write to a freshly mounted volume path (e.g. /app/data/...).
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(arr, null, 2));
  }

  getAll() {
    return Array.from(this.routes.values());
  }

  // Exact-match lookup for a specific (from, to) pair - used by the admin
  // API, which should only ever show/operate on literal registrations, not
  // wildcard-resolved ones.
  get(from, to) {
    return this.routes.get(this._key(from, to));
  }

  // Resolution used by the proxy on every request: try the caller's exact
  // override first, then fall back to the wildcard ("*", to) route if no
  // exact match exists.
  resolve(from, to) {
    return this.routes.get(this._key(from, to)) || this.routes.get(this._key(WILDCARD_FROM, to));
  }

  set(from, to, target) {
    const entry = { from, to, target, updatedAt: new Date().toISOString() };
    this.routes.set(this._key(from, to), entry);
    this._persist();
    eventBus.emit('route_changed', entry);
    return entry;
  }

  remove(from, to) {
    const existed = this.routes.delete(this._key(from, to));
    if (existed) {
      this._persist();
      eventBus.emit('route_removed', { from, to });
    }
    return existed;
  }
}

module.exports = { RouteStore, ROUTES_FILE, WILDCARD_FROM };
