const { EventEmitter } = require('events');

/**
 * Single shared event bus for the whole orchestrator process.
 * routeStore emits "route_changed" / "route_removed" here, and the proxy
 * middleware emits "request_proxied" here. The admin API's SSE endpoint
 * (/api/events) just relays whatever comes through this bus, so the
 * dashboard (and later, the Praxis Lens TUI) sees a single live feed.
 */
const eventBus = new EventEmitter();
eventBus.setMaxListeners(50);

module.exports = { eventBus };
