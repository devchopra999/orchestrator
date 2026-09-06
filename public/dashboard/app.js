const routesBody = document.getElementById('routes-body');
const activityFeed = document.getElementById('activity-feed');
const connStatus = document.getElementById('conn-status');
const connLabel = document.getElementById('conn-label');
const toastContainer = document.getElementById('toast-container');
const addForm = document.getElementById('add-route-form');

let routes = new Map(); // "from\u0000to" -> { from, to, target, updatedAt }

function routeKey(from, to) {
  return `${from}\u0000${to}`;
}

function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleTimeString();
}

function showToast(message, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function renderRoutes() {
  if (routes.size === 0) {
    routesBody.innerHTML = '<tr class="empty-row"><td colspan="5">No routes registered yet.</td></tr>';
    return;
  }

  const rows = Array.from(routes.values())
    .sort((a, b) => a.to.localeCompare(b.to) || a.from.localeCompare(b.from))
    .map((entry) => `
      <tr data-from="${entry.from}" data-to="${entry.to}">
        <td class="svc-name">${entry.from}</td>
        <td class="svc-name">${entry.to}</td>
        <td class="target-cell"><input type="text" value="${entry.target}" data-role="target-input" /></td>
        <td class="updated-cell">${fmtTime(entry.updatedAt)}</td>
        <td>
          <div class="row-actions">
            <button data-action="save">Save</button>
            <button data-action="delete" class="danger">Remove</button>
          </div>
        </td>
      </tr>
    `)
    .join('');

  routesBody.innerHTML = rows;
}

function statusClass(status, error) {
  if (error || !status) return 'err';
  if (status >= 500) return 's5';
  if (status >= 400) return 's4';
  return 's2';
}

function renderActivity(entry) {
  const empty = activityFeed.querySelector('.empty-feed');
  if (empty) empty.remove();

  const row = document.createElement('div');
  row.className = 'activity-row';
  const statusLabel = entry.error ? 'ERR' : entry.status ?? '-';
  row.innerHTML = `
    <span class="time">${new Date().toLocaleTimeString()}</span>
    <span class="chain">${entry.from || '?'} → ${entry.to || '?'}</span>
    <span class="path">${entry.method || ''} ${entry.path || ''}</span>
    <span class="status ${statusClass(entry.status, entry.error)}">${statusLabel}</span>
  `;
  activityFeed.prepend(row);

  while (activityFeed.children.length > 100) {
    activityFeed.removeChild(activityFeed.lastChild);
  }
}

async function loadRoutes() {
  const res = await fetch('/api/routes');
  const data = await res.json();
  routes = new Map(data.map((r) => [routeKey(r.from, r.to), r]));
  renderRoutes();
}

async function upsertRoute(from, to, target) {
  const res = await fetch(`/api/routes/${encodeURIComponent(from)}/${encodeURIComponent(to)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  });
  const data = await res.json();
  if (!res.ok) {
    showToast(data.error || 'Failed to save route', true);
    return false;
  }
  showToast(`Route "${from}" → "${to}" → ${target}`);
  return true;
}

async function deleteRoute(from, to) {
  const res = await fetch(`/api/routes/${encodeURIComponent(from)}/${encodeURIComponent(to)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    const data = await res.json().catch(() => ({}));
    showToast(data.error || 'Failed to remove route', true);
    return;
  }
  showToast(`Route "${from}" → "${to}" removed`);
}

routesBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const row = e.target.closest('tr');
  const { from, to } = row.dataset;

  if (btn.dataset.action === 'save') {
    const input = row.querySelector('[data-role="target-input"]');
    await upsertRoute(from, to, input.value.trim());
  } else if (btn.dataset.action === 'delete') {
    await deleteRoute(from, to);
  }
});

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const from = document.getElementById('new-from').value.trim();
  const service = document.getElementById('new-service').value.trim();
  const target = document.getElementById('new-target').value.trim();
  if (!from || !service || !target) return;
  const ok = await upsertRoute(from, service, target);
  if (ok) {
    document.getElementById('new-from').value = '';
    document.getElementById('new-service').value = '';
    document.getElementById('new-target').value = '';
  }
});

function connectEvents() {
  const es = new EventSource('/api/events');

  es.onopen = () => {
    connStatus.classList.add('live');
    connLabel.textContent = 'live';
  };
  es.onerror = () => {
    connStatus.classList.remove('live');
    connLabel.textContent = 'reconnecting…';
  };

  es.addEventListener('route_changed', (e) => {
    const data = JSON.parse(e.data);
    routes.set(routeKey(data.from, data.to), data);
    renderRoutes();
  });

  es.addEventListener('route_removed', (e) => {
    const data = JSON.parse(e.data);
    routes.delete(routeKey(data.from, data.to));
    renderRoutes();
  });

  es.addEventListener('request_proxied', (e) => {
    renderActivity(JSON.parse(e.data));
  });
}

loadRoutes();
connectEvents();
