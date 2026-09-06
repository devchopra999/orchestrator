const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

function statusColor(status) {
  if (!status) return YELLOW;
  if (status >= 500) return RED;
  if (status >= 400) return YELLOW;
  return GREEN;
}

/**
 * Logs a single proxied request in a compact, readable line, e.g.:
 *   [12:03:41] edi -> axis-api (http://mock-server:8080) GET /transactions/42 200 18ms
 */
function logProxiedRequest({ from, to, target, method, path, status, durationMs, error }) {
  const time = new Date().toLocaleTimeString();
  const fromLabel = from || 'unknown';
  const toLabel = to || 'unknown';
  const statusLabel = error ? 'ERR' : status;
  const color = error ? RED : statusColor(status);

  console.log(
    `${DIM}[${time}]${RESET} ${CYAN}${fromLabel}${RESET} -> ${CYAN}${toLabel}${RESET} ` +
      `${DIM}(${target || 'unresolved'})${RESET} ${method} ${path} ` +
      `${color}${statusLabel}${RESET} ${durationMs != null ? `${durationMs}ms` : ''}` +
      (error ? ` ${RED}${error}${RESET}` : '')
  );
}

module.exports = { logProxiedRequest };
