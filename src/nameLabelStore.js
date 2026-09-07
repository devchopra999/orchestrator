const fs = require('fs');
const path = require('path');
const { eventBus } = require('./eventBus');

// Mirrors ROUTES_FILE's override convention - lets the label file live on
// the same mounted volume as routes.json in a container so labels survive
// restarts/recreation too.
const LABELS_FILE = process.env.LABELS_FILE || path.join(__dirname, '..', 'labels.json');

/**
 * NameLabelStore keeps a friendly-name mapping for raw route identifiers.
 * The key can be **either** a raw `from` value or a raw `target` value -
 * e.g. "mock-server" -> "Mock Server", or "http://mock-server:8080" ->
 * "Mock Server". This is purely cosmetic/display - it never affects
 * routing or the Flow Map's chain-following logic (that's derived straight
 * from the raw route data - see `buildFlowForest` in the dashboard's
 * app.js), it only controls what a node is *labeled* once the chain shape
 * has already been determined.
 *
 * Mutations are broadcast on the shared eventBus:
 *  - "label_changed" { key, label, updatedAt } on set
 *  - "label_removed" { key } on delete
 */
class NameLabelStore {
  constructor(filePath = LABELS_FILE) {
    this.filePath = filePath;
    this.labels = new Map();
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      // labels.json is a flat array of { key, label, updatedAt } entries,
      // same shape convention as routes.json.
      for (const entry of parsed) {
        const { key, label, updatedAt } = entry;
        this.labels.set(key, { key, label, updatedAt });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[nameLabelStore] Failed to load ${this.filePath}:`, err.message);
      }
    }
  }

  _persist() {
    const arr = Array.from(this.labels.values());
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(arr, null, 2));
  }

  getAll() {
    return Array.from(this.labels.values());
  }

  get(key) {
    return this.labels.get(key);
  }

  set(key, label) {
    const entry = { key, label, updatedAt: new Date().toISOString() };
    this.labels.set(key, entry);
    this._persist();
    eventBus.emit('label_changed', entry);
    return entry;
  }

  remove(key) {
    const existed = this.labels.delete(key);
    if (existed) {
      this._persist();
      eventBus.emit('label_removed', { key });
    }
    return existed;
  }
}

module.exports = { NameLabelStore, LABELS_FILE };
