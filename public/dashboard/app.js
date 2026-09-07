const routesBody = document.getElementById('routes-body');
const activityFeed = document.getElementById('activity-feed');
const connStatus = document.getElementById('conn-status');
const connLabel = document.getElementById('conn-label');
const toastContainer = document.getElementById('toast-container');
const addForm = document.getElementById('add-route-form');

let routes = new Map(); // "from\u0000to" -> { from, to, target, updatedAt }
let labels = new Map(); // raw key (a `from` string OR a raw target URL) -> { key, label, updatedAt }

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

// ---------------------------------------------------------------------
// Flow Map: recursively-chained from -> target visualization.
//
// The "to" field is intentionally never shown here - a route is treated
// as a from -> target edge. If a route's raw target resolves (see
// `chainCandidateKeys` below) to the same value as some route's raw `from`,
// the chain keeps following it (e.g. Gateway -> Auth -> Mock-Server) -
// this is derived purely from the route data itself, so it works with zero
// setup. The optional label map (`/api/labels`) only controls what a node
// is *displayed* as afterwards; it never affects the chain shape.
//
// Node ids are built from the path of (from, to) pairs leading to them
// (each pair is already unique, since that's how routeStore keys routes),
// so the same logical node stays identified across re-renders even when
// its displayed name/target changes - that's what lets D3 animate a link
// moving to a new endpoint instead of just swapping it.
// ---------------------------------------------------------------------

const flowSvg = d3.select('#flow-map');
const flowWrap = document.querySelector('.flowmap-wrap');
const flowEmpty = document.getElementById('flowmap-empty');

const FM_ROW_H = 72;
const FM_COL_GAP = 64;
const FM_PILL_H = 40;
const FM_MARGIN = { top: 34, right: 40, bottom: 34, left: 40 };
const FM_LABEL_MAX_CHARS = 28;

let fmPrevNames = new Map(); // node id -> last displayed name (to detect changes for the flash animation)
let fmRoutesReady = false;
let fmLabelsReady = false;

// Off-screen canvas used purely to measure rendered text width so pill
// nodes can be sized to fit their label instead of using one fixed size.
const fmMeasureCtx = document.createElement('canvas').getContext('2d');
fmMeasureCtx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif';

function displayName(name) {
  return name === '*' ? 'Any caller' : name;
}

function hostFallback(target) {
  try {
    return new URL(target).host || target;
  } catch {
    return target;
  }
}

// The candidate keys used purely to decide whether a route's target chains
// into another route's `from` - derived straight from the raw data, never
// from the label map. Tried most-specific-first:
//   1. The raw target string itself, verbatim - covers a `from` that was set
//      to the exact target string (e.g. a bare identifier like "C", or even
//      a full URL used as-is as the next hop's `from`).
//   2. host (hostname:port) - covers chaining into a `from` that includes
//      the port, e.g. "mock-server:8080".
//   3. hostname only (no port) - the common Docker/service-name convention,
//      so "http://mock-server:8080" naturally chains into `from: "mock-server"`.
// Every candidate is checked against the real `from` values with zero setup
// required; the first one that matches an existing `from` wins.
function chainCandidateKeys(target) {
  const keys = [target];
  try {
    const u = new URL(target);
    if (u.host && !keys.includes(u.host)) keys.push(u.host);
    if (u.hostname && !keys.includes(u.hostname)) keys.push(u.hostname);
  } catch {
    // not a URL - the raw string (already in keys) is the only candidate
  }
  return keys;
}

// Display label for a node's raw key, going through the optional label map
// first. `isLeaf` distinguishes a raw target URL (leaf) from a raw `from`
// value (root/chain), since the fallback formatting differs.
function labelFor(rawKey, isLeaf) {
  const mapped = labels.get(rawKey)?.label;
  if (mapped) return mapped;
  return isLeaf ? hostFallback(rawKey) : displayName(rawKey);
}

function truncateText(text, max = FM_LABEL_MAX_CHARS) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function fmTextWidth(text) {
  return fmMeasureCtx.measureText(text).width;
}

// Builds the from -> target forest straight from the raw route data. The
// `to` field only contributes to the (from,to) id used for animation
// continuity - it's never displayed or used for matching.
function buildFlowForest() {
  const byFrom = new Map(); // raw from -> [{ routeKey, rawTarget, candidates }]
  const matchKeysUsed = new Set(); // every candidate key that is *someone's* target

  for (const r of routes.values()) {
    const candidates = chainCandidateKeys(r.target);
    const edge = { routeKey: routeKey(r.from, r.to), rawTarget: r.target, candidates };
    if (!byFrom.has(r.from)) byFrom.set(r.from, []);
    byFrom.get(r.from).push(edge);
    for (const key of candidates) matchKeysUsed.add(key);
  }

  let roots = Array.from(byFrom.keys()).filter((name) => !matchKeysUsed.has(name));
  // Pure cycles (every `from` is also someone's target) have no natural
  // entry point - fall back to treating every from as a root so something
  // still renders (cycle detection below stops each branch from looping).
  if (roots.length === 0) roots = Array.from(byFrom.keys());

  // Picks the most-specific candidate that matches a real `from` and hasn't
  // already been visited on this path (cycle guard). Returns undefined if
  // none of the candidates chain further, i.e. this edge ends in a leaf.
  function resolveChain(candidates, visited) {
    for (const key of candidates) {
      if (byFrom.has(key)) return key;
    }
    return undefined;
  }

  function build(fromRaw, id, visited) {
    const nextVisited = new Set(visited);
    nextVisited.add(fromRaw);
    const node = { id, kind: id.includes('>') ? 'chain' : 'root', rawKey: fromRaw, isLeaf: false, cyclic: false, children: [] };

    for (const edge of byFrom.get(fromRaw)) {
      const childId = `${id}>${edge.routeKey}`;
      const matchKey = resolveChain(edge.candidates, visited);
      if (matchKey && !visited.has(matchKey)) {
        const child = build(matchKey, childId, nextVisited);
        child.rawTarget = edge.rawTarget;
        node.children.push(child);
      } else {
        node.children.push({
          id: childId,
          kind: 'leaf',
          rawKey: edge.rawTarget,
          rawTarget: edge.rawTarget,
          isLeaf: true,
          cyclic: Boolean(matchKey), // matched a from, but it's an ancestor - dead-ended to avoid a loop
          children: [],
        });
      }
    }
    return node;
  }

  return roots.map((from) => build(from, `root::${from}`, new Set()));
}

function fmLinkPath(sx, sy, tx, ty) {
  const midX = (sx + tx) / 2;
  return `M${sx},${sy}C${midX},${sy} ${midX},${ty} ${tx},${ty}`;
}

function closeFlowMapEditor() {
  const existing = flowWrap.querySelector('.fm-edit-input');
  if (existing) existing.remove();
}

function startFlowMapEdit(nodeEl, d) {
  closeFlowMapEditor();
  const wrapRect = flowWrap.getBoundingClientRect();
  const nodeRect = nodeEl.getBoundingClientRect();
  const cx = nodeRect.left + nodeRect.width / 2 - wrapRect.left + flowWrap.scrollLeft;
  const cy = nodeRect.top + nodeRect.height / 2 - wrapRect.top + flowWrap.scrollTop;

  const input = document.createElement('input');
  input.className = 'fm-edit-input';
  input.style.left = `${cx}px`;
  input.style.top = `${cy}px`;
  input.placeholder = d.isLeaf ? hostFallback(d.rawKey) : displayName(d.rawKey);
  input.value = d.name;
  flowWrap.appendChild(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const val = input.value.trim();
    input.remove();
    if (val === d.name) return;
    try {
      if (!val) {
        await fetch(`/api/labels/${encodeURIComponent(d.rawKey)}`, { method: 'DELETE' });
      } else {
        await fetch(`/api/labels/${encodeURIComponent(d.rawKey)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: val }),
        });
      }
    } catch {
      showToast('Failed to save label', true);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      input.blur();
    } else if (e.key === 'Escape') {
      committed = true;
      input.remove();
    }
  });
  input.addEventListener('blur', commit, { once: true });
}

function ensureFlowMapDefs() {
  if (!flowSvg.select('defs').empty()) return;
  const defs = flowSvg.append('defs');
  const marker = defs
    .append('marker')
    .attr('id', 'fm-arrow')
    .attr('viewBox', '0 0 10 10')
    .attr('refX', 8.5)
    .attr('refY', 5)
    .attr('markerWidth', 7)
    .attr('markerHeight', 7)
    .attr('orient', 'auto-start-reverse');
  marker.append('path').attr('d', 'M0,0L10,5L0,10Z').attr('class', 'fm-arrow-head');
}

function renderFlowMap() {
  // Wait for both the routes and labels fetches to complete once at boot,
  // so the very first paint doesn't briefly show hostname fallbacks and
  // then "flash" as soon as labels arrive a moment later.
  if (!fmRoutesReady || !fmLabelsReady) return;

  closeFlowMapEditor();

  if (routes.size === 0) {
    flowEmpty.style.display = '';
    flowSvg.style('display', 'none');
    flowSvg.selectAll('g.fm-root-g').remove();
    fmPrevNames = new Map();
    return;
  }
  flowEmpty.style.display = 'none';
  flowSvg.style('display', '');
  ensureFlowMapDefs();

  const forest = buildFlowForest();
  const synthetic = { id: '__synthetic-root__', rawKey: '', isLeaf: false, children: forest };
  const hierRoot = d3.hierarchy(synthetic);
  d3.tree()
    .nodeSize([FM_ROW_H, 1])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.35))(hierRoot);

  const nodes = hierRoot.descendants().filter((d) => d.depth > 0);
  const links = hierRoot.links().filter((l) => l.source.depth > 0);

  // Resolve display text + measured pill width for every node up front.
  nodes.forEach((d) => {
    const text = truncateText(labelFor(d.data.rawKey, d.data.isLeaf));
    d.text = text;
    d.pillW = Math.max(96, Math.min(220, Math.round(fmTextWidth(text) + 48)));
  });

  // Column x-offset per depth = running sum of (prev column half-width +
  // gap + this column half-width), based on the widest pill in each column
  // - so the layout adapts to label length instead of a fixed grid.
  const maxDepth = d3.max(nodes, (d) => d.depth) ?? 1;
  const colWidth = new Array(maxDepth + 1).fill(0);
  nodes.forEach((d) => {
    colWidth[d.depth] = Math.max(colWidth[d.depth], d.pillW);
  });
  const colX = new Array(maxDepth + 1).fill(0);
  colX[1] = FM_MARGIN.left + colWidth[1] / 2;
  for (let depth = 2; depth <= maxDepth; depth += 1) {
    colX[depth] = colX[depth - 1] + colWidth[depth - 1] / 2 + FM_COL_GAP + colWidth[depth] / 2;
  }

  const minX = d3.min(nodes, (d) => d.x) ?? 0;
  const maxX = d3.max(nodes, (d) => d.x) ?? 0;
  const yOffset = FM_MARGIN.top - minX;
  const svgWidth = colX[maxDepth] + colWidth[maxDepth] / 2 + FM_MARGIN.right;
  const svgHeight = maxX - minX + FM_MARGIN.top + FM_MARGIN.bottom;

  nodes.forEach((d) => {
    d.px = colX[d.depth];
    d.py = d.x + yOffset;
  });

  flowSvg.attr('width', Math.max(svgWidth, 360)).attr('height', Math.max(svgHeight, 140));

  let g = flowSvg.select('g.fm-root-g');
  if (g.empty()) g = flowSvg.append('g').attr('class', 'fm-root-g');

  const nextNames = new Map();
  nodes.forEach((d) => nextNames.set(d.data.id, d.text));

  const linkData = links.map((l) => ({
    id: l.target.data.id,
    sx: l.source.px + l.source.pillW / 2,
    sy: l.source.py,
    tx: l.target.px - l.target.pillW / 2 - 8,
    ty: l.target.py,
    changed: fmPrevNames.has(l.target.data.id) && fmPrevNames.get(l.target.data.id) !== l.target.text,
  }));

  const linkSel = g.selectAll('path.fm-link').data(linkData, (d) => d.id);
  linkSel.exit().transition().duration(250).style('opacity', 0).remove();
  const linkEnter = linkSel.enter().append('path').attr('class', 'fm-link').attr('marker-end', 'url(#fm-arrow)').style('opacity', 0);
  linkEnter
    .merge(linkSel)
    .classed('fm-flash', (d) => d.changed)
    .attr('d', (d) => fmLinkPath(d.sx, d.sy, d.tx, d.ty))
    .transition()
    .duration(450)
    .style('opacity', 1)
    .attr('d', (d) => fmLinkPath(d.sx, d.sy, d.tx, d.ty));

  const nodeData = nodes.map((d) => ({
    id: d.data.id,
    kind: d.data.kind,
    name: d.text,
    isLeaf: d.data.isLeaf,
    cyclic: d.data.cyclic,
    rawKey: d.data.rawKey,
    rawTarget: d.data.rawTarget,
    px: d.px,
    py: d.py,
    w: d.pillW,
    changed: fmPrevNames.has(d.data.id) && fmPrevNames.get(d.data.id) !== d.text,
  }));

  const nodeSel = g.selectAll('g.fm-node').data(nodeData, (d) => d.id);

  nodeSel.exit().transition().duration(250).style('opacity', 0).remove();

  const nodeEnter = nodeSel.enter().append('g').style('opacity', 0);
  nodeEnter.append('rect').attr('class', 'fm-pill').attr('height', FM_PILL_H).attr('y', -FM_PILL_H / 2);
  nodeEnter.append('title');
  nodeEnter.append('text').attr('class', 'fm-label').attr('text-anchor', 'middle').attr('dy', '0.32em');
  nodeEnter.append('text').attr('class', 'fm-hint').attr('text-anchor', 'middle').attr('dy', FM_PILL_H / 2 + 13);

  const nodeMerge = nodeEnter.merge(nodeSel);
  nodeMerge
    .attr('class', (d) => `fm-node fm-${d.kind}${d.cyclic ? ' fm-cyclic' : ''}`)
    .classed('fm-flash', (d) => d.changed)
    .attr('tabindex', 0)
    .attr('role', 'button');
  nodeMerge
    .select('rect.fm-pill')
    .attr('rx', (d) => Math.min(18, FM_PILL_H / 2))
    .attr('x', (d) => -d.w / 2)
    .attr('width', (d) => d.w);
  nodeMerge.select('title').text((d) => {
    const raw = d.isLeaf ? d.rawTarget : displayName(d.rawKey);
    return d.name === raw ? raw : `${d.name}  (${raw})`;
  });
  nodeMerge.select('text.fm-label').text((d) => d.name);
  nodeMerge.select('text.fm-hint').text((d) => (d.cyclic ? '↺ cycle - click to rename' : '✎ click to rename'));
  nodeMerge
    .on('click', function (event, d) {
      startFlowMapEdit(this, d);
    })
    .transition()
    .duration(450)
    .style('opacity', 1)
    .attr('transform', (d) => `translate(${d.px},${d.py})`);

  fmPrevNames = nextNames;
}

async function loadRoutes() {
  const res = await fetch('/api/routes');
  const data = await res.json();
  routes = new Map(data.map((r) => [routeKey(r.from, r.to), r]));
  fmRoutesReady = true;
  renderRoutes();
  renderFlowMap();
}

async function loadLabels() {
  const res = await fetch('/api/labels');
  const data = await res.json();
  labels = new Map(data.map((l) => [l.key, l]));
  fmLabelsReady = true;
  renderFlowMap();
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
    renderFlowMap();
  });

  es.addEventListener('route_removed', (e) => {
    const data = JSON.parse(e.data);
    routes.delete(routeKey(data.from, data.to));
    renderRoutes();
    renderFlowMap();
  });

  es.addEventListener('request_proxied', (e) => {
    renderActivity(JSON.parse(e.data));
  });

  es.addEventListener('label_changed', (e) => {
    const data = JSON.parse(e.data);
    labels.set(data.key, data);
    renderFlowMap();
  });

  es.addEventListener('label_removed', (e) => {
    const data = JSON.parse(e.data);
    labels.delete(data.key);
    renderFlowMap();
  });
}

loadRoutes();
loadLabels();
connectEvents();
