let data = null;

let editingLodging = null; // lodging id currently in edit mode, or 'new:<stopId>'
const expandedNearby = new Set(); // lodging ids with the nearby panel open
let dragState = null; // { type: 'stop'|'lodging', id, stopId? }
let moveState = null; // touch-friendly reorder: tapped ⋮⋮ → { type, id, stopId? }
let suppressDragClickUntil = 0;
const collapsedStoreKey = `trip-collapsed-stops:${location.pathname}`;
function readStored(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v && typeof v === 'object' ? v : fallback; } catch { return fallback; } }
const collapsedValue = readStored(collapsedStoreKey, []);
const collapsedStops = new Set(Array.isArray(collapsedValue) ? collapsedValue : []);
const variantDetailStoreKey = `trip-variant-details:${location.pathname}`;
const variantDetailState = readStored(variantDetailStoreKey, {});
const pendingDateChanges = new Map();
let applyingDateChanges = false;

function saveCollapsedStops() {
  localStorage.setItem(collapsedStoreKey, JSON.stringify([...collapsedStops]));
}

function variantDetailOpen(cand, active) {
  if (Object.prototype.hasOwnProperty.call(variantDetailState, cand.id)) return !!variantDetailState[cand.id];
  return active || stopLodgingSorted(cand.id).length > 0;
}

function setVariantDetailOpen(candId, open) {
  variantDetailState[candId] = open;
  localStorage.setItem(variantDetailStoreKey, JSON.stringify(variantDetailState));
}

function stopDateValue(stop, field) {
  const draft = pendingDateChanges.get(stop?.id);
  if (draft && draft[field] !== undefined) return draft[field];
  return stop?.[field] || '';
}

function hasPendingStopDate(stopId, field) {
  const stop = data?.stops?.find(s => s.id === stopId);
  const draft = pendingDateChanges.get(stopId);
  return !!(stop && draft && draft[field] !== undefined && draft[field] !== (stop[field] || ''));
}

function pendingDateEntries() {
  if (!data) return [];
  const entries = [];
  for (const [id, draft] of [...pendingDateChanges.entries()]) {
    const stop = data.stops.find(s => s.id === id);
    if (!stop) { pendingDateChanges.delete(id); continue; }
    const checkin = draft.checkin ?? stop.checkin ?? '';
    const checkout = draft.checkout ?? stop.checkout ?? '';
    if (checkin === (stop.checkin || '') && checkout === (stop.checkout || '')) {
      pendingDateChanges.delete(id);
      continue;
    }
    entries.push({ id, place: stop.place || 'Unnamed stop', checkin, checkout });
  }
  return entries;
}

function hasInvalidPendingDateRange(entries = pendingDateEntries()) {
  return entries.some(({ checkin, checkout }) =>
    checkin && checkout && Date.parse(checkout) < Date.parse(checkin));
}

function stageStopDate(id, field, value) {
  const stop = data.stops.find(s => s.id === id);
  if (!stop) return;
  const draft = {
    checkin: stopDateValue(stop, 'checkin'),
    checkout: stopDateValue(stop, 'checkout'),
  };
  draft[field] = value;
  pendingDateChanges.set(id, draft);
  pendingDateEntries();
  render();
}

function clearPendingDates() {
  pendingDateChanges.clear();
  render();
}

async function applyPendingDates() {
  const updates = pendingDateEntries().map(({ id, checkin, checkout }) => ({ id, checkin, checkout }));
  if (!updates.length || applyingDateChanges) return;
  if (hasInvalidPendingDateRange()) {
    alert('Fix date ranges before applying.');
    renderDateApplyBar();
    return;
  }
  applyingDateChanges = true;
  renderDateApplyBar();
  try {
    data = await api('PUT', 'stops-dates', { updates });
    pendingDateChanges.clear();
    render();
  } catch (err) {
    alert('Date save failed — check connection and retry.');
    renderDateApplyBar();
  } finally {
    applyingDateChanges = false;
    renderDateApplyBar();
  }
}

function renderDateApplyBar() {
  const changes = pendingDateEntries();
  let bar = $('#date-apply-bar');
  if (!changes.length) {
    bar?.remove();
    document.body.classList.remove('has-pending-dates');
    return;
  }
  document.body.classList.add('has-pending-dates');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'date-apply-bar';
    document.body.appendChild(bar);
  }
  const label = changes.length === 1 ? '1 date edit staged' : `${changes.length} date edits staged`;
  const invalid = hasInvalidPendingDateRange(changes);
  bar.innerHTML = `
    <div class="date-apply-copy">
      <strong>${label}</strong>
      <span>${invalid ? 'Fix date ranges before applying.' : 'Date changes are not saved until you apply.'}</span>
    </div>
    <div class="date-apply-actions">
      <button class="btn-secondary" type="button" data-revert-dates ${applyingDateChanges ? 'disabled' : ''}>Revert</button>
      <button class="btn-primary" type="button" data-apply-dates ${applyingDateChanges || invalid ? 'disabled' : ''}>${applyingDateChanges ? 'Applying…' : 'Apply dates'}</button>
    </div>`;
  $('[data-revert-dates]', bar)?.addEventListener('click', clearPendingDates);
  $('[data-apply-dates]', bar)?.addEventListener('click', applyPendingDates);
}

document.addEventListener('click', e => {
  if (Date.now() < suppressDragClickUntil) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);

// Suppress the click that some touch browsers fire after a scroll gesture
// that started on the element.
function guardScrollClicks(el) {
  let moved = false;
  el.addEventListener('touchstart', () => { moved = false; }, { passive: true });
  el.addEventListener('touchmove', () => { moved = true; }, { passive: true });
  el.addEventListener('click', e => {
    if (moved) { e.stopImmediatePropagation(); e.preventDefault(); moved = false; }
  }, true); // capture phase: runs before the card's own click handlers
}

// "take the target's place" reordering (still used by the package-offers view)
function reorderTakePlace(ids, draggedId, targetId) {
  const from = ids.indexOf(draggedId), to = ids.indexOf(targetId);
  const out = ids.slice();
  out.splice(from, 1);
  out.splice(from < to ? out.indexOf(targetId) + 1 : out.indexOf(targetId), 0, draggedId);
  return out;
}

// Pointer-based reorder (mouse + touch, no HTML5 drag API): grab the handle,
// carry a compact ghost, an accent bar shows the insertion point, drop commits.
// Use measureSelector for tall cards so the drop target follows the header.
function enablePointerReorder({ container, itemSelector, handleSelector, ghostSelector, measureSelector, getId, onCommit, mode = 'list' }) {
  container.querySelectorAll(handleSelector).forEach(handle => {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const origin = handle.closest(itemSelector);
      if (!origin) return;
      e.preventDefault();
      handle.setPointerCapture?.(e.pointerId);
      const startX = e.clientX, startY = e.clientY;
      const pointerId = e.pointerId;
      let dragging = false, ghost = null, bar = null, insertAt = -1;
      const items = () => [...container.querySelectorAll(itemSelector)];

      const lift = () => {
        dragging = true;
        document.body.classList.add('is-dragging');
        origin.classList.add('drag-origin');
        const src = ghostSelector ? (origin.querySelector(ghostSelector) || origin) : origin;
        const r = src.getBoundingClientRect();
        ghost = src.cloneNode(true);
        ghost.classList.add('drag-ghost');
        ghost.style.width = Math.min(r.width, 420) + 'px';
        document.body.appendChild(ghost);
        bar = document.createElement('div');
        bar.className = mode === 'grid' ? 'drop-bar drop-bar-v' : 'drop-bar';
        document.body.appendChild(bar);
      };

      const placeBar = () => {
        const others = items().filter(el => el !== origin);
        if (!others.length) { insertAt = 0; bar.style.opacity = '0'; return; }
        let target = null, before = true;
        const measureRect = el => (measureSelector ? (el.querySelector(measureSelector) || el) : el).getBoundingClientRect();
        if (mode === 'grid') {
          insertAt = others.length; target = others[others.length - 1]; before = false;
          for (let i = 0; i < others.length; i++) {
            const r = measureRect(others[i]);
            if (curY < r.top - 4 || (curY <= r.bottom && curX < r.left + r.width / 2)) {
              insertAt = i; target = others[i]; before = true; break;
            }
          }
        } else {
          insertAt = others.length; target = others[others.length - 1]; before = false;
          for (let i = 0; i < others.length; i++) {
            const r = measureRect(others[i]);
            if (curY < r.top + r.height / 2) { insertAt = i; target = others[i]; before = true; break; }
          }
        }
        const r = target.getBoundingClientRect();
        const measured = measureRect(target);
        bar.style.opacity = '1';
        if (mode === 'grid') {
          bar.style.left = (before ? measured.left - 6 : measured.right + 3) + 'px';
          bar.style.top = measured.top + 'px';
          bar.style.height = measured.height + 'px';
        } else {
          bar.style.left = r.left + 'px';
          bar.style.width = r.width + 'px';
          bar.style.top = (before ? measured.top - 7 : measured.bottom + 4) + 'px';
        }
      };

      let curX = startX, curY = startY;
      const move = ev => {
        curX = ev.clientX; curY = ev.clientY;
        if (!dragging) {
          if (Math.hypot(curX - startX, curY - startY) < 5) return;
          lift();
        }
        ghost.style.left = (curX + 12) + 'px';
        ghost.style.top = (curY + 10) + 'px';
        // keep the list moving when dragging near the viewport edges
        if (curY < 90) window.scrollBy(0, -16);
        else if (innerHeight - curY < 90) window.scrollBy(0, 16);
        placeBar();
      };
      const finish = commit => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', cancel);
        try { handle.releasePointerCapture?.(pointerId); } catch (e) {}
        ghost?.remove(); bar?.remove();
        origin.classList.remove('drag-origin');
        document.body.classList.remove('is-dragging');
        if (dragging) suppressDragClickUntil = Date.now() + 500;
        if (!dragging || !commit || insertAt < 0) return;
        const ids = items().filter(el => el !== origin).map(getId);
        ids.splice(insertAt, 0, getId(origin));
        if (ids.join() !== items().map(getId).join()) onCommit(ids);
      };
      const up = ev => { ev.preventDefault(); ev.stopPropagation(); finish(true); };
      const cancel = ev => { ev.preventDefault(); ev.stopPropagation(); finish(false); };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up, { once: true });
      document.addEventListener('pointercancel', cancel, { once: true });
    });
  });
}
let map = null;
let mapLayer = null;
let didInitialFit = false; // route-wide fitBounds only on first render
const nearbyMarkers = new Map(); // "<lodgingId>|<placeIdx>" → Leaflet marker
const lodgeMarkers = new Map(); // "<lodgingId>" → Leaflet marker (option pins)

const $ = (sel, el = document) => el.querySelector(sel);

const STATUS_CYCLE = { idea: 'shortlist', shortlist: 'booked', booked: 'idea' };
const DAY_STATUSES = ['work', 'afk', 'weekend'];

async function api(method, path, body) {
  // location.origin excludes user:pass credentials, which fetch() rejects in relative URLs
  const url = new URL(`api/${path}`, location.origin + location.pathname);
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { const error = await res.json().catch(() => ({})); throw new Error(error.error || `Request failed (${res.status})`); }
  return res.json();
}

function fmtDate(iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  if (!iso) return '—';
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
}

function nightsOf(stop) {
  const checkin = stopDateValue(stop, 'checkin');
  const checkout = stopDateValue(stop, 'checkout');
  if (!checkin || !checkout) return 0;
  return Math.round((new Date(checkout) - new Date(checkin)) / 86400000);
}

function safeLink(s) { try { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : '#'; } catch { return '#'; } }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// cheap / mid / expensive vs the trip budget band — shared by cards and map pins
function priceTierOf(pricePerNight) {
  if (pricePerNight == null || pricePerNight === '') return '';
  const p = Number(pricePerNight);
  return p <= data.config.budgetMin ? 'cheap' : p <= data.config.budgetMax ? 'mid' : 'expensive';
}
function hasPriceValue(v) {
  return v !== null && v !== undefined && v !== '';
}
function lodgingTotalPrice(item, nights) {
  if (hasPriceValue(item.totalPrice)) return Math.round(Number(item.totalPrice));
  if (hasPriceValue(item.pricePerNight) && nights > 0) return Math.round(Number(item.pricePerNight) * nights);
  return null;
}
function lodgingNightlyPrice(item, nights) {
  if (hasPriceValue(item.pricePerNight)) return Math.round(Number(item.pricePerNight));
  if (hasPriceValue(item.totalPrice) && nights > 0) return Math.round(Number(item.totalPrice) / nights);
  return null;
}
function lodgingPriceHtml(item, nights, { checking = false } = {}) {
  const total = lodgingTotalPrice(item, nights);
  const nightly = lodgingNightlyPrice(item, nights);
  if (nightly !== null || total !== null) {
    const tier = priceTierOf(nightly);
    const nightPart = nightly !== null ? `€${nightly}/n` : '';
    const totalPart = total !== null ? `€${total} total` : '';
    return `<span class="price ${tier}" title="green = under €${data.config.budgetMin}, red = over €${data.config.budgetMax}">${[nightPart, totalPart].filter(Boolean).join(' · ')}</span>`;
  }
  if (checking) return '<span class="muted checking-text">checking price…</span>';
  return '<span class="muted price-unavailable" title="Enter the full stay price manually.">price not entered</span>';
}

// ---------- Pricing ----------

// The live itinerary: each slot's active candidate, in slot order. Parked
// candidates stay in data.stops but are not part of the route/budget/days.
function itinStops() {
  if (!data || !Array.isArray(data.slots)) return data?.stops || [];
  return data.slots.map(sl => data.stops.find(s => s.id === sl.activeStopId)).filter(Boolean);
}
function slotFor(stopId) {
  return (data.slots || []).find(sl => sl.candidateIds.includes(stopId)) || null;
}

function selectedLodging(stop) {
  return data.lodging.find(l => l.stopId === stop.id && l.status === 'booked') || null;
}

// Options for a stop, best first: explicit rank, then score, then price.
function stopLodgingSorted(stopId) {
  const stop = data.stops.find(s => s.id === stopId);
  const nights = stop ? nightsOf(stop) : 0;
  return data.lodging
    .filter(l => l.stopId === stopId)
    .sort((a, b) =>
      (a.rank ?? 999) - (b.rank ?? 999) ||
      (b.score ?? 0) - (a.score ?? 0) ||
      (lodgingNightlyPrice(a, nights) ?? 9999) - (lodgingNightlyPrice(b, nights) ?? 9999));
}

// Returns { cost, sel } — cost is null when nothing is selected yet.
// A selected option with price 0 (e.g. family house) counts as €0, not unpriced.
function stopCost(stop) {
  const sel = selectedLodging(stop);
  if (sel) {
    return { cost: lodgingTotalPrice(sel, nightsOf(stop)), sel };
  }
  if (stop.lodgingNote) return { cost: 0, sel: null }; // e.g. grandma's house
  return { cost: null, sel: null };
}

function lodgingTotal() {
  let total = 0, unpriced = 0;
  itinStops().forEach(stop => {
    if (nightsOf(stop) === 0) return; // same-day transits need no lodging
    const { cost } = stopCost(stop);
    if (cost === null) unpriced++;
    else total += cost;
  });
  return { total, unpriced };
}

function haversineKm(a, b) {
  const rad = x => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

// Exact position for a stop: the selected lodging's geocoded building if we
// have it, otherwise the stop's town coordinates.
function stopPos(stop) {
  const sel = selectedLodging(stop);
  if (sel && sel.lat && sel.lng) return { lat: sel.lat, lng: sel.lng, exact: true };
  if (stop.lat && stop.lng) return { lat: stop.lat, lng: stop.lng, exact: false };
  return null;
}

// Transport modes for a leg. `gmode` maps to Google Maps travelmode where one exists.
const TRANSPORT_MODES = {
  drive:    { icon: '🚗', label: 'Drive',    gmode: 'driving',   road: true },
  fly:      { icon: '✈️', label: 'Fly',      gmode: null,        road: false },
  train:    { icon: '🚆', label: 'Train',    gmode: 'transit',   road: false },
  bus:      { icon: '🚌', label: 'Bus',      gmode: 'transit',   road: false },
  transfer: { icon: '🚐', label: 'Transfer', gmode: 'driving',   road: true },
  ferry:    { icon: '⛴️', label: 'Ferry',    gmode: null,        road: false },
};
const MODE_KEYS = Object.keys(TRANSPORT_MODES);

// How you arrive at stop index i (i === stops.length → the leg home).
// Stored on the stop as `arriveBy`; the return leg lives on config.returnBy.
// Return leg, if unset, mirrors the outbound leg (fly out → fly back).
function legMode(i) {
  if (i >= itinStops().length) {
    if (TRANSPORT_MODES[data.config.returnBy]) return data.config.returnBy;
    const outbound = itinStops()[0]?.arriveBy;
    return TRANSPORT_MODES[outbound] ? outbound : 'drive';
  }
  const key = itinStops()[i]?.arriveBy;
  return TRANSPORT_MODES[key] ? key : 'drive';
}
function legManualCost(i) {
  const v = i >= itinStops().length ? data.config.returnCost : itinStops()[i]?.legCost;
  return v === '' || v == null ? null : Number(v);
}

function legEndpoints(i) {
  const home = data.config.home;
  const origin = i === 0 ? home : stopPos(itinStops()[i - 1]);
  const dest = i >= itinStops().length ? home : stopPos(itinStops()[i]);
  return { origin, dest };
}

// Google Maps directions URL for the leg arriving at stop index i.
function legUrl(i) {
  const { origin, dest } = legEndpoints(i);
  if (!origin?.lat || !dest?.lat) return null;
  const m = TRANSPORT_MODES[legMode(i)];
  const tm = m.gmode || 'driving';
  return `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${dest.lat},${dest.lng}&travelmode=${tm}`;
}

// All legs as {i, mode, road, from, to}. Leg i arrives at stop i (or home when i == stops.length).
function allLegs() {
  const legs = [];
  const n = itinStops().length;
  for (let i = 0; i <= n; i++) {
    if (i === n && !data.config.home?.lat) break; // no return leg without a home base
    const { origin, dest } = legEndpoints(i);
    if (!origin?.lat || !dest?.lat) continue;
    const mode = legMode(i);
    legs.push({ i, mode, road: TRANSPORT_MODES[mode].road, from: origin, to: dest });
  }
  return legs;
}

// Contiguous runs of road legs become a single OSRM road-route request; non-road
// legs render as straight dashed lines.
let routeCache = new Map(); // key → {latlngs, km, pending}

function runKey(run) {
  return run.map(p => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(';');
}

function roadRuns() {
  const runs = [];
  let cur = null;
  allLegs().forEach(leg => {
    if (leg.road) {
      if (!cur) cur = [leg.from];
      cur.push(leg.to);
    } else if (cur) { runs.push(cur); cur = null; }
  });
  if (cur) runs.push(cur);
  return runs;
}

async function fetchRoute(run) {
  const key = runKey(run);
  const coords = run.map(p => `${p.lng},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  if (!data.config.capabilities?.network) throw new Error('Online routing is disabled');
  const res = await fetch(url);
  const json = await res.json();
  if (json.code !== 'Ok' || !json.routes?.[0]) throw new Error('routing failed');
  const route = json.routes[0];
  routeCache.set(key, {
    latlngs: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    km: Math.round(route.distance / 1000),
    pending: false,
  });
}

// Total road km across all driving legs (real from OSRM cache where available).
function roadKm() {
  let km = 0, allReal = true;
  roadRuns().forEach(run => {
    const cached = routeCache.get(runKey(run));
    if (cached?.km != null) { km += cached.km; return; }
    allReal = false;
    let straight = 0;
    for (let i = 1; i < run.length; i++) straight += haversineKm(run[i - 1], run[i]);
    km += straight * (data.config.car?.roadFactor || 1.25);
  });
  return { km: Math.round(km), real: allReal };
}

function fuelEstimate() {
  const car = data.config.car;
  if (!car) return null;
  if (!roadRuns().length) return { km: 0, real: true, cost: 0, car };
  const { km, real } = roadKm();
  const liters = (km / 100) * car.lPer100;
  return { km, real, cost: Math.round(liters * car.fuelPrice), car };
}

// Sum of manual per-leg costs (flights, train tickets, transfers…)
function legCostsTotal() {
  let total = 0;
  for (let i = 0; i <= itinStops().length; i++) {
    const c = legManualCost(i);
    if (c != null) total += c;
  }
  return total;
}

function extraCostsTotal() {
  return (data.costs || []).reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
}

function grandTotal() {
  const lodging = lodgingTotal();
  const fuel = fuelEstimate();
  const legs = legCostsTotal();
  return {
    lodging,
    fuel,
    legs,
    extras: extraCostsTotal(),
    total: lodging.total + (fuel ? fuel.cost : 0) + legs + extraCostsTotal(),
  };
}

// ---------- Render ----------

function isPackage() {
  return data.config.type === 'package';
}

function render() {
  $('#trip-name').textContent = data.config.tripName;
  document.querySelector('.edition-status').textContent = `${data.config.demo ? 'Synthetic examples · ' : ''}${data.config.capabilities?.network ? 'Online maps enabled' : 'Offline schematic map'} · manual prices, no live checks`;
  renderDateApplyBar();

  // floating hint while a card is picked up for reordering
  let hint = $('#move-hint');
  if (moveState) {
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'move-hint';
      document.body.appendChild(hint);
    }
    hint.textContent = 'Tap another card to move it there — tap ⋮⋮ again to cancel';
  } else if (hint) {
    hint.remove();
  }
  $('#itinerary-section').hidden = isPackage();
  $('#offers-section').hidden = !isPackage();

  if (isPackage()) {
    const party = data.config.party || {};
    const kids = (party.kidsAges || []).length;
    const sel = selectedOffer();
    $('#trip-meta').textContent = `${party.adults || 2} adults${kids ? ` + ${kids} kid${kids > 1 ? 's' : ''} (${(party.kidsAges || []).join(', ')}y)` : ''} · ${(data.offers || []).length} offers · budget €${data.config.budgetTotal || '—'} total`;
    const total = packageGrandTotal();
    $('#trip-total').textContent = sel
      ? `Trip total (door-to-door): €${total}`
      : `No offer selected yet${total ? ` — extras €${total}` : ''}`;
    renderMap();
    renderOffers();
    renderPackageBudget();
    return;
  }

  const totalNights = itinStops().reduce((n, s) => n + nightsOf(s), 0);
  const afk = data.days.filter(d => d.workStatus === 'afk').length;
  $('#trip-meta').textContent = `${totalNights} nights · ${afk} days off · budget €${data.config.budgetMin}–${data.config.budgetMax}/night`;
  const g = grandTotal();
  $('#trip-total').textContent = g.lodging.unpriced
    ? `Trip total so far: €${g.total} — ${g.lodging.unpriced} stop${g.lodging.unpriced === 1 ? '' : 's'} without lodging selected`
    : `Trip total: €${g.total}`;
  renderMap();
  renderItinerary();
  renderBudget();
}

function renderBudget() {
  const el = $('#budget');
  const g = grandTotal();
  const fuel = g.fuel;
  const car = data.config.car || {};
  const rows = [];

  rows.push(`
    <div class="budget-row computed">
      <span class="budget-label">Lodging <span class="muted">(selected options${g.lodging.unpriced ? `, ${g.lodging.unpriced} stop${g.lodging.unpriced === 1 ? '' : 's'} missing` : ''})</span></span>
      <span class="budget-amount">€${g.lodging.total}</span>
    </div>`);

  if (fuel && fuel.km > 0) {
    rows.push(`
      <div class="budget-row computed">
        <span class="budget-label">Fuel <span class="muted">(${esc(car.name)} · ${fuel.real ? '' : 'est. '}~${fuel.km} km driving ×
          <input class="cfg-lper100" type="number" step="0.1" value="${car.lPer100}"> L/100km ×
          €<input class="cfg-fuelprice" type="number" step="0.01" value="${car.fuelPrice}">/L)</span></span>
        <span class="budget-amount">€${fuel.cost}</span>
      </div>`);
  }

  if (g.legs > 0) {
    const labels = [];
    for (let i = 0; i <= itinStops().length; i++) {
      const c = legManualCost(i);
      if (c != null) {
        const to = i >= itinStops().length ? (data.config.home?.name || 'home') : itinStops()[i].place;
        labels.push(`${TRANSPORT_MODES[legMode(i)].icon} ${esc(to)} €${c}`);
      }
    }
    rows.push(`
      <div class="budget-row computed">
        <span class="budget-label">Transport <span class="muted">(${labels.join(' · ')})</span></span>
        <span class="budget-amount">€${g.legs}</span>
      </div>`);
  }

  (data.costs || []).forEach(c => {
    rows.push(`
      <div class="budget-row" data-id="${c.id}">
        <span class="budget-label">
          <input class="cost-label" value="${esc(c.label)}" placeholder="Label">
          ${c.notes ? `<span class="muted cost-notes">${esc(c.notes)}</span>` : ''}
        </span>
        <span class="budget-amount">€<input class="cost-amount" type="number" value="${c.amount}"></span>
        <button class="btn-x cost-delete" title="Delete">×</button>
      </div>`);
  });

  rows.push(`
    <div class="budget-row total-row">
      <span class="budget-label">Total</span>
      <span class="budget-amount">€${g.total}</span>
    </div>`);

  el.innerHTML = `<div class="budget-card">${rows.join('')}</div><button id="add-cost" class="btn-add">+ Add misc cost</button>`;

  const lper = $('.cfg-lper100', el);
  if (lper) lper.addEventListener('change', e => refresh(api('PUT', 'config', { car: { lPer100: Number(e.target.value) || 7.5 } })));
  const fp = $('.cfg-fuelprice', el);
  if (fp) fp.addEventListener('change', e => refresh(api('PUT', 'config', { car: { fuelPrice: Number(e.target.value) || 1.7 } })));
  el.querySelectorAll('.budget-row[data-id]').forEach(row => {
    const id = row.dataset.id;
    $('.cost-label', row).addEventListener('change', e => refresh(api('PUT', `costs/${id}`, { label: e.target.value })));
    $('.cost-amount', row).addEventListener('change', e => refresh(api('PUT', `costs/${id}`, { amount: Number(e.target.value) || 0 })));
    $('.cost-delete', row).addEventListener('click', () => {
      const cost = data.costs.find(c => c.id === id);
      if (confirm(`Delete cost "${cost.label}"?`)) refresh(api('DELETE', `costs/${id}`));
    });
  });

  $('#add-cost', el).addEventListener('click', () => refresh(api('POST', 'costs', { label: 'Misc cost', amount: 0 })));
}

function renderMap() {
  ensureMap();
  if (isPackage()) return renderPackageMap();

  const points = [];
  const home = data.config.home;
  if (home && home.lat) points.push({ ...home, label: '🏠', title: home.name });
  itinStops().forEach((s, i) => {
    const p = stopPos(s);
    if (!p) return;
    const sel = selectedLodging(s);
    points.push({
      lat: p.lat, lng: p.lng, label: String(i + 1), stopId: s.id,
      title: p.exact && sel ? `${s.place} — ${sel.name}` : s.place,
    });
  });
  if (home && home.lat) points.push({ ...home, label: '🏠', title: home.name, isReturn: true });

  finishRenderMap(points);
}

function ensureMap() {
  if (!map) {
    // Leaflet's native wheel/pinch handling is the smoothest on trackpads;
    // the map is a sticky side panel, so it doesn't steal page scrolling.
    map = L.map('map', {
      zoomSnap: 0,
      // default is 60px of scroll per zoom level with 40ms debounce — feels
      // sluggish on trackpads; these make wheel/pinch zoom ~3x more responsive
      wheelPxPerZoomLevel: 20,
      wheelDebounceTime: 10,
    });
    if (data.config.capabilities?.network) {
      const osm = () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · OSRM routes',
      }).addTo(map);
      const fallback = osm();
      if (data.config.mapsKey && L.gridLayer.googleMutant) {
        let googleLayer;
        const useFallback = () => {
          if (googleLayer) map.removeLayer(googleLayer);
          if (!map.hasLayer(fallback)) fallback.addTo(map);
          document.querySelector('.edition-status').textContent = 'Google Maps unavailable · OpenStreetMap fallback · manual prices, no live checks';
        };
        window.gm_authFailure = useFallback;
        window.__tripGoogleReady = () => {
          googleLayer = L.gridLayer.googleMutant({ type: 'roadmap' });
          googleLayer.once('load', () => map.removeLayer(fallback));
          googleLayer.addTo(map);
        };
        const script = document.createElement('script');
        script.src = 'https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({ key: data.config.mapsKey, loading: 'async', callback: '__tripGoogleReady' });
        script.onerror = useFallback;
        document.head.appendChild(script);
      }
    } else {
      map.attributionControl.addAttribution('Offline schematic · estimated distances');
    }
    mapLayer = L.layerGroup().addTo(map);
    // "open in Google Maps" control — official Google Maps URLs API format
    const gmapsControl = L.control({ position: 'topright' });
    gmapsControl.onAdd = () => {
      const btn = L.DomUtil.create('button', 'map-gmaps-link');
      btn.type = 'button';
      btn.textContent = 'Open in Google Maps ↗';
      L.DomEvent.disableClickPropagation(btn);
      btn.addEventListener('click', () => {
        const c = map.getCenter();
        window.open(`https://www.google.com/maps/@?api=1&map_action=map&center=${c.lat},${c.lng}&zoom=${Math.round(map.getZoom())}`, '_blank', 'noopener');
      });
      return btn;
    };
    gmapsControl.addTo(map);
    map.setView([20, 0], 2);
    const message = document.createElement('div'); message.className = 'map-empty-message'; message.textContent = 'No mapped locations yet. Enter coordinates to plot places; the planner works without them.'; map.getContainer().appendChild(message);
  }
}

function finishRenderMap(points) {
  mapLayer.clearLayers();
  map.getContainer().classList.toggle('map-empty-view', points.length === 0);
  map.invalidateSize();
  if (points.length === 0) return;

  drawLegs();

  points.forEach(p => {
    if (p.isReturn) return;
    const marker = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: 'map-pin', html: `<span>${p.label}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
      title: p.title,
    }).addTo(mapLayer);
    if (p.stopId) {
      const stop = itinStops().find(s => s.id === p.stopId);
      const i = itinStops().indexOf(stop);
      marker.bindPopup(stopPopup(stop, i), { maxWidth: 280 });
    } else {
      marker.bindTooltip(p.title, { direction: 'top', offset: [0, -12] });
    }
  });
  // lodging options as price pills (the selected/booked one is the numbered pin).
  // Click a pill → popup with details + a Select button. Compare €/location at a glance.
  lodgeMarkers.clear();
  const sameSpot = new Map(); // dedupe identical coords so overlapping pills stay clickable
  const liveStopIds = new Set(itinStops().map(s => s.id)); // parked candidates' hotels stay off the map
  data.lodging.forEach(l => {
    if (!liveStopIds.has(l.stopId)) return;
    if (!l.lat || !l.lng || l.status === 'booked') return;
    if (l.availability === 'unavailable') return;
    const stop = data.stops.find(s => s.id === l.stopId);
    const nights = stop ? nightsOf(stop) : 0;
    const nightly = lodgingNightlyPrice(l, nights);
    const total = lodgingTotalPrice(l, nights);
    const tier = priceTierOf(nightly);
    const label = nightly !== null ? `€${nightly}` : (l.score ? `★${l.score}` : '·');
    const cls = ['lodge-pin', tier, l.favorite ? 'fav' : ''].filter(Boolean).join(' ');
    // nudge exact-duplicate coordinates apart by a tiny deterministic delta
    const k = `${l.lat.toFixed(5)},${l.lng.toFixed(5)}`;
    const n = sameSpot.get(k) || 0; sameSpot.set(k, n + 1);
    const off = n * 0.00018;
    const m = L.marker([l.lat + off, l.lng + off], {
      icon: L.divIcon({ className: '', html: `<span class="${cls}">${esc(label)}</span>`, iconSize: [0, 0], iconAnchor: [0, 14] }),
    }).addTo(mapLayer);
    m.bindPopup(lodgePopup(l), { maxWidth: 250 });
    m.bindTooltip(`${l.name}${nightly !== null ? ` · €${nightly}/n` : ''}${total !== null ? ` · €${total} total` : ''}${l.score ? ` · ★${l.score}` : ''}`, { direction: 'top', offset: [0, -14] });
    m.on('popupopen', () => wireLodgePopup(m, l));
    lodgeMarkers.set(l.id, m);
  });

  // nearby places of cards whose panel is open
  nearbyMarkers.clear();
  expandedNearby.forEach(id => {
    const l = data.lodging.find(x => x.id === id);
    if (!l) return;
    const stop = data.stops.find(s => s.id === l.stopId);
    const city = (stop?.place || '').split('(')[0].split('/')[0].trim();
    (l.nearby?.places || []).forEach((p, i) => {
      if (!p.lat || !p.lng) return;
      const m = L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: '', html: `<span class="poi-pin ${p.kind}">${p.kind === 'food' ? '🍽' : '🛒'}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
      }).addTo(mapLayer);
      const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.name}, ${city}`)}`;
      m.bindPopup(basicPlacePopup(p, l, mapsUrl), { maxWidth: 290 });
      m.bindTooltip(`${p.name}${p.rating ? ` ★${p.rating}` : ''}`, { direction: 'top', offset: [0, -12] });
      // swap in rich Google details the first time the popup opens
      if (p.placeId) m.on('popupopen', () => enrichPlacePopup(m, p, l, mapsUrl));
      nearbyMarkers.set(`${l.id}|${i}`, m);
    });
  });

  if (!didInitialFit) {
    if (points.length === 1) map.setView([points[0].lat, points[0].lng], 10);
    else map.fitBounds(points.map(p => [p.lat, p.lng]), { padding: [30, 30] });
    didInitialFit = true;
  }
}

// Draw each leg in its transport mode: road legs follow the real route (OSRM,
// straight dashed while loading); fly/train/ferry legs are a dashed great-line
// with a mode icon at the midpoint.
function drawLegs() {
  // road legs: fetch contiguous runs, draw solid (or dashed placeholder)
  roadRuns().forEach(run => {
    const key = runKey(run);
    const cached = routeCache.get(key);
    if (cached?.latlngs) {
      L.polyline(cached.latlngs, { color: '#2563eb', weight: 3.5, opacity: 0.8 }).addTo(mapLayer);
    } else {
      L.polyline(run.map(p => [p.lat, p.lng]), { color: '#2563eb', weight: 3, opacity: 0.45, dashArray: '6 8' }).addTo(mapLayer);
      if (data.config.capabilities?.network && !cached?.pending) {
        routeCache.set(key, { pending: true });
        fetchRoute(run).then(render).catch(() => routeCache.delete(key));
      }
    }
  });
  // non-road legs: dashed straight line + mode icon at midpoint
  allLegs().forEach(leg => {
    if (leg.road) return;
    const a = [leg.from.lat, leg.from.lng], b = [leg.to.lat, leg.to.lng];
    L.polyline([a, b], { color: '#7c8aa3', weight: 2.5, opacity: 0.75, dashArray: '3 7' }).addTo(mapLayer);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    L.marker(mid, {
      icon: L.divIcon({ className: '', html: `<span class="leg-mode">${TRANSPORT_MODES[leg.mode].icon}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
      interactive: false,
    }).addTo(mapLayer);
  });
}

// Transient blue pin marking a lodging's exact building (shown on address click)
let lodgePin = null;
function showLodgePin(item) {
  if (lodgePin) { map.removeLayer(lodgePin); lodgePin = null; }
  const stop = data.stops.find(s => s.id === item.stopId);
  const nightly = lodgingNightlyPrice(item, stop ? nightsOf(stop) : 0);
  lodgePin = L.marker([item.lat, item.lng], {
    icon: L.divIcon({ className: '', html: `<span class="poi-pin lodge">🏨</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
    zIndexOffset: 900,
  }).addTo(map);
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.address || item.name)}`;
  lodgePin.bindPopup(`
    <div class="map-popup">
      <div class="popup-title">${esc(item.name)}</div>
      ${item.address ? `<div class="popup-dates">📍 ${esc(item.address)}</div>` : ''}
      ${item.score ? `<div class="popup-dates">★${item.score}${nightly !== null ? ` · €${nightly}/n` : ''}</div>` : ''}
      <a class="popup-nav" href="${mapsUrl}" target="_blank" rel="noopener">Open in Google Maps ↗</a>
    </div>`, { maxWidth: 270 });
  lodgePin.on('popupclose', () => { if (lodgePin) { map.removeLayer(lodgePin); lodgePin = null; } });
  map.flyTo([item.lat, item.lng], 16);
  setTimeout(() => lodgePin && lodgePin.openPopup(), 450);
}

// Popup for a lodging-option pin: details + a Select/Unselect button.
function lodgePopup(l) {
  const stop = data.stops.find(s => s.id === l.stopId);
  const nights = stop ? nightsOf(stop) : 0;
  const total = lodgingTotalPrice(l, nights);
  const nightly = lodgingNightlyPrice(l, nights);
  const tier = priceTierOf(nightly);
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(l.address || l.name)}`;
  const booked = l.status === 'booked';
  const canSelect = l.availability !== 'unavailable';
  return `
    <div class="map-popup lodge">
      <div class="popup-title">${l.favorite ? '★ ' : ''}${esc(l.name)}</div>
      <div class="popup-dates">
        ${l.score ? `★${l.score}` : ''}
        ${nightly !== null || total !== null ? `${l.score ? ' · ' : ''}<b class="price ${tier}">${[nightly !== null ? `€${nightly}/n` : '', total !== null ? `€${total} total` : ''].filter(Boolean).join(' · ')}</b>` : ''}
      </div>
      ${l.area || l.address ? `<div class="popup-dates">📍 ${esc(l.area || l.address)}</div>` : ''}
      <a class="popup-nav" href="${esc(mapsUrl)}" target="_blank" rel="noopener">Open in Google Maps ↗</a>
      ${canSelect ? `<button class="popup-select ${booked ? 'is-booked' : ''}" data-id="${esc(l.id)}">${booked ? 'Selected ✓ — unselect' : 'Select this stay'}</button>` : '<div class="popup-dates muted">Marked unavailable</div>'}
    </div>`;
}

// Wire the Select button inside an open lodging-pin popup.
function wireLodgePopup(marker, l) {
  const el = marker.getPopup()?.getElement();
  if (!el) return;
  const btn = el.querySelector('.popup-select');
  if (btn) btn.addEventListener('click', () => {
    const cur = data.lodging.find(x => x.id === l.id);
    if (cur?.availability === 'unavailable' && cur.status !== 'booked') return;
    marker.closePopup();
    updateLodging(l.id, { status: cur?.status === 'booked' ? 'shortlist' : 'booked' });
  });
}

function basicPlacePopup(p, lodging, mapsUrl) {
  return `
    <div class="map-popup">
      <div class="popup-title">${esc(p.name)}</div>
      <div class="popup-dates">${p.rating ? `★${p.rating}${p.ratings ? ` (${p.ratings})` : ''} · ` : ''}${p.dist}m from ${esc(lodging.name)}${p.placeId ? ' · loading details…' : ''}</div>
      <a class="popup-nav" href="${mapsUrl}" target="_blank" rel="noopener">Open in Google Maps ↗</a>
    </div>`;
}

const richPopupCache = new Map();
async function enrichPlacePopup(marker, p, lodging, mapsUrl) {
  try {
    let d = richPopupCache.get(p.placeId);
    if (!d) {
      d = await api('GET', `place/${p.placeId}`);
      richPopupCache.set(p.placeId, d);
    }
    const gmaps = d.mapsUrl || mapsUrl;
    marker.setPopupContent(`
      <div class="map-popup rich">
        ${d.photo ? `<img class="popup-photo" src="${esc(d.photo)}" alt="">` : ''}
        <div class="popup-title">${esc(d.name)}</div>
        <div class="popup-dates">
          ${d.rating ? `★${d.rating}${d.ratings ? ` (${d.ratings})` : ''}` : ''}
          ${d.priceLevel != null ? ` · ${'€'.repeat(Math.max(1, d.priceLevel))}` : ''}
          ${d.openNow != null ? ` · <b class="${d.openNow ? 'open-now' : 'closed-now'}">${d.openNow ? 'Open now' : 'Closed'}</b>` : ''}
          · ${p.dist}m
        </div>
        ${d.summary ? `<p class="popup-summary">${esc(d.summary)}</p>` : ''}
        ${d.review ? `<p class="popup-review">“${esc(d.review.text)}” <span class="muted">— ${esc(d.review.author)} (★${d.review.rating})</span></p>` : ''}
        <div class="popup-links">
          <a class="popup-nav" href="${esc(gmaps)}" target="_blank" rel="noopener">Google Maps ↗</a>
          ${d.website ? `<a class="popup-nav" href="${esc(safeLink(d.website))}" target="_blank" rel="noopener">Website ↗</a>` : ''}
        </div>
      </div>`);
  } catch (e) { /* keep the basic popup */ }
}

function stopPopup(stop, i) {
  const { cost, sel } = stopCost(stop);
  const days = data.days.filter(d => d.stopId === stop.id);
  const checkin = stopDateValue(stop, 'checkin');
  const checkout = stopDateValue(stop, 'checkout');
  const lodgingLine = sel
    ? `<span class="booked-tag">✓ ${esc(sel.name)}${cost !== null ? ` · €${cost}` : ''}</span>`
    : stop.lodgingNote
      ? esc(stop.lodgingNote)
      : '<a href="#lodging-' + stop.id + '">no lodging selected — choose ↓</a>';
  const dayLines = days.map(d =>
    `<div class="popup-day"><b>${fmtDate(d.date, { weekday: 'short', day: 'numeric' })}</b> ${esc(d.plan || '—')}</div>`
  ).join('');
  const nav = legUrl(i);
  return `
    <div class="map-popup">
      <div class="popup-title">${i + 1}. ${esc(stop.place)}</div>
      <div class="popup-dates">${fmtDate(checkin, { day: 'numeric', month: 'short' })} → ${fmtDate(checkout, { day: 'numeric', month: 'short' })} · ${nightsOf(stop)}N</div>
      <div class="popup-lodging">${lodgingLine}</div>
      ${dayLines}
      ${nav ? `<a class="popup-nav" href="${nav}" target="_blank" rel="noopener">🧭 Navigate this leg (Google Maps)</a>` : ''}
    </div>`;
}

function dayRow(day) {
  return `
    <tr class="status-${day.workStatus}" data-date="${day.date}">
      <td class="day-date">${fmtDate(day.date)}</td>
      <td><div class="day-plan-row"><input class="day-plan" value="${esc(day.plan)}" placeholder="Day plan"><button class="day-save btn-sm" type="button" aria-label="Save plan for ${day.date}">Save</button></div></td>
      <td>
        <select class="day-status">
          ${DAY_STATUSES.map(s => `<option value="${s}" ${s === day.workStatus ? 'selected' : ''}>${s.toUpperCase()}</option>`).join('')}
        </select>
      </td>
    </tr>`;
}

// Transport selector + per-leg cost + nav link, shown above each stop block.
function legBar(i, fromLabel) {
  const mode = legMode(i);
  const m = TRANSPORT_MODES[mode];
  const cost = legManualCost(i);
  const url = legUrl(i);
  // for a road leg with no manual cost, hint at the shared fuel total instead
  const costField = `€<input class="leg-cost" type="number" data-i="${i}" value="${cost ?? ''}" placeholder="${m.road ? 'fuel' : '0'}" title="${m.road ? 'Leave blank to use the shared fuel estimate, or enter tolls/tickets for this leg' : 'Cost of this leg (flight, ticket, transfer…)'}">`;
  return `
    <div class="leg leg-bar" data-i="${i}">
      <span class="leg-arrow">↳</span>
      <span class="from">${fromLabel}</span>
      <select class="leg-mode-select" data-i="${i}" title="How you travel this leg">
        ${MODE_KEYS.map(k => `<option value="${k}" ${k === mode ? 'selected' : ''}>${TRANSPORT_MODES[k].icon} ${TRANSPORT_MODES[k].label}</option>`).join('')}
      </select>
      ${costField}
      ${url ? `<a class="choose-link nav-link" href="${url}" target="_blank" rel="noopener" title="Directions for this leg — open in Google Maps">🧭</a>` : ''}
    </div>`;
}

// One-line summary of a (parked) candidate stop for its switch row.
function candidateSummary(cand) {
  const items = stopLodgingSorted(cand.id);
  const picked = items.find(l => l.status === 'booked');
  const best = picked || items.find(l => l.score != null) || items[0] || null;
  const nights = nightsOf(cand);
  const price = picked ? lodgingTotalPrice(picked, nights) : null;
  let sub;
  if (picked) sub = `${esc(picked.name || 'selected')} selected${items.length > 1 ? ` · ${items.length} hotels` : ''}`;
  else if (items.length) sub = `${items.length} hotel${items.length === 1 ? '' : 's'} · none selected`;
  else sub = 'no lodging yet';
  return { sub, price, score: best?.score ?? null };
}

// Save a listing link first, or open the full manual comparison form.
function newLodgingForm(stopId) {
  return `
    <div class="lodging-card editing adding" data-stop="${esc(stopId)}">
      <input class="f-url" value="" placeholder="Paste the Booking / listing URL…" autofocus>
      <p class="add-hint">Enter the property name, prices and notes manually. Online research is not included.</p>
      <div class="lodging-actions">
        <button class="btn-sm btn-primary lodging-add-url">Add</button>
        <button class="btn-sm lodging-cancel">Cancel</button>
        <a class="add-manual" data-stop="${esc(stopId)}">enter details manually</a>
      </div>
    </div>`;
}

// The lodging card grid + "add hotel" tile + inline new-option form for one stop.
function lodgingGridHtml(stop) {
  const items = stopLodgingSorted(stop.id);
  const nights = nightsOf(stop);
  const newForm = editingLodging === `new:${stop.id}`
    ? newLodgingForm(stop.id)
    : editingLodging === `newfull:${stop.id}`
      ? lodgingForm({ id: '', stopId: stop.id, name: '', url: '', totalPrice: null, pricePerNight: null, area: '', notes: '', status: 'idea' })
      : '';
  return `
    <div class="lodge-grid" id="lodging-${stop.id}" data-stop="${stop.id}">
      ${items.map(i => lodgingCard(i, nights)).join('')}
      ${newForm}
      <button class="lodge-add lodging-add" data-stop="${stop.id}"><span class="plus">＋</span> Add lodging</button>
    </div>`;
}

// Score/price color helpers for the compact alt row.
const scoreCls = s => s == null ? 'none' : (s >= 8.5 ? '' : 'mid');
const altPriceHtml = p => p == null ? '<span class="alt-price unset">—</span>' : `<span class="alt-price">€${p}</span>`;
const altScoreHtml = s => `<span class="alt-score ${scoreCls(s)}">${s == null ? '—' : s}</span>`;

function candidateLodgingDetailHtml(cand, active, open) {
  if (!open) return '';
  return `
        <div class="alt-detail">
          <div class="detail-label">${active ? 'Lodging for current choice' : 'Lodging for this alternative'}</div>
          ${cand.lodgingNote ? `<p class="note-tag">${esc(cand.lodgingNote)}</p>` : ''}
          ${lodgingGridHtml(cand)}
        </div>`;
}

// Candidate alternatives in their saved order. Clicking a non-active row swaps
// it in; order stays stable so options do not jump around.
function parkedRowsHtml(stop) {
  const slot = slotFor(stop.id);
  if (!slot) return '';
  const candidates = slot.candidateIds.map(id => data.stops.find(s => s.id === id)).filter(Boolean);
  if (candidates.length <= 1) {
    return `<button class="add-alt" data-add="${stop.id}"><span class="plus">＋</span> Add an alternative <span class="hint">— try a different place for these dates without losing this one</span></button>`;
  }
  const rows = candidates.map(cand => {
    const sum = candidateSummary(cand);
    const active = cand.id === slot.activeStopId;
    const open = variantDetailOpen(cand, active);
    return `
      <div class="alt ${active ? 'active' : ''}" data-cand-wrap="${cand.id}">
        <div class="alt-row" data-slot="${slot.id}" data-cand="${cand.id}" title="${active ? 'Current itinerary choice' : `Swap ${esc(cand.place || 'this place')} into the trip — ${esc(stop.place || 'the current place')} stays parked`}">
          <button class="btn-icon alt-toggle" data-cand="${cand.id}" aria-expanded="${open ? 'true' : 'false'}" title="${open ? 'Hide lodging' : 'Show lodging'}">${open ? '▾' : '▸'}</button>
          <button class="alt-radio" type="button" aria-label="Use ${esc(cand.place || 'this place')}" aria-pressed="${active}"></button>
          <div class="alt-main">
            <input class="alt-place-input" data-cand="${cand.id}" value="${esc(cand.place || '')}" placeholder="Name this place">
            <div class="alt-lodging">${sum.sub}</div>
          </div>
          ${altScoreHtml(sum.score)}
          ${altPriceHtml(sum.price)}
          ${active ? '<span class="active-pill">Current</span>' : `<button class="btn-x cand-del" data-slot="${slot.id}" data-cand="${cand.id}" title="Delete this alternative and its hotels">×</button>`}
        </div>
        ${candidateLodgingDetailHtml(cand, active, open)}
      </div>`;
  }).join('');
  return `
    <div class="alts-head"><span class="alts-title">Alternatives — order stays fixed</span></div>
    ${rows}
    <button class="add-alt" data-add="${stop.id}"><span class="plus">＋</span> Add an alternative <span class="hint">— try a different place for these dates without losing this one</span></button>`;
}

// Stop body: same-day transit = nothing; else lodging sits under its candidate row.
function stopBodyHtml(stop) {
  if (nightsOf(stop) === 0) return ''; // same-day / passing-through: no lodging
  const slot = slotFor(stop.id);
  const candidates = slot ? slot.candidateIds.map(id => data.stops.find(s => s.id === id)).filter(Boolean) : [];
  const hasAlternatives = candidates.length > 1;
  return `
    <div class="stop-body">
      ${!hasAlternatives && stop.lodgingNote ? `<p class="note-tag">${esc(stop.lodgingNote)}</p>` : ''}
      ${hasAlternatives ? '' : lodgingGridHtml(stop)}
      ${parkedRowsHtml(stop)}
    </div>`;
}

// Header total for a stop (running lodging cost of the active option).
function stopTotalHtml(stop) {
  if (nightsOf(stop) === 0) return '<div class="stop-total"></div>';
  const { cost, sel } = stopCost(stop);
  if (cost !== null) return `<div class="stop-total"><span class="amt">€${cost}</span> <span class="per">/ ${nightsOf(stop)}N</span></div>`;
  if (sel || stop.lodgingNote) return '<div class="stop-total"><span class="amt unset">—</span></div>';
  return '<div class="stop-total"><span class="amt unset">no lodging</span></div>';
}

function renderItinerary() {
  const el = $('#itinerary');
  const blocks = itinStops().map((stop, i) => {
    const transit = nightsOf(stop) === 0;
    const slot = slotFor(stop.id);
    const nParked = slot ? slot.candidateIds.length - 1 : 0;
    // meta shown after the date inputs in the sub-line
    const meta = transit
      ? `<span class="transit-tag">same-day · passing through</span>`
      : `<span>${nightsOf(stop)} night${nightsOf(stop) === 1 ? '' : 's'}</span>${nParked ? `<span class="dot">·</span><span class="active-flag">${nParked + 1} alternatives</span>` : ''}`;
    const moveCls = '';
    const collapsed = collapsedStops.has(stop.id);
    return `
      ${legBar(i, `from ${i === 0 ? esc(data.config.home?.name || 'home') : esc(itinStops()[i - 1].place)}`)}
      <div class="stop ${transit ? 'stop-transit' : ''} ${collapsed ? 'is-collapsed' : ''} ${moveCls}" data-id="${stop.id}">
        <div class="stop-header">
          <div class="stop-idwrap">
            <span class="drag-handle drag" title="Drag to reorder stops">⠿</span>
            <span class="stop-index">${i + 1}</span>
          </div>
          <div class="stop-headline">
            <div class="stop-nameline">
              <input class="stop-place stop-name-input" value="${esc(stop.place)}" placeholder="Place">
            </div>
            <div class="stop-sub">
              <input type="date" class="stop-checkin ${hasPendingStopDate(stop.id, 'checkin') ? 'is-date-pending' : ''}" value="${stopDateValue(stop, 'checkin')}">
              <span class="dates-arrow">→</span>
              <input type="date" class="stop-checkout ${hasPendingStopDate(stop.id, 'checkout') ? 'is-date-pending' : ''}" value="${stopDateValue(stop, 'checkout')}">
              <span class="dot">·</span>${meta}
              <label class="coord-label">Lat <input class="stop-lat" type="number" step="any" min="-90" max="90" value="${stop.lat ?? ''}" aria-label="Latitude for ${esc(stop.place)}"></label>
              <label class="coord-label">Lng <input class="stop-lng" type="number" step="any" min="-180" max="180" value="${stop.lng ?? ''}" aria-label="Longitude for ${esc(stop.place)}"></label>
            </div>
          </div>
          <div class="stop-headend">
            ${stopTotalHtml(stop)}
            <button class="btn-icon stop-toggle" aria-expanded="${collapsed ? 'false' : 'true'}" title="${collapsed ? 'Expand stop' : 'Collapse stop'}">${collapsed ? '▸' : '▾'}</button>
            <button class="btn-x stop-delete" title="Delete stop">×</button>
          </div>
        </div>
        ${collapsed ? '' : stopBodyHtml(stop)}
        ${collapsed || transit ? '' : `<table class="stop-days"><tbody>${data.days.filter(d => d.stopId === stop.id).map(dayRow).join('')}</tbody></table>`}
      </div>`;
  });

  if (data.config.home?.lat && itinStops().length) {
    const looseDays = data.days.filter(d => !d.stopId);
    blocks.push(`
      ${legBar(itinStops().length, `back to ${esc(data.config.home.name || 'home')}`)}
      <div class="stop home-block">
        <div class="stop-header">
          <div class="stop-idwrap"><span class="stop-index home-idx">🏠</span></div>
          <div class="stop-headline"><div class="stop-name">Return home</div></div>
        </div>
        ${looseDays.length ? `<table class="stop-days"><tbody>${looseDays.map(dayRow).join('')}</tbody></table>` : ''}
      </div>`);
  }
  el.innerHTML = blocks.join('');

  // transport-mode + leg-cost listeners
  el.querySelectorAll('.leg-mode-select').forEach(sel => {
    sel.addEventListener('change', e => setLeg(Number(sel.dataset.i), { mode: e.target.value }));
  });
  el.querySelectorAll('.leg-cost').forEach(inp => {
    inp.addEventListener('change', e => setLeg(Number(inp.dataset.i), { cost: e.target.value === '' ? null : Number(e.target.value) }));
  });

  // reorder stops by dragging the ⠿ handle — dates stay manual
  enablePointerReorder({
    container: el,
    itemSelector: '.stop[data-id]',
    handleSelector: '.stop[data-id] > .stop-header .drag-handle',
    ghostSelector: '.stop-header',
    measureSelector: '.stop-header',
    getId: b => b.dataset.id,
    onCommit: order => refresh(api('PUT', 'stops-order', { order })),
  });

  el.querySelectorAll('.stop[data-id]').forEach(block => {
    const id = block.dataset.id;
    const placeInput = $('.stop-place', block);
    if (placeInput) attachPlaceAutocomplete(placeInput, id);
    for (const field of ['lat','lng']) { const input = $('.stop-' + field, block); if (input) input.addEventListener('change', () => { routeCache = new Map(); didInitialFit = false; updateStop(id, { [field]: input.value === '' ? null : Number(input.value) }); }); }
    const ci = $('.stop-checkin', block);
    if (ci) ci.addEventListener('change', e => stageStopDate(id, 'checkin', e.target.value));
    const co = $('.stop-checkout', block);
    if (co) co.addEventListener('change', e => stageStopDate(id, 'checkout', e.target.value));
    const del = $('.stop-delete', block);
    if (del) del.addEventListener('click', () => {
      const stop = data.stops.find(s => s.id === id);
      if (confirm(`Delete stop "${stop.place}" and its lodging options?`)) deleteStop(id);
    });
    const toggle = $('.stop-toggle', block);
    if (toggle) toggle.addEventListener('click', () => {
      if (collapsedStops.has(id)) collapsedStops.delete(id);
      else collapsedStops.add(id);
      saveCollapsedStops();
      render();
    });
    // lodging cards live inside the stop now — bind their handlers here
    bindLodgingHandlers(block);
  });
  el.querySelectorAll('.alt-place-input').forEach(input => attachPlaceAutocomplete(input, input.dataset.cand));

  el.querySelectorAll('.stop-days tr').forEach(tr => {
    const date = tr.dataset.date;
    $('.day-save', tr).addEventListener('click', () => updateDay(date, { plan: $('.day-plan', tr).value }));
    $('.day-plan', tr).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); updateDay(date, { plan: e.target.value }); } });
    $('.day-status', tr).addEventListener('change', e => updateDay(date, { workStatus: e.target.value }));
  });
}

// A URL is fetchable only if it's a real http(s) URL with a host.
function isFetchableUrl(u) {
  try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') && /\./.test(x.hostname); }
  catch (e) { return false; }
}

function activeEnrichJob(item) {
  if (!item.url || !isFetchableUrl(item.url)) return null;
  return (data.researchJobs || [])
    .filter(j => j.type === 'enrich-lodging' && j.target?.lodgingId === item.id)
    .find(j => ['queued', 'running'].includes(j.status)) || null;
}

// Resolve what to show for an option that has a URL but no name yet.
// 'bad-url' | 'filling' | 'needs-fill'  (only called when !item.name)
function enrichState(item) {
  if (!item.url) return 'needs-fill';
  if (!isFetchableUrl(item.url)) return 'bad-url';
  return activeEnrichJob(item) ? 'filling' : 'needs-fill';
}

function lodgingCard(item, nights) {
  if (editingLodging === item.id) return lodgingForm(item);
  const itemStop = data.stops.find(s => s.id === item.stopId);
  // Honest enrich state — never a permanent fake "fetching…"
  const es = enrichState(item);
  const unavailable = item.availability === 'unavailable';
  const checking = !unavailable && !!activeEnrichJob(item);
  let name;
  if (item.name) {
    name = item.url
      ? `<a href="${esc(safeLink(withStayDates(item.url, itemStop)))}" target="_blank" rel="noopener" title="Opens with your dates pre-filled">${esc(item.name)}</a>`
      : esc(item.name);
  } else if (es === 'bad-url') {
    name = `<span class="lodging-name-warn" title="This URL is invalid — edit the option to fix it">⚠ Bad URL — edit</span>`;
  } else if (es === 'filling') {
    name = `<span class="muted">⏳ Online research is not included</span>`;
  } else { // needs-fill: URL present, no active job (or job failed)
    name = `<button class="lodging-fill" title="Online lookup is not included; use Edit to enter details">Enter details manually</button>`;
  }
  const expanded = expandedNearby.has(item.id);
  const checkNote = item.lastCheck && item.lastCheck.verdict !== 'unknown'
    ? `<span class="av-note ${item.lastCheck.verdict}" title="Auto-checked ${item.lastCheck.at?.slice(0, 10)} for ${item.lastCheck.checkin}→${item.lastCheck.checkout}">${item.lastCheck.verdict === 'available' ? '✓ likely available' : '✗ no availability'}</span>`
    : '';
  return `
    <div class="lodging-card status-${item.status} ${item.favorite ? 'favorite' : ''} ${unavailable ? 'av-unavailable' : ''}" data-id="${item.id}" title="${unavailable ? 'Marked unavailable — cannot be selected' : item.status === 'booked' ? 'Click to unselect' : 'Click to select'}">
      <div class="lodging-head">
        <span class="lodging-name">${name}</span>
        <span class="lodging-badges">
          ${checking ? '<span class="checking-chip">checking dates…</span>' : ''}
          ${unavailable ? '<span class="av-chip">unavailable</span>' : ''}
          ${item.score ? `<span class="score-chip ${item.score >= 8.5 ? '' : 'score-low'}" title="Booking.com guest score">★ ${item.score}</span>` : ''}
          ${item.reviews?.google?.score ? `<span class="score-chip" title="Google${item.reviews.google.count ? ` · ${item.reviews.google.count} reviews` : ''}">G ${item.reviews.google.score}${item.reviews.google.count ? ` (${item.reviews.google.count})` : ''}</span>` : ''}
        </span>
      </div>
      ${item.photo ? `<img class="lodging-thumb" src="${esc(item.photo)}" alt="" loading="lazy">` : ''}
      ${item.address ? `<button class="lodging-address" title="${item.lat && item.lng ? 'Zoom map to this address' : 'Open in Google Maps'}">📍 ${esc(item.address)}</button>` : ''}
      <div class="lodging-meta">
        ${(pf => pf ? `<span class="platform-chip ${pf.cls}">${pf.label}</span>` : '')(platformOf(item))}
        ${lodgingPriceHtml(item, nights, { checking })}
        ${item.area ? `<span class="area">${esc(item.area)}</span>` : ''}
        ${checkNote}${item.priceNeedsReview ? '<span class="muted">Estimate — review after date change</span>' : ''}
      </div>
      ${item.verdict ? `<p class="lodging-verdict">${esc(item.verdict)}</p>` : ''}
      ${reviewSnippets(item)}
      ${item.notes ? `<p class="lodging-notes">${esc(item.notes)}</p>` : ''}
      ${expanded ? nearbySection(item) : ''}
      <span class="lodging-footer">
        <span class="lodging-footer-left">
          <span class="drag-handle" title="Drag to re-rank">⋮⋮</span>
          ${item.rank ? `<span class="rank-chip" title="Our ranking for this stop (1 = best)">#${item.rank}</span>` : ''}
        </span>
        <span class="lodging-icons">
<button class="btn-sm lodging-select" aria-pressed="${item.status === 'booked'}">${item.status === 'booked' ? 'Selected' : 'Select'}</button>
          <button class="btn-icon lodging-fav ${item.favorite ? 'fav-on' : ''}" title="${item.favorite ? 'Unfavorite' : 'Favorite'}">${item.favorite ? '★' : '☆'}</button>
          <button class="btn-icon lodging-nearby-toggle" title="Nearby restaurants & groceries">🍽</button>
          ${item.url ? `<button class="btn-icon lodging-av-check" title="Check availability & dates now">⟲</button>` : ''}
          <button class="btn-icon lodging-edit" title="Edit">✎</button>
          <button class="btn-icon btn-icon-danger lodging-delete" title="Delete">×</button>
        </span>
      </span>
    </div>`;
}

// Deep-link with the stay dates so the page opens showing price/availability
// for the chosen stay; party details remain on the provider page.
function withStayDates(url, stop) {
  const checkin = stopDateValue(stop, 'checkin');
  const checkout = stopDateValue(stop, 'checkout');
  if (!url || !checkin) return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'booking.com' || u.hostname.endsWith('.booking.com')) {
      u.searchParams.set('checkin', checkin);
      u.searchParams.set('checkout', checkout);
    } else if (u.hostname.includes('airbnb.')) {
      u.searchParams.set('check_in', checkin);
      u.searchParams.set('check_out', checkout);
    }
    return u.toString();
  } catch (e) { return url; }
}

function platformOf(item) {
  const u = (item.url || '').toLowerCase();
  if (u.includes('airbnb.')) return { cls: 'pf-airbnb', label: 'airbnb' };
  if (u.includes('booking.com')) return { cls: 'pf-booking', label: 'Booking.com' };
  if (u.includes('tripadvisor')) return { cls: 'pf-tripadvisor', label: 'Tripadvisor' };
  return null;
}

function nearbySection(item) {
  const nb = item.nearby;
  if (!nb) {
    return `<div class="nearby"><p>Nearby research is not included. Add location notes manually, or open the property in your preferred map.</p></div>`;
  }
  const stop = data.stops.find(s => s.id === item.stopId);
  const city = (stop?.place || '').split('(')[0].split('/')[0].trim();
  const food = nb.places.filter(p => p.kind === 'food');
  const shops = nb.places.filter(p => p.kind === 'shop');
  // row click opens the pin's popup on the map; hover highlights the pin
  const row = p => {
    const i = nb.places.indexOf(p);
    return `
    <div class="nearby-row" data-pid="${item.id}|${i}" title="Show on map">
      <span class="nearby-name">${esc(p.name)}</span>
      <span class="muted">${p.rating ? `★${p.rating}${p.ratings ? ` (${p.ratings})` : ''} · ` : ''}${p.dist}m</span>
    </div>`;
  };
  const approx = nb.source !== 'hotel' ? `<p class="muted nearby-approx">≈ measured from the ${nb.source === 'area' ? 'area' : 'town center'} — couldn't pin the exact building</p>` : '';
  return `
    <div class="nearby">
      ${approx}
      ${food.length ? `<div class="nearby-group"><b>🍽 Food</b>${food.map(row).join('')}</div>` : ''}
      ${shops.length ? `<div class="nearby-group"><b>🛒 Groceries</b>${shops.map(row).join('')}</div>` : ''}
      ${!food.length && !shops.length ? '<p class="muted">Nothing found within ~500m.</p>' : ''}
      <div class="nearby-actions">
        <button class="btn-sm nearby-generate" title="Refresh from map data">⟳</button>
        <button class="btn-sm nearby-collapse" title="Collapse">▲ collapse</button>
      </div>
    </div>`;
}

function lodgingForm(item) {
  return `
    <div class="lodging-card editing" data-id="${esc(item.id || '')}" data-stop="${esc(item.stopId)}">
      <input class="f-name" value="${esc(item.name)}" placeholder="Name">
      <input class="f-url" value="${esc(item.url || '')}" placeholder="URL (booking.com…)">
      <div class="form-row">
        <input class="f-total" type="number" min="0" step="1" value="${item.totalPrice ?? ''}" placeholder="€ total">
        <input class="f-price" type="number" min="0" step="1" value="${item.pricePerNight ?? ''}" placeholder="€/night">
        <input class="f-score" type="number" step="0.1" min="1" max="10" value="${item.score ?? ''}" placeholder="Score">
        <input class="f-area" value="${esc(item.area)}" placeholder="Area / location">
      </div>
      <input class="f-address" value="${esc(item.address || '')}" placeholder="Street address">
      <input class="f-photo" value="${esc(item.photo || '')}" placeholder="Optional photo URL (external photos are blocked in offline mode)">
      <textarea class="f-notes" placeholder="Notes" rows="2">${esc(item.notes)}</textarea>
      <div class="lodging-actions">
        <button class="btn-sm btn-primary lodging-save">Save</button>
        <button class="btn-sm lodging-cancel">Cancel</button>
      </div>
    </div>`;
}

// Bind all lodging-card behavior within a container (used to be renderLodging's tail).
// The cards are now rendered inside each stop in renderItinerary; this wires them up.
function bindLodgingHandlers(el) {
  // drag a card's ⋮⋮ to re-rank it within its stop — pointer engine, grid-aware
  el.querySelectorAll('.lodge-grid').forEach(grid => {
    const stopId = grid.dataset.stop;
    if (!stopId) return;
    enablePointerReorder({
      container: grid,
      itemSelector: '.lodging-card:not(.editing)',
      handleSelector: '.lodging-card:not(.editing) .drag-handle',
      ghostSelector: '.lodging-head',
      getId: c => c.dataset.id,
      mode: 'grid',
      onCommit: order => refresh(api('PUT', 'lodging-order', { stopId, order })),
    });
  });

  el.querySelectorAll('.lodging-card:not(.editing)').forEach(card => {
    const id = card.dataset.id;
    const item = data.lodging.find(l => l.id === id);
    // click anywhere on the card selects it (or unselects if already selected);
    // links, chips and icons keep their own behavior
    guardScrollClicks(card);
    card.addEventListener('click', e => {
      if (e.target.closest('a, button, input, textarea, select, .nearby, .drag-handle')) return;
      if (item.availability === 'unavailable' && item.status !== 'booked') return;
      updateLodging(id, { status: item.status === 'booked' ? 'shortlist' : 'booked' });
    });
    const avCheck = $('.lodging-av-check', card);
    if (avCheck) avCheck.addEventListener('click', async () => {
      avCheck.textContent = '…';
      avCheck.disabled = true;
      try { data = await api('POST', `lodging/${id}/check`); } catch (e) { alert(e.message); }
      render();
    });
    const fill = $('.lodging-fill', card);
    if (fill) fill.addEventListener('click', async (e) => {
      e.stopPropagation();
      fill.textContent = 'Enter details manually';
      fill.disabled = true;
      editingLodging = id;
      render();
    });
    $('.lodging-select', card).addEventListener('click', () => updateLodging(id, { status: item.status === 'booked' ? 'shortlist' : 'booked' }));
    $('.lodging-fav', card).addEventListener('click', () => updateLodging(id, { favorite: !item.favorite }));
    const addr = $('.lodging-address', card);
    if (addr) addr.addEventListener('click', () => {
      if (item.lat && item.lng) {
        showLodgePin(item);
        map.getContainer().scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (item.address) {
        window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.address)}`, '_blank', 'noopener');
      }
    });
    $('.lodging-nearby-toggle', card).addEventListener('click', () => {
      if (expandedNearby.has(id)) expandedNearby.delete(id); else expandedNearby.add(id);
      render();
      if (expandedNearby.has(id)) {
        const bounds = (item.nearby?.places || []).filter(p => p.lat && p.lng).map(p => [p.lat, p.lng]);
        if (item.lat && item.lng) bounds.unshift([item.lat, item.lng]);
        if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] });
      }
    });
    const gen = $('.nearby-generate', card);
    if (gen) gen.addEventListener('click', async () => {
      gen.textContent = '…looking around';
      gen.disabled = true;
      try {
        data = await api('POST', `lodging/${id}/nearby`);
        render();
      } catch (e) {
        gen.textContent = 'Online research not included';
        gen.disabled = false;
      }
    });
    const collapse = $('.nearby-collapse', card);
    if (collapse) collapse.addEventListener('click', () => { expandedNearby.delete(id); render(); });
    card.querySelectorAll('.nearby-row[data-pid]').forEach(rowEl => {
      const marker = () => nearbyMarkers.get(rowEl.dataset.pid);
      rowEl.addEventListener('mouseenter', () => marker()?.getElement()?.classList.add('poi-hot'));
      rowEl.addEventListener('mouseleave', () => marker()?.getElement()?.classList.remove('poi-hot'));
      rowEl.addEventListener('click', () => {
        const m = marker();
        if (!m) return;
        map.panTo(m.getLatLng());
        m.openPopup();
        map.getContainer().scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
    $('.lodging-edit', card).addEventListener('click', () => { editingLodging = id; render(); });
    $('.lodging-delete', card).addEventListener('click', () => {
      if (confirm(`Delete "${item.name}"?`)) deleteLodging(id);
    });
  });

  // URL-only add form: one paste, the enrich pipeline does the rest
  el.querySelectorAll('.lodging-card.adding').forEach(card => {
    const urlInput = $('.f-url', card);
    const submit = () => {
      const url = urlInput.value.trim();
      if (!url) return urlInput.focus();
      editingLodging = null;
      createLodging({ stopId: card.dataset.stop, url });
    };
    $('.lodging-add-url', card).addEventListener('click', submit);
    urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    $('.lodging-cancel', card).addEventListener('click', () => { editingLodging = null; render(); });
    $('.add-manual', card).addEventListener('click', () => { editingLodging = `newfull:${card.dataset.stop}`; render(); });
    urlInput.focus();
  });

  el.querySelectorAll('.lodging-card.editing:not(.adding)').forEach(card => {
    $('.lodging-save', card).addEventListener('click', () => {
      const fields = {
        name: $('.f-name', card).value.trim(),
        url: $('.f-url', card).value.trim(),
        totalPrice: $('.f-total', card).value ? Number($('.f-total', card).value) : null,
        pricePerNight: $('.f-price', card).value ? Number($('.f-price', card).value) : null,
        score: $('.f-score', card).value ? Number($('.f-score', card).value) : null,
        priceNeedsReview: false,
        area: $('.f-area', card).value.trim(),
        address: $('.f-address', card).value.trim(),
        photo: $('.f-photo', card).value.trim(),
        notes: $('.f-notes', card).value.trim(),
      };
      const id = card.dataset.id;
      editingLodging = null;
      if (id) updateLodging(id, fields);
      else createLodging({ ...fields, stopId: card.dataset.stop });
    });
    $('.lodging-cancel', card).addEventListener('click', () => { editingLodging = null; render(); });
  });

  el.querySelectorAll('.lodging-add').forEach(btn => {
    btn.addEventListener('click', () => { editingLodging = `newfull:${btn.dataset.stop}`; render(); });
  });

}

// ---------- Geocoding (for new stops / renamed places) ----------

async function geocode() { return null; }

async function changeStopPlace(id, place) {
  await refresh(api('PUT', `stops/${id}`, { place }));
  const coords = await geocode(place);
  if (coords) await refresh(api('PUT', `stops/${id}`, coords));
}

// A shared overlay keeps suggestions visible through itinerary re-renders.
const placeAC = (() => {
  const box = document.createElement('div');
  box.className = 'place-ac';
  box.style.display = 'none';
  document.body.appendChild(box);

  let input = null, stopId = null, items = [], sel = -1, timer = null, seq = 0, picked = false;
  let session = crypto.randomUUID();

  const position = () => {
    if (!input) return;
    const r = input.getBoundingClientRect();
    box.style.left = `${r.left}px`;
    box.style.top = `${r.bottom + 2}px`;
    box.style.minWidth = `${r.width}px`;
  };
  const hide = () => { box.style.display = 'none'; box.innerHTML = ''; items = []; sel = -1; };
  const paint = () => {
    box.innerHTML = items.map((it, i) =>
      `<div class="place-ac-item${i === sel ? ' active' : ''}" data-i="${i}">${esc(it.description)}</div>`).join('') + '<div class="place-ac-credit">Powered by Google</div>';
  };
  const show = () => { position(); box.style.display = 'block'; paint(); };

  const choose = async (i) => {
    const it = items[i]; if (!it || !input) return;
    picked = true;
    const sid = stopId, desc = it.description;
    hide();
    const qs = new URLSearchParams();
    if (it.placeId) qs.set('placeId', it.placeId);
    qs.set('q', desc);
    qs.set('session', session);
    let det = null;
    try { det = await api('GET', `places/details?${qs}`); } catch (e) { /* fall back */ }
    session = crypto.randomUUID();
    // Short name only: Google's `name`, else the first comma-segment of the
    // description — never the whole "…, city, region, 0" address string.
    // trim regardless of source — Nominatim names arrive as full "…, city, country" strings
    const shortName = ((det && det.name) || desc).split(',')[0].trim();
    input.value = shortName;
    if (det && det.lat != null) {
      const body = { place: shortName, lat: det.lat, lng: det.lng };
      if (det.address) body.address = det.address;
      await refresh(api('PUT', `stops/${sid}`, body));
    } else {
      await changeStopPlace(sid, shortName); // geocode fallback
    }
  };

  const query = (q) => {
    const mine = ++seq;
    timer = setTimeout(async () => {
      let out = [];
      try { out = await api('GET', `places/autocomplete?q=${encodeURIComponent(q)}&session=${encodeURIComponent(session)}`); } catch (e) { out = []; }
      if (mine !== seq || document.activeElement !== input) return; // stale / input lost focus
      items = out || []; sel = -1;
      if (!items.length) return hide();
      show();
    }, 250);
  };

  // Clicks inside the box pick; clicks elsewhere dismiss. Use mousedown so it
  // fires before the input's blur tears things down.
  box.addEventListener('mousedown', e => {
    const item = e.target.closest('.place-ac-item');
    if (item) { e.preventDefault(); choose(Number(item.dataset.i)); }
  });
  document.addEventListener('mousedown', e => {
    if (box.style.display !== 'none' && e.target !== input && !box.contains(e.target)) hide();
  });
  // Keep it glued to the input while the page scrolls or the itinerary re-lays-out.
  window.addEventListener('scroll', () => { if (box.style.display !== 'none') position(); }, true);
  window.addEventListener('resize', () => { if (box.style.display !== 'none') position(); });

  return {
    // Bind one stop-place input to the shared controller.
    attach(inputEl, sid) {
      inputEl.addEventListener('focus', () => { input = inputEl; stopId = sid; });
      inputEl.addEventListener('input', () => {
        input = inputEl; stopId = sid; picked = false;
        clearTimeout(timer);
        const q = inputEl.value.trim();
        if (q.length < 2) return hide();
        query(q);
      });
      inputEl.addEventListener('keydown', e => {
        if (box.style.display === 'none' || !items.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; paint(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; paint(); }
        else if (e.key === 'Enter') { if (sel >= 0) { e.preventDefault(); choose(sel); } }
        else if (e.key === 'Escape') { hide(); }
      });
      // typed-and-blurred without picking → keep the old geocode-by-text path
      inputEl.addEventListener('change', () => {
        if (!picked && inputEl.value.trim()) changeStopPlace(sid, inputEl.value);
      });
    },
  };
})();

function attachPlaceAutocomplete(input, stopId) { placeAC.attach(input, stopId); }

// ---------- Mutations ----------

async function refresh(promise) {
  try {
    data = await promise;
  } catch (err) {
    alert(err.message || 'Save failed. Check the input and retry.');
    data = await api('GET', 'data');
  }
  render();
}

const updateStop = (id, body) => refresh(api('PUT', `stops/${id}`, body));
const deleteStop = id => refresh(api('DELETE', `stops/${id}`));

// Set a leg's mode and/or cost. Leg i arrives at stop i; i === stops.length is
// the return-home leg, stored on config (returnBy / returnCost).
function setLeg(i, { mode, cost } = {}) {
  if (i >= itinStops().length) {
    const body = {};
    if (mode !== undefined) body.returnBy = mode;
    if (cost !== undefined) body.returnCost = cost;
    return refresh(api('PUT', 'config', body));
  }
  const stop = itinStops()[i];
  const body = {};
  if (mode !== undefined) body.arriveBy = mode;
  if (cost !== undefined) body.legCost = cost;
  return updateStop(stop.id, body);
}
const updateDay = (date, body) => refresh(api('PUT', `days/${date}`, body));
const createLodging = body => refresh(api('POST', 'lodging', body));
const updateLodging = (id, body) => refresh(api('PUT', `lodging/${id}`, body));
const deleteLodging = id => refresh(api('DELETE', `lodging/${id}`));

$('#add-stop').addEventListener('click', () => {
  const last = itinStops()[itinStops().length - 1];
  refresh(api('POST', 'stops', { place: 'New stop', checkin: last?.checkout || '', checkout: last?.checkout || '' }));
});

// Swap a slot's active candidate — new place, new lodging → re-route + re-fit.
async function swapCandidate(slotId, stopId) {
  routeCache = new Map(); didInitialFit = false;
  await refresh(api('PUT', `slots/${slotId}/active`, { stopId }));
}

// Slot alternatives — one delegated listener on the stable #itinerary container.
$('#itinerary').addEventListener('click', e => {
  const add = e.target.closest('.add-alt');
  if (add) { routeCache = new Map(); didInitialFit = false; return refresh(api('POST', `stops/${add.dataset.add}/candidates`)); }
  const toggle = e.target.closest('.alt-toggle');
  if (toggle) {
    e.stopPropagation();
    setVariantDetailOpen(toggle.dataset.cand, toggle.getAttribute('aria-expanded') !== 'true');
    render();
    return;
  }
  const del = e.target.closest('.cand-del');
  if (del) {
    e.stopPropagation();
    if (confirm('Delete this alternative and its hotels? (To keep it, just leave it parked.)')) {
      refresh(api('DELETE', `slots/${del.dataset.slot}/candidates/${del.dataset.cand}`));
    }
    return;
  }
  if (e.target.closest('.alt-place-input')) return;
  const row = e.target.closest('.alt-row');
  if (row && row.dataset.cand && !row.closest('.alt')?.classList.contains('active')) swapCandidate(row.dataset.slot, row.dataset.cand);
});

// ---------- Co-op sync ----------
// Poll a tiny rev endpoint; when someone else saved, re-fetch and re-render.
// Skipped while this user is mid-edit so their input is never clobbered.

function isUserEditing() {
  if (editingLodging) return true;
  const ae = document.activeElement;
  if (!ae || !['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName)) return false;
  // The chat box is not trip-data editing — sitting in it must not freeze co-op
  // sync, or the agent's changes (e.g. it just added lodging) never show up.
  if (ae.id === 'chat-input') return false;
  return true;
}

async function syncPoll() {
  if (document.hidden || !data || isUserEditing()) return;
  try {
    const { rev } = await api('GET', 'rev');
    if (rev !== (data.rev || 0)) {
      data = await api('GET', 'data');
      render();
    }
  } catch (e) { /* offline blip — next poll retries */ }
}
setInterval(syncPoll, 4000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncPoll(); });

// ---------- Package mode (resorts / travel packages) ----------

let editingOffer = null; // offer id being edited, or 'new'
const offerPhotoIdx = new Map(); // offer id → current photo index
const expandedMatrix = new Set(); // offer ids with the date×price panel open

// Date × price table from the operator's priceMatrix; cheapest date highlighted
function priceMatrixPanel(offer) {
  const rows = (offer.priceMatrix || []).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (!rows.length) {
    return `<div class="nearby matrix-panel"><p class="muted">No date-price alternatives entered yet. Add a priceMatrix through the JSON API; no provider lookup runs automatically.</p></div>`;
  }
  const prices = rows.map(r => Number(r.total)).filter(Boolean);
  const min = Math.min(...prices), max = Math.max(...prices);
  const access = accessCost(departureOf(offer.departureId), offer.nights).total;
  const row = r => {
    const p = Number(r.total);
    const ratio = max > min ? (p - min) / (max - min) : 0;
    const cls = p === min ? 'best' : ratio < 0.34 ? 'low' : ratio < 0.67 ? 'mid' : 'high';
    const own = r.date === offer.checkin;
    return `
      <div class="matrix-row ${own ? 'own' : ''}" data-date="${esc(r.date)}" title="${own ? 'current pick' : 'click to make this the stay date'}">
        <span>${fmtDate(r.date)} · ${r.nights || offer.nights}N</span>
        <span class="matrix-price ${cls}">€${p}${access ? ` <small>(€${p + access} d2d)</small>` : ''}${p === min ? ' 🏆' : ''}</span>
      </div>`;
  };
  return `<div class="nearby matrix-panel"><b class="matrix-title">📅 Dates & prices</b>${rows.map(row).join('')}</div>`;
}

function selectedOffer() {
  return (data.offers || []).find(o => o.status === 'booked') || null;
}

function departureOf(id) {
  return (data.departures || []).find(d => d.id === id) || null;
}

function offersSorted() {
  return (data.offers || []).slice().sort((a, b) =>
    (a.rank ?? 999) - (b.rank ?? 999) ||
    (Number(a.price?.total) || 99999) - (Number(b.price?.total) || 99999));
}

// Cost of getting to/from the departure airport: round-trip fuel + parking for the stay
function accessCost(dep, nights) {
  if (!dep) return { fuel: 0, parking: 0, total: 0 };
  const car = data.config.car || {};
  const fuel = dep.driveKm ? Math.round(2 * dep.driveKm * ((car.lPer100 || 7.5) / 100) * (car.fuelPrice || 1.7)) : 0;
  const parking = Math.round((dep.parkingPerDay || 0) * ((nights || 7) + 1));
  return { fuel, parking, total: fuel + parking };
}

function doorToDoor(offer) {
  const base = Number(offer.price?.total);
  if (!base) return null;
  const access = accessCost(departureOf(offer.departureId), offer.nights);
  return { base, access, total: Math.round(base + access.total) };
}

function packageGrandTotal() {
  const sel = selectedOffer();
  const d2d = sel ? doorToDoor(sel) : null;
  return Math.round((d2d ? d2d.total : 0) + extraCostsTotal());
}

// ---- Best-offer scoring: weighted 0-100 from config.weights ----
const INCLUDE_WEIGHTS = { kidsClub: 3, aquapark: 2, cot: 2, kidsMenu: 1, drinks: 1, animation: 1, pools: 1, playground: 1, slides: 1, heatedPool: 1, spa: 0.5, transfer: 1, beachType: 1 };
const BOARD_POINTS = { UAI: 3, AI: 2.5, HB: 1.5, BB: 0.5, RO: 0 };
const clamp100 = x => Math.max(0, Math.min(100, Math.round(x)));

function offerScore(offer) {
  const w = data.config.weights || {};
  const parts = {};

  const d2d = doorToDoor(offer);
  const budget = Number(data.config.budgetTotal);
  if (d2d && budget) {
    // 0.7×budget → 100 · at budget → 60 · 1.3×budget → 0
    const r = d2d.total / budget;
    parts.price = clamp100(r <= 0.7 ? 100 : r <= 1 ? 100 - ((r - 0.7) / 0.3) * 40 : 60 - ((r - 1) / 0.3) * 60);
  }

  let inc = 0;
  for (const [k, v] of Object.entries(offer.includes || {})) if (v) inc += INCLUDE_WEIGHTS[k] || 0.5;
  inc += BOARD_POINTS[offer.board] || 0;
  parts.includes = clamp100((inc / 12) * 100);

  const r = offer.reviews || {};
  const rv = [];
  if (r.booking?.score) rv.push({ v: r.booking.score * 10, w: 1 });
  if (r.google?.score) rv.push({ v: r.google.score * 20, w: 1 });
  if (r.facebook?.score) rv.push({ v: r.facebook.score * 20, w: 2 });
  if (rv.length) {
    const avg = rv.reduce((a, x) => a + x.v * x.w, 0) / rv.reduce((a, x) => a + x.w, 0);
    parts.reviews = clamp100(r.facebook?.score ? avg : avg * 0.92); // small penalty while FB unchecked
  }

  const c = offer.climate || {};
  if (c.tMax != null) {
    let cs = 100;
    if (c.tMax < 22) cs -= (22 - c.tMax) * 5;
    if (c.tMax > 35) cs -= (c.tMax - 35) * 6;
    if (c.rainDays != null && c.rainDays > 4) cs -= (c.rainDays - 4) * 6;
    parts.climate = clamp100(cs);
  }

  const dep = departureOf(offer.departureId);
  if (dep) parts.departure = clamp100(100 - (accessCost(dep, offer.nights).total / 250) * 100);

  let sum = 0, wsum = 0;
  for (const [k, v] of Object.entries(parts)) {
    const weight = Number(w[k] ?? 1);
    sum += v * weight;
    wsum += weight;
  }
  if (!wsum) return null;
  return { total: Math.round(sum / wsum), parts };
}

function scoreBreakdownTitle(s) {
  if (!s) return 'Not enough data to score yet';
  return 'Score breakdown — ' + Object.entries(s.parts).map(([k, v]) => `${k}: ${v}`).join(' · ');
}

const BOARD_LABELS = { UAI: 'Ultra All Inclusive', AI: 'All Inclusive', HB: 'Half board', BB: 'Breakfast', RO: 'Room only' };
const INCLUDE_BADGES = {
  kidsClub: '🧒 kids club', aquapark: '💦 aquapark', pools: '🏊 pools', slides: '🛝 slides',
  playground: '🛝 playground', animation: '🎭 animation', cot: '🛏 cot', kidsMenu: '🍽 kids menu',
  drinks: '🍹 drinks', spa: '💆 spa', heatedPool: '♨️ heated pool', transfer: '🚌 transfer',
};

function includeBadges(inc) {
  if (!inc) return '';
  const out = [];
  for (const [key, val] of Object.entries(inc)) {
    if (!val) continue;
    if (key === 'beachType') { out.push(`🏖 ${esc(val)} beach`); continue; }
    let label = INCLUDE_BADGES[key] || `✓ ${esc(key)}`;
    if (typeof val === 'string') label += `: ${esc(val)}`;
    out.push(label);
  }
  return out.map(b => `<span class="inc-badge">${b}</span>`).join('');
}

function reviewChips(offer) {
  const r = offer.reviews || {};
  const chips = [];
  if (r.booking?.score) chips.push(`<span class="score-chip" title="Booking.com${r.booking.count ? ` · ${r.booking.count} reviews` : ''}">B ${r.booking.score}${r.booking.count ? ` (${r.booking.count})` : ''}</span>`);
  if (r.google?.score) chips.push(`<span class="score-chip" title="Google${r.google.count ? ` · ${r.google.count} reviews` : ''}">G ${r.google.score}${r.google.count ? ` (${r.google.count})` : ''}</span>`);
  if (r.facebook?.score) chips.push(`<span class="score-chip fb" title="Facebook${r.facebook.count ? ` · ${r.facebook.count} reviews` : ''}">f ${r.facebook.score}</span>`);

  return chips.join('');
}

// 1-2 short review quotes under a card, from reviews.snippets (Google/Booking/FB)
function reviewSnippets(entity) {
  const snips = entity.reviews?.snippets || [];
  if (!snips.length) return '';
  return snips.slice(0, 2).map(s =>
    `<p class="review-snippet" title="${esc(s.source || '')}${s.author ? ` — ${esc(s.author)}` : ''}">“${esc(s.text)}”${s.rating ? ` <span class="muted">★${s.rating}</span>` : ''}</p>`
  ).join('');
}

function renderPackageMap() {
  mapLayer.clearLayers();
  const pts = [];
  const home = data.config.home;
  if (home?.lat) {
    L.marker([home.lat, home.lng], { icon: L.divIcon({ className: 'map-pin', html: '<span>🏠</span>', iconSize: [28, 28], iconAnchor: [14, 14] }) })
      .addTo(mapLayer).bindTooltip(home.name || 'Home');
    pts.push([home.lat, home.lng]);
  }
  (data.departures || []).forEach(d => {
    if (!d.lat) return;
    L.marker([d.lat, d.lng], { icon: L.divIcon({ className: '', html: '<span class="poi-pin airport">✈️</span>', iconSize: [26, 26], iconAnchor: [13, 13] }) })
      .addTo(mapLayer).bindTooltip(`${d.airport} — ${d.city}`);
    pts.push([d.lat, d.lng]);
  });
  offersSorted().forEach(o => {
    const r = o.resort || {};
    if (!r.lat) return;
    const cls = o.status === 'booked' ? 'poi-pin resort selected' : o.favorite ? 'poi-pin resort fav' : 'poi-pin resort';
    const m = L.marker([r.lat, r.lng], { icon: L.divIcon({ className: '', html: `<span class="${cls}">🏖</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(mapLayer);
    const d2d = doorToDoor(o);
    m.bindPopup(`
      <div class="map-popup">
        ${r.photos?.[0] ? `<img class="popup-photo" src="${esc(r.photos[0])}" alt="">` : ''}
        <div class="popup-title">${esc(r.name)}</div>
        <div class="popup-dates">${esc(r.destination || '')}${d2d ? ` · €${d2d.total} door-to-door` : ''}</div>
        ${r.mapsUrl ? `<a class="popup-nav" href="${esc(safeLink(r.mapsUrl))}" target="_blank" rel="noopener">Google Maps ↗</a>` : ''}
      </div>`, { maxWidth: 270 });
    pts.push([r.lat, r.lng]);
  });
  map.getContainer().classList.toggle('map-empty-view', pts.length === 0);
  map.invalidateSize();
  if (!didInitialFit && pts.length === 1) { map.setView(pts[0], 10); didInitialFit = true; }
  if (!didInitialFit && pts.length > 1) {
    map.fitBounds(pts, { padding: [30, 30] });
    didInitialFit = true;
  }
}

function offerCard(offer) {
  if (editingOffer === offer.id) return offerForm(offer);
  const r = offer.resort || {};
  const d2d = doorToDoor(offer);
  const dep = departureOf(offer.departureId);
  const photos = r.photos || [];
  const idx = Math.min(offerPhotoIdx.get(offer.id) || 0, Math.max(0, photos.length - 1));
  const unavailable = offer.availability === 'unavailable';
  const budget = Number(data.config.budgetTotal);
  const tier = !d2d || !budget ? '' : d2d.total <= budget * 0.85 ? 'cheap' : d2d.total <= budget ? '' : 'expensive';
  const name = offer.urls?.offer || offer.urls?.hotel
    ? `<a href="${esc(safeLink(offer.urls.offer || offer.urls.hotel))}" target="_blank" rel="noopener">${esc(r.name)}</a>`
    : esc(r.name);
  return `
    <div class="lodging-card offer-card status-${offer.status} ${offer.favorite ? 'favorite' : ''} ${unavailable ? 'av-unavailable' : ''} ${moveState?.type === 'offer' ? (moveState.id === offer.id ? 'move-source' : 'move-target') : ''}" data-id="${offer.id}" title="${unavailable ? 'Marked unavailable' : offer.status === 'booked' ? 'Click to unselect' : 'Click to select'}">
      ${photos.length ? `
        <div class="offer-photo" style="background-image:url('${esc(photos[idx])}')" title="Click for next photo">
          ${photos.length > 1 ? `<span class="photo-count">${idx + 1}/${photos.length}</span>` : ''}
        </div>` : ''}
      <div class="lodging-head">
        <span class="lodging-name">${name}${r.stars ? ` <span class="muted">${'★'.repeat(r.stars)}</span>` : ''}</span>
        <span class="lodging-badges">
          ${unavailable ? '<span class="av-chip">unavailable</span>' : ''}
          ${(s => s ? `<span class="offer-score s${s.total >= 75 ? 'high' : s.total >= 55 ? 'mid' : 'low'}" title="${esc(scoreBreakdownTitle(s))}">${s.total}</span>` : '')(offerScore(offer))}
          ${reviewChips(offer)}
        </span>
      </div>
      <div class="lodging-meta">
        ${offer.source ? `<span class="platform-chip pf-operator">${esc(offer.source)}</span>` : ''}
        ${offer.kind === 'diy' ? '<span class="platform-chip pf-diy">DIY</span>' : ''}
        ${offer.board ? `<span class="board-chip" title="${BOARD_LABELS[offer.board] || ''}">${esc(offer.board)}</span>` : ''}
        ${offer.checkin ? `<span class="muted">${fmtDate(offer.checkin, { day: 'numeric', month: 'short' })} · ${offer.nights}N</span>` : `<span class="muted">${offer.nights}N</span>`}
      </div>
      <div class="lodging-meta">
        ${d2d
          ? `<span class="price ${tier}" title="package €${d2d.base} + access €${d2d.access.total} (fuel €${d2d.access.fuel}, parking €${d2d.access.parking})">€${d2d.total} door-to-door</span>
             <span class="muted">€${d2d.base} pkg${d2d.access.total ? ` + €${d2d.access.total} via ${esc(dep?.airport || '?')}` : ''}</span>`
          : '<span class="muted">no price yet</span>'}
      </div>
      <div class="dep-strip" title="Access cost (fuel + parking) from each departure airport — what the same package would add on top of its price">
        ${(data.departures || []).map(d => {
          const a = accessCost(d, offer.nights);
          return `<span class="dep-mini ${d.id === offer.departureId ? 'own' : ''}">${esc(d.airport)} +€${a.total}</span>`;
        }).join('')}
      </div>
      ${offer.climate?.tMax != null ? `
      <div class="lodging-meta climate-line">
        <span title="Entered average daily maximum; synthetic estimate in demo">🌡 ${offer.climate.tMax}°</span>
        ${offer.climate.seaTemp != null ? `<span title="Average sea surface temperature">🌊 ${offer.climate.seaTemp}°</span>` : ''}
        ${offer.climate.rainDays != null ? `<span title="Days with ≥1mm rain in the month">🌧 ${offer.climate.rainDays}d rain</span>` : ''}
      </div>` : ''}
      ${expandedMatrix.has(offer.id) ? priceMatrixPanel(offer) : ''}
      ${r.destination ? `<div class="lodging-meta"><span class="area">${esc([r.destination, r.country].filter(Boolean).join(', '))}</span></div>` : ''}
      <div class="inc-badges">${includeBadges(offer.includes)}</div>
      ${offer.reviews?.facebook?.summary ? `<p class="lodging-notes fb-summary">f: ${esc(offer.reviews.facebook.summary)}</p>` : ''}
      ${offer.verdict ? `<p class="lodging-verdict">${esc(offer.verdict)}</p>` : ''}
      ${reviewSnippets(offer)}
      ${offer.notes ? `<p class="lodging-notes">${esc(offer.notes)}</p>` : ''}
      ${r.address ? `<button class="lodging-address" title="Show on map">📍 ${esc(r.address)}</button>` : ''}
      <span class="lodging-footer">
        <span class="lodging-footer-left">
          <span class="drag-handle" draggable="true" title="Drag to reorder">⋮⋮</span>
          ${offer.rank ? `<span class="rank-chip" title="Ranking (1 = best)">#${offer.rank}</span>` : ''}
        </span>
        <span class="lodging-icons">
<button class="btn-sm offer-select" aria-pressed="${offer.status === 'booked'}">${offer.status === 'booked' ? 'Selected' : 'Select'}</button>
          <button class="btn-icon offer-fav ${offer.favorite ? 'fav-on' : ''}" title="${offer.favorite ? 'Unfavorite' : 'Favorite'}">${offer.favorite ? '★' : '☆'}</button>
          <button class="btn-icon offer-matrix" title="Date × price table">📅</button>
          <button class="btn-icon offer-enrich" title="Online research is not included; enter offer details manually" disabled>📷</button>
          <button class="btn-icon offer-edit" title="Edit">✎</button>
          <button class="btn-icon btn-icon-danger offer-delete" title="Delete">×</button>
        </span>
      </span>
    </div>`;
}

function offerForm(offer) {
  const r = offer.resort || {};
  const deps = data.departures || [];
  return `
    <div class="lodging-card editing offer-card" data-id="${esc(offer.id || '')}">
      <input class="f-name" value="${esc(r.name || '')}" placeholder="Resort / hotel name">
      <div class="form-row">
        <input class="f-destination" value="${esc(r.destination || '')}" placeholder="Destination / coastal town">
        <input class="f-country" value="${esc(r.country || '')}" placeholder="Country">
      </div>
      <div class="form-row">
        <input class="f-source" value="${esc(offer.source || '')}" placeholder="Operator / source">
        <select class="f-kind">
          <option value="package" ${offer.kind !== 'diy' ? 'selected' : ''}>package</option>
          <option value="diy" ${offer.kind === 'diy' ? 'selected' : ''}>DIY combo</option>
        </select>
      </div>
      <input class="f-url" value="${esc(offer.urls?.offer || '')}" placeholder="Offer URL">
      <div class="form-row">
        <input class="f-checkin" type="date" value="${esc(offer.checkin || '')}">
        <input class="f-nights" type="number" min="1" value="${offer.nights || 7}" title="Nights">
        <input class="f-price" type="number" value="${offer.price?.total ?? ''}" placeholder="€ total">
      </div>
      <div class="form-row">
        <select class="f-board">
          <option value="">board?</option>
          ${Object.entries(BOARD_LABELS).map(([k, v]) => `<option value="${k}" ${offer.board === k ? 'selected' : ''}>${k} — ${v}</option>`).join('')}
        </select>
        <select class="f-departure">
          <option value="">departure?</option>
          ${deps.map(d => `<option value="${d.id}" ${offer.departureId === d.id ? 'selected' : ''}>${d.airport} ${d.city}</option>`).join('')}
        </select>
      </div>
      <textarea class="f-notes" placeholder="Notes (what's included, transfer, room type…)" rows="2">${esc(offer.notes || '')}</textarea>
      <div class="lodging-actions">
        <button class="btn-sm btn-primary offer-save">Save</button>
        <button class="btn-sm offer-cancel">Cancel</button>
      </div>
    </div>`;
}

function renderOffers() {
  const el = $('#offers');
  const deps = data.departures || [];
  const depBar = `
    <div class="departures-bar">
      ${deps.map(d => `
        <span class="dep-chip" data-id="${d.id}" title="${esc(d.notes || '')}">
          ✈️ ${esc(d.airport)} ${esc(d.city)} ·
          <input class="dep-km" type="number" value="${d.driveKm ?? 0}" title="one-way drive km">km ·
          €<input class="dep-park" type="number" value="${d.parkingPerDay ?? 0}" title="airport parking €/day">/d
        </span>`).join('')}
      <span class="dep-chip weights-chip" title="Scoring weights (0 = ignore, 2 = double importance)">
        ⚖️ ${['price', 'includes', 'reviews', 'climate', 'departure'].map(k =>
          `${k.slice(0, 3)} <input class="weight-input" data-key="${k}" type="number" min="0" max="3" step="0.5" value="${(data.config.weights || {})[k] ?? 1}">`).join(' ')}
      </span>
      <button class="dep-chip sort-by-score" title="Re-rank all offers by their current score">↕ sort by score</button>
    </div>`;
  const jobs = data.researchJobs || [];
  const jobLabel = j => {
    const offer = j.target?.offerId ? (data.offers || []).find(o => o.id === j.target.offerId) : null;
    return `${j.type}${offer ? `: ${offer.resort?.name}` : j.target?.query ? `: ${j.target.query}` : ''}`;
  };
  const jobsBar = jobs.length ? `
    <div class="jobs-bar" title="Online research is not included in this edition">
      ${jobs.map(j => `
        <span class="job-chip job-${j.status}" data-id="${j.id}" title="${esc(j.note || '')}${j.status === 'failed' ? ' (failed)' : ''}">
          ${j.status === 'done' ? '✓' : j.status === 'running' ? '⏳' : j.status === 'failed' ? '✗' : '🕓'}
          ${esc(jobLabel(j))}
          <button class="btn-icon job-delete" title="Remove">×</button>
        </span>`).join('')}
    </div>` : '';
  const cards = offersSorted().map(offerCard).join('');
  const newForm = editingOffer === 'new'
    ? offerForm({ id: '', kind: 'package', resort: {}, urls: {}, price: {}, nights: 7 })
    : '';
  el.innerHTML = depBar + jobsBar + `<div class="lodging-cards offer-cards">${cards}${newForm}</div>`;

  el.querySelectorAll('.job-chip .job-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.job-chip').dataset.id;
      refresh(api('DELETE', `jobs/${id}`));
    });
  });

  el.querySelectorAll('.dep-chip[data-id]').forEach(chip => {
    const id = chip.dataset.id;
    $('.dep-km', chip).addEventListener('change', e => refresh(api('PUT', `departures/${id}`, { driveKm: Number(e.target.value) || 0 })));
    $('.dep-park', chip).addEventListener('change', e => refresh(api('PUT', `departures/${id}`, { parkingPerDay: Number(e.target.value) || 0 })));
  });

  el.querySelectorAll('.weight-input').forEach(inp => {
    inp.addEventListener('change', e => refresh(api('PUT', 'config', { weights: { [inp.dataset.key]: Number(e.target.value) } })));
  });
  const sortBtn = $('.sort-by-score', el);
  if (sortBtn) sortBtn.addEventListener('click', () => {
    const order = (data.offers || []).slice()
      .sort((a, b) => (offerScore(b)?.total ?? -1) - (offerScore(a)?.total ?? -1))
      .map(o => o.id);
    if (order.length) refresh(api('PUT', 'offers-order', { order }));
  });

  el.querySelectorAll('.offer-card:not(.editing)').forEach(card => {
    const id = card.dataset.id;
    const offer = data.offers.find(o => o.id === id);
    guardScrollClicks(card);
    card.addEventListener('click', e => {
      if (e.target.closest('a, button, input, textarea, select, .nearby, .drag-handle')) return;
      if (moveState?.type === 'offer') {
        const picked = moveState.id;
        moveState = null;
        if (picked !== id) {
          return refresh(api('PUT', 'offers-order', { order: reorderTakePlace(offersSorted().map(o => o.id), picked, id) }));
        }
        return render();
      }
      if (offer.availability === 'unavailable' && offer.status !== 'booked') return;
      refresh(api('PUT', `offers/${id}`, { status: offer.status === 'booked' ? 'shortlist' : 'booked' }));
    });
    const photo = $('.offer-photo', card);
    if (photo) photo.addEventListener('click', e => {
      e.stopPropagation();
      const n = (offer.resort?.photos || []).length;
      if (n > 1) { offerPhotoIdx.set(id, ((offerPhotoIdx.get(id) || 0) + 1) % n); render(); }
    });
    const addr = $('.lodging-address', card);
    if (addr) addr.addEventListener('click', () => {
      if (offer.resort?.lat) {
        showLodgePin({ name: offer.resort.name, lat: offer.resort.lat, lng: offer.resort.lng, address: offer.resort.address, score: offer.reviews?.google?.score });
        map.getContainer().scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
    $('.offer-select', card).addEventListener('click', () => refresh(api('PUT', `offers/${id}`, { status: offer.status === 'booked' ? 'shortlist' : 'booked' })));
    $('.offer-fav', card).addEventListener('click', () => refresh(api('PUT', `offers/${id}`, { favorite: !offer.favorite })));
    $('.offer-enrich', card).addEventListener('click', async e => {
      e.target.textContent = '…';
      try { await api('POST', `offers/${id}/enrich`); } catch (err) { alert(err.message); }
    });
    $('.offer-matrix', card).addEventListener('click', () => {
      if (expandedMatrix.has(id)) expandedMatrix.delete(id); else expandedMatrix.add(id);
      render();
    });
    card.querySelectorAll('.matrix-row[data-date]').forEach(rowEl => {
      rowEl.addEventListener('click', () => {
        const pick = (offer.priceMatrix || []).find(r => r.date === rowEl.dataset.date);
        if (!pick || pick.date === offer.checkin) return;
        refresh(api('PUT', `offers/${id}`, { checkin: pick.date, nights: pick.nights || offer.nights, price: { total: Number(pick.total) } }));
      });
    });
    $('.offer-edit', card).addEventListener('click', () => { editingOffer = id; render(); });
    $('.offer-delete', card).addEventListener('click', () => {
      if (confirm(`Delete offer "${offer.resort?.name}"?`)) refresh(api('DELETE', `offers/${id}`));
    });
    const handle = $('.drag-handle', card);
    if (handle) {
      handle.addEventListener('dragstart', e => {
        dragState = { type: 'offer', id };
        e.dataTransfer.effectAllowed = 'move';
      });
      handle.addEventListener('click', e => {
        e.stopPropagation();
        moveState = moveState?.type === 'offer' && moveState.id === id ? null : { type: 'offer', id };
        render();
      });
    }
    card.addEventListener('dragover', e => {
      if (dragState?.type === 'offer' && dragState.id !== id) { e.preventDefault(); card.classList.add('drop-target'); }
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', e => {
      e.preventDefault();
      card.classList.remove('drop-target');
      if (dragState?.type !== 'offer' || dragState.id === id) return;
      const order = reorderTakePlace(offersSorted().map(o => o.id), dragState.id, id);
      dragState = null;
      refresh(api('PUT', 'offers-order', { order }));
    });
  });

  el.querySelectorAll('.offer-card.editing').forEach(card => {
    $('.offer-save', card).addEventListener('click', () => {
      const fields = {
        kind: $('.f-kind', card).value,
        source: $('.f-source', card).value.trim(),
        resort: {
          name: $('.f-name', card).value.trim(),
          destination: $('.f-destination', card).value.trim(),
          country: $('.f-country', card).value.trim(),
        },
        urls: { offer: $('.f-url', card).value.trim() },
        checkin: $('.f-checkin', card).value,
        nights: Number($('.f-nights', card).value) || 7,
        price: { total: $('.f-price', card).value ? Number($('.f-price', card).value) : null },
        board: $('.f-board', card).value,
        departureId: $('.f-departure', card).value || null,
        notes: $('.f-notes', card).value.trim(),
      };
      const id = card.dataset.id;
      editingOffer = null;
      if (id) refresh(api('PUT', `offers/${id}`, fields));
      else refresh(api('POST', 'offers', fields));
    });
    $('.offer-cancel', card).addEventListener('click', () => { editingOffer = null; render(); });
  });
}

function renderPackageBudget() {
  const el = $('#budget');
  const sel = selectedOffer();
  const d2d = sel ? doorToDoor(sel) : null;
  const dep = sel ? departureOf(sel.departureId) : null;
  const rows = [];

  rows.push(`
    <div class="budget-row computed">
      <span class="budget-label">${sel ? esc(sel.resort?.name || 'Selected offer') : 'Selected offer'}
        <span class="muted">${sel && d2d ? `€${d2d.base} package${d2d.access.total ? ` + €${d2d.access.fuel} fuel + €${d2d.access.parking} parking via ${esc(dep?.airport || '?')}` : ''}` : 'none selected yet'}</span>
      </span>
      <span class="budget-amount">€${d2d ? d2d.total : 0}</span>
    </div>`);

  (data.costs || []).forEach(c => {
    rows.push(`
      <div class="budget-row" data-id="${c.id}">
        <span class="budget-label">
          <input class="cost-label" value="${esc(c.label)}" placeholder="Label">
          ${c.notes ? `<span class="muted cost-notes">${esc(c.notes)}</span>` : ''}
        </span>
        <span class="budget-amount">€<input class="cost-amount" type="number" value="${c.amount}"></span>
        <button class="btn-x cost-delete" title="Delete">×</button>
      </div>`);
  });

  const total = packageGrandTotal();
  const budget = Number(data.config.budgetTotal);
  rows.push(`
    <div class="budget-row total-row">
      <span class="budget-label">Total <span class="muted">budget €<input class="cfg-budget-total" type="number" value="${budget || ''}"></span></span>
      <span class="budget-amount ${budget && total > budget ? 'expensive' : ''}">€${total}</span>
    </div>`);

  el.innerHTML = `<div class="budget-card">${rows.join('')}</div><button id="add-cost" class="btn-add">+ Add misc cost</button>`;

  el.querySelectorAll('.budget-row[data-id]').forEach(row => {
    const id = row.dataset.id;
    $('.cost-label', row).addEventListener('change', e => refresh(api('PUT', `costs/${id}`, { label: e.target.value })));
    $('.cost-amount', row).addEventListener('change', e => refresh(api('PUT', `costs/${id}`, { amount: Number(e.target.value) || 0 })));
    $('.cost-delete', row).addEventListener('click', () => {
      const cost = data.costs.find(c => c.id === id);
      if (confirm(`Delete cost "${cost.label}"?`)) refresh(api('DELETE', `costs/${id}`));
    });
  });
  const bt = $('.cfg-budget-total', el);
  if (bt) bt.addEventListener('change', e => refresh(api('PUT', 'config', { budgetTotal: Number(e.target.value) || null })));
  $('#add-cost', el).addEventListener('click', () => refresh(api('POST', 'costs', { label: 'Misc cost', amount: 0 })));
}

$('#add-offer').addEventListener('click', () => { editingOffer = 'new'; render(); });

// ---------- Init ----------
api('GET', 'data').then(d => { data = d; render(); }).catch(() => {
  document.querySelector('main').textContent = 'Trip could not be loaded. Check the server and reload.';
});
