const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const BASE = '/:slug';
const PORT = Number(process.env.PORT || 8090);
const DATA_DIR = path.resolve(process.env.TRIP_DATA_DIR || path.join(os.homedir(), '.trip-dashboard'));
const AUTH_USER = process.env.TRIP_USER;
const AUTH_PASS = process.env.TRIP_PASS;
if (!!AUTH_USER !== !!AUTH_PASS) throw new Error('Set both TRIP_USER and TRIP_PASS, or neither for local use.');
const NETWORK = process.env.TRIP_NETWORK === '1';
const MAPS_KEY = process.env.GOOGLE_MAPS_BROWSER_KEY || '';
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const PLACES_LEGACY = process.env.GOOGLE_PLACES_API_MODE === 'legacy';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
function dataFile(slug) {
  if (!SLUG_RE.test(slug)) throw new Error('Invalid trip slug');
  const file = path.join(DATA_DIR, slug + '.json');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Trip symlinks are not supported');
  return file;
}
if (DATA_DIR === __dirname || DATA_DIR.startsWith(__dirname + path.sep)) throw new Error('TRIP_DATA_DIR must be outside the source directory');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
if (fs.realpathSync(DATA_DIR) === __dirname || fs.realpathSync(DATA_DIR).startsWith(fs.realpathSync(__dirname) + path.sep)) throw new Error('Runtime directory resolves inside the source directory');
if (process.env.TRIP_DEMO === '1') {
  for (const name of fs.readdirSync(path.join(__dirname, 'demo'))) {
    const target = path.join(DATA_DIR, name);
    if (!fs.existsSync(target)) { fs.copyFileSync(path.join(__dirname, 'demo', name), target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600); }
  }
}
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': NETWORK ? 'strict-origin-when-cross-origin' : 'same-origin', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': `default-src 'self'; script-src 'self'${NETWORK && MAPS_KEY ? ' https://maps.googleapis.com https://maps.gstatic.com' : ''}; style-src 'self' 'unsafe-inline'${NETWORK && MAPS_KEY ? ' https://fonts.googleapis.com' : ''}; font-src 'self'${NETWORK && MAPS_KEY ? ' https://fonts.gstatic.com' : ''}; img-src 'self' data:${NETWORK ? ' https://tile.openstreetmap.org' + (MAPS_KEY ? ' https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com' : '') : ''}; connect-src 'self'${NETWORK ? ' https://router.project-osrm.org' + (MAPS_KEY ? ' https://*.googleapis.com https://*.gstatic.com https://*.google.com' : '') : ''}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` });
  // Reject DNS rebinding and cross-site writes, even on a local server.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname)) return res.status(403).json({ error: 'Local host required' });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site write rejected' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return res.status(403).json({ error: 'Origin rejected' });
  }
  if (!AUTH_USER) return next();
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  const given = scheme === 'Basic' ? Buffer.from(encoded || '', 'base64').toString() : '';
  const expected = `${AUTH_USER}:${AUTH_PASS}`;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (crypto.timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Trip Dashboard"');
  res.status(401).send('Authentication required');
});
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = body => {
    if (body?.config) {
      body = { ...body, config: { ...body.config, capabilities: { network: NETWORK, places: NETWORK && !!PLACES_KEY } } };
      delete body.config.mapsKey;
      if (NETWORK && MAPS_KEY) body.config.mapsKey = MAPS_KEY;
    }
    return json(body);
  };
  next();
});
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
function validateInput(value, key = '', depth = 0) {
  if (depth > 16) throw new Error('Input is too deeply nested');
  if (['__proto__', 'prototype', 'constructor', 'mapsKey', 'capabilities'].includes(key)) throw new Error('Reserved field');
  if (value && typeof value === 'object') {
    if (value.checkin && value.checkout && value.checkin > value.checkout) throw new Error('Checkout must follow checkin');
    for (const [k, v] of Object.entries(value)) validateInput(v, k, depth + 1);
  }
  const numeric = new Set(['lat','lng','amount','total','totalPrice','pricePerNight','score','count','stars','nights','rank','lPer100','fuelPrice','roadFactor','budgetMin','budgetMax','budgetTotal','driveKm','parkingPerDay','legCost','rating','ratings','tMax','rainDays','seaTemp','tMin','sea','precipMm']);
  if (key === 'weights' && (!value || typeof value !== 'object' || Object.values(value).some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 3))) throw new Error('Weights must be numbers from zero to three');
  if (['totalPrice','pricePerNight','nights'].includes(key) && typeof value === 'number' && value < 0) throw new Error('Prices and nights must be nonnegative');
  if (numeric.has(key) && value !== null && value !== '' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Use a number');
  if (key === 'lat' && value !== null && Math.abs(value) > 90) throw new Error('Latitude out of range');
  if (key === 'lng' && value !== null && Math.abs(value) > 180) throw new Error('Longitude out of range');
  if (key === 'stars' && value !== null && (!Number.isInteger(value) || value < 0 || value > 5)) throw new Error('Invalid stars');
  if (key === 'id' && (depth !== 3 || typeof value !== 'string' || !/^[a-zA-Z0-9-]+$/.test(value))) throw new Error('IDs are managed by the server');
  if (key === 'status' && !['idea','shortlist','booked'].includes(value)) throw new Error('Invalid status');
  if (['mode','arriveBy','returnBy'].includes(key) && !['drive','fly','train','ferry','bus','transfer'].includes(value)) throw new Error('Invalid transport');
  if (key === 'workStatus' && !['afk','work','weekend'].includes(value)) throw new Error('Invalid day status');
  if (typeof value === 'string') {
    if (value.length > 10000) throw new Error('Text is too long');
    if (['checkin', 'checkout'].includes(key) && value) {
      if (!/^20\d{2}-\d{2}-\d{2}$/.test(value) || new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) !== value) throw new Error('Use a valid date from 2000 to 2099');
    }
    if (value && /^(url|website|mapsUrl|googleMapsUrl|offer|hotel|flight)$/i.test(key)) {
      const u = new URL(value);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Use an HTTP(S) link without credentials');
    }
  }
}
app.use((req, res, next) => {
  try { validateInput(req.body); next(); } catch { res.status(400).json({ error: 'Invalid input: check dates, links and reserved fields' }); }
});
app.get('/assets/home.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.js')));
app.use(BASE, (req, res, next) => {
  if (req.params.slug === 'clone') return next();
  if (!SLUG_RE.test(req.params.slug) || !fs.existsSync(dataFile(req.params.slug))) return res.status(404).json({ error: 'Unknown trip' });
  next();
});
function log() {} // Trip content is deliberately excluded from logs.

function flattenPlans(data) {
  if (!Array.isArray(data.plans)) return data; // already flat
  const active = data.plans.find(p => p.id === data.activePlan) || data.plans[0] || {};
  data.stops = active.stops || [];
  data.days = active.days || [];
  data.lodging = active.lodging || [];
  data.costs = active.costs || [];
  delete data.plans; delete data.activePlan;
  return data;
}

// Kept as a no-op indirection so the ~33 handlers that read `activePlan(data).X`
// keep working after the flatten (data itself is now the itinerary container).
function activePlan(d) { return d; }

// --- Slots: mixable per-position alternatives ---
// The itinerary is an ordered list of SLOTS; each slot holds one or more candidate
// stops (peers, each with its own lodging) and exactly one is active. Swapping the
// active candidate changes that leg (route/fuel/budget) without deleting the others.
function migrateSlots(data) {
  if (data.config?.type === 'package') return data;
  if (!Array.isArray(data.stops)) return data;
  if (!Array.isArray(data.slots)) {
    data.slots = [];
    for (const stop of [...data.stops]) { // snapshot: exploded peers must not get their own slots
      const slot = { id: crypto.randomUUID().slice(0, 8), candidateIds: [stop.id], activeStopId: stop.id };
      // explode the old nested stop.alts[] into peer candidate stops
      if (Array.isArray(stop.alts)) {
        for (const a of stop.alts) {
          if (a.id === stop.activeAlt) continue; // the active alt IS the stop (mirrored)
          const peer = { id: a.id, checkin: stop.checkin, checkout: stop.checkout };
          for (const f of ['place', 'lat', 'lng', 'arriveBy', 'legCost', 'lodgingNote']) peer[f] = a[f];
          data.stops.push(peer);
          slot.candidateIds.push(peer.id);
          // re-key that alt's lodging to the new peer stop
          (data.lodging || []).forEach(l => { if (l.stopId === stop.id && l.altId === a.id) l.stopId = peer.id; });
        }
        delete stop.alts; delete stop.activeAlt;
      }
      data.slots.push(slot);
    }
    (data.lodging || []).forEach(l => { delete l.altId; });
  }
  // drop slots whose stops vanished; ensure every slot has a valid active candidate
  data.slots = data.slots.filter(sl => (sl.candidateIds = sl.candidateIds.filter(id => data.stops.some(s => s.id === id))).length);
  for (const sl of data.slots) {
    if (!sl.candidateIds.includes(sl.activeStopId)) sl.activeStopId = sl.candidateIds[0];
  }
  return data;
}

function migrateCarRentalCost(data) {
  const rental = data.config?.carRental;
  if (!rental) return data;
  data.costs = data.costs || [];
  const amount = Number(rental.amount) || 0;
  if (rental.enabled && amount > 0 && !data.costs.some(c => c.id === 'car-rental')) {
    data.costs.push({ id: 'car-rental', label: 'Car rental', amount, notes: 'Converted from the old car-rental budget field' });
  }
  delete data.config.carRental;
  return data;
}

// The live itinerary: each slot's active candidate, in slot order.
function activeStops(d) {
  if (!Array.isArray(d.slots)) return d.stops || [];
  return d.slots.map(sl => (d.stops || []).find(s => s.id === sl.activeStopId)).filter(Boolean);
}
function slotOf(d, stopId) {
  return (d.slots || []).find(sl => sl.candidateIds.includes(stopId)) || null;
}

function load(slug) {
  return migrateCarRentalCost(migrateSlots(flattenPlans(JSON.parse(fs.readFileSync(dataFile(slug), 'utf8')))));
}
function save(slug, data) {
  data.rev = (data.rev || 0) + 1;
  // finished research jobs are only useful for a while — keep a week
  if (Array.isArray(data.researchJobs)) {
    const cutoff = Date.now() - 7 * 864e5;
    data.researchJobs = data.researchJobs.filter(j =>
      !['done', 'failed'].includes(j.status) || !j.finishedAt || Date.parse(j.finishedAt) > cutoff);
  }
  const tmp = dataFile(slug) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, dataFile(slug));
}


const DEFAULT_DEPARTURES = [];

function skeleton(slug, type = 'roadtrip') {
  const common = {
    config: {
      type,
      tripName: slug,
      home: { name: 'Starting point', lat: null, lng: null },
      car: { lPer100: 7.5, fuelPrice: 1.7, roadFactor: 1.25 },
    },
    costs: [],
    rev: 0,
  };
  if (type === 'package') {
    return {
      ...common,
      config: {
        ...common.config,
        party: { adults: 2, kidsAges: [] },
        budgetTotal: 2500,
        weights: { price: 1, includes: 1, reviews: 1, climate: 1, departure: 1 },
      },
      departures: DEFAULT_DEPARTURES.map(d => ({ ...d })),
      offers: [],
      researchJobs: [],
    };
  }
  return {
    ...common,
    config: { ...common.config, budgetMin: 100, budgetMax: 150 },
    stops: [],
    slots: [],
    days: [],
    lodging: [],
  };
}

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isWeekend(iso) {
  const dow = new Date(iso + 'T12:00:00Z').getUTCDay();
  return dow === 0 || dow === 6;
}

// Rebuild the day list from stop date ranges, preserving existing
// per-day plan/workStatus by date. Takes a plan (or flat data for packages).
function rebuildDays(P) {
  // days follow the LIVE itinerary — each slot's active candidate, not parked ones
  const stops = activeStops(P).filter(s => s.checkin && s.checkout);
  if (!stops.length) { P.days = []; return; }
  const first = stops.map(s => s.checkin).sort()[0];
  const last = stops.map(s => s.checkout).sort().slice(-1)[0];
  if ((Date.parse(last) - Date.parse(first)) / 864e5 > 730) throw new Error('Trip date span must be at most two years');
  const existing = Object.fromEntries((P.days || []).map(d => [d.date, d]));
  const days = [];
  for (let date = first; date <= last; date = addDays(date, 1)) {
    const stop = stops.find(s => s.checkin <= date && date < s.checkout);
    const prev = existing[date] || {};
    days.push({
      date,
      sleep: stop ? stop.place : 'Home',
      stopId: stop ? stop.id : null,
      plan: prev.plan || '',
      workStatus: prev.workStatus || (isWeekend(date) ? 'weekend' : 'work'),
    });
  }
  P.days = days;
}


// --- API ---
app.get(`${BASE}/api/data`, (req, res) => {
  const data = load(req.params.slug);
  res.json(data);
});

// lightweight change-detection endpoint for co-op polling
app.get(`${BASE}/api/rev`, (req, res) => res.json({ rev: load(req.params.slug).rev || 0 }));

app.put(`${BASE}/api/config`, (req, res) => {
  const data = load(req.params.slug);
  // deep-merge one level (e.g. {car: {fuelPrice: 1.8}} keeps other car fields)
  for (const [key, value] of Object.entries(req.body)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof data.config[key] === 'object') {
      Object.assign(data.config[key], value);
    } else {
      data.config[key] = value;
    }
  }
  save(req.params.slug, data);
  res.json(data);
});

const shortId = () => crypto.randomUUID().slice(0, 8);

app.post(`${BASE}/api/stops`, (req, res) => {
  const data = load(req.params.slug);
  const P = activePlan(data);
  const stop = { id: shortId(), place: '', checkin: '', checkout: '', lodgingNote: '', ...req.body };
  P.stops.push(stop);
  // a new stop is a new slot with itself as the only candidate
  P.slots.push({ id: shortId(), candidateIds: [stop.id], activeStopId: stop.id });
  rebuildDays(P);
  save(req.params.slug, data);
  res.json(data);
});

app.put(`${BASE}/api/stops/:id`, (req, res) => {
  const data = load(req.params.slug);
  const P = activePlan(data);
  const stop = P.stops.find(s => s.id === req.params.id);
  if (!stop) return res.status(404).json({ error: 'not found' });
  if ((req.body.checkin ?? stop.checkin) && (req.body.checkout ?? stop.checkout) && (req.body.checkin ?? stop.checkin) > (req.body.checkout ?? stop.checkout)) return res.status(400).json({ error: 'Checkout must follow checkin' });
  const datesChanged = (req.body.checkin !== undefined && req.body.checkin !== stop.checkin)
    || (req.body.checkout !== undefined && req.body.checkout !== stop.checkout);
  let affectedStopIds = null;
  Object.assign(stop, req.body);
  // slot owns the date range: a date edit propagates to every sibling candidate
  if (datesChanged) {
    const slot = slotOf(P, stop.id);
    const affected = new Set([stop.id]);
    if (slot) for (const cid of slot.candidateIds) {
      const sib = P.stops.find(s => s.id === cid);
      if (sib) { sib.checkin = stop.checkin; sib.checkout = stop.checkout; }
      affected.add(cid);
    }
    affectedStopIds = [...affected];
  }
  rebuildDays(P);
  if (datesChanged) resetDateSensitiveLodging(P, affectedStopIds || [stop.id]);
  save(req.params.slug, data);
  res.json(data);
  if (datesChanged) {
    // real re-checks: browser-visit each option with the NEW dates (availability +
    // price signal); the plain-fetch sweep stays as a fallback for the rest
    const affected = affectedStopIds || [stop.id];
    P.lodging.filter(l => affected.includes(l.stopId) && isFetchableUrl(l.url))
      .forEach(l => queueLodgingEnrich(req.params.slug, l.id));
    queueAvailabilityChecks(req.params.slug, affected);
  }
});

app.put(`${BASE}/api/stops-dates`, (req, res) => {
  const data = load(req.params.slug);
  const P = activePlan(data);
  const updates = Array.isArray(req.body.updates) ? req.body.updates : [];
  for (const u of updates) { const old = P.stops.find(s => s.id === u.id); if (old && (u.checkin ?? old.checkin) > (u.checkout ?? old.checkout)) return res.status(400).json({ error: 'Checkout must follow checkin' }); }
  const affected = new Set();

  for (const u of updates) {
    const stop = P.stops.find(s => s.id === u.id);
    if (!stop) continue;
    const next = {
      checkin: u.checkin !== undefined ? u.checkin : stop.checkin,
      checkout: u.checkout !== undefined ? u.checkout : stop.checkout,
    };
    if (next.checkin === stop.checkin && next.checkout === stop.checkout) continue;
    stop.checkin = next.checkin;
    stop.checkout = next.checkout;
    affected.add(stop.id);

    const slot = slotOf(P, stop.id);
    if (slot) for (const cid of slot.candidateIds) {
      const sib = P.stops.find(s => s.id === cid);
      if (sib) { sib.checkin = stop.checkin; sib.checkout = stop.checkout; }
      affected.add(cid);
    }
  }

  rebuildDays(P);
  if (affected.size) resetDateSensitiveLodging(P, [...affected]);
  save(req.params.slug, data);
  res.json(data);

  if (affected.size) {
    for (const stopId of affected) {
      P.lodging.filter(l => l.stopId === stopId && isFetchableUrl(l.url))
        .forEach(l => queueLodgingEnrich(req.params.slug, l.id));
    }
    queueAvailabilityChecks(req.params.slug, [...affected]);
  }
});

// Add a parked candidate to a stop's slot. It stays parked until explicitly
// selected, so the current itinerary header does not jump to a blank place.
app.post(`${BASE}/api/stops/:id/candidates`, (req, res) => {
  const data = load(req.params.slug);
  const P = activePlan(data);
  const slot = slotOf(P, req.params.id);
  if (!slot) return res.status(404).json({ error: 'not found' });
  const active = P.stops.find(s => s.id === slot.activeStopId);
  const peer = { id: shortId(), place: '', checkin: active.checkin, checkout: active.checkout, lodgingNote: '' };
  for (const f of ['arriveBy', 'legCost']) if (active[f] !== undefined) peer[f] = active[f];
  P.stops.push(peer);
  slot.candidateIds.push(peer.id);
  rebuildDays(P);
  save(req.params.slug, data);
  res.json(data);
});

// Switch a slot's active candidate — the parked ones survive untouched.
app.put(`${BASE}/api/slots/:slotId/active`, (req, res) => {
  const data = load(req.params.slug);
  const P = activePlan(data);
  const slot = (P.slots || []).find(sl => sl.id === req.params.slotId);
  if (!slot) return res.status(404).json({ error: 'not found' });
  if (!slot.candidateIds.includes(req.body.stopId)) return res.status(404).json({ error: 'no such candidate' });
  const prev = P.stops.find(s => s.id === slot.activeStopId);
  const next = P.stops.find(s => s.id === req.body.stopId);
  // slot owns the dates: the incoming candidate inherits the current range
  if (prev && next) { next.checkin = prev.checkin; next.checkout = prev.checkout; }
  slot.activeStopId = req.body.stopId;
  rebuildDays(P);
  resetDateSensitiveLodging(P, [req.body.stopId]);
  save(req.params.slug, data);
  res.json(data);
  // the swapped-in place is now live for these dates — re-verify its options
  P.lodging.filter(l => l.stopId === req.body.stopId && isFetchableUrl(l.url))
    .forEach(l => queueLodgingEnrich(req.params.slug, l.id));
});

// Remove one candidate (and its lodging) from a slot. The slot itself survives.
app.delete(`${BASE}/api/slots/:slotId/candidates/:stopId`, (req, res) => {
  const data = load(req.params.slug);
  const P = activePlan(data);
  const slot = (P.slots || []).find(sl => sl.id === req.params.slotId);
  if (!slot || !slot.candidateIds.includes(req.params.stopId)) return res.status(404).json({ error: 'not found' });
  if (slot.candidateIds.length <= 1) return res.status(400).json({ error: 'cannot delete the only candidate — delete the stop instead' });
  slot.candidateIds = slot.candidateIds.filter(id => id !== req.params.stopId);
  if (slot.activeStopId === req.params.stopId) slot.activeStopId = slot.candidateIds[0];
  P.stops = P.stops.filter(s => s.id !== req.params.stopId);
  P.lodging = P.lodging.filter(l => l.stopId !== req.params.stopId);
  rebuildDays(P);
  save(req.params.slug, data);
  res.json(data);
});

// Deleting a stop removes its whole slot: every candidate and all their lodging.
app.delete(`${BASE}/api/stops/:id`, (req, res) => {
  const data = load(req.params.slug);
  const P = activePlan(data);
  const slot = slotOf(P, req.params.id);
  const doomed = slot ? slot.candidateIds : [req.params.id];
  P.slots = (P.slots || []).filter(sl => sl !== slot);
  P.stops = P.stops.filter(s => !doomed.includes(s.id));
  P.lodging = P.lodging.filter(l => !doomed.includes(l.stopId));
  rebuildDays(P);
  save(req.params.slug, data);
  res.json(data);
});

// Reorder slots (the client sends the ACTIVE stop ids in their new order).
// Dates are manual; dragging must never rewrite them.
app.put(`${BASE}/api/stops-order`, (req, res) => {
  const data = load(req.params.slug);
  const P = activePlan(data);
  const order = req.body.order || [];
  const act = activeStops(P);
  const activeIds = new Set(act.map(s => s.id));
  if (order.length !== act.length || new Set(order).size !== act.length || !order.every(id => activeIds.has(id))) {
    return res.status(400).json({ error: 'order must contain every active stop id exactly once' });
  }
  P.slots = order.map(id => slotOf(P, id));
  rebuildDays(P);
  save(req.params.slug, data);
  res.json(data);
});

// Reorder lodging within a stop: rewrite ranks to match the new order
app.put(`${BASE}/api/lodging-order`, (req, res) => {
  const data = load(req.params.slug);
  const P = activePlan(data);
  const { stopId, order } = req.body;
  const items = P.lodging.filter(l => l.stopId === stopId);
  if (!Array.isArray(order) || order.length !== items.length || new Set(order).size !== items.length || !order.every(id => items.some(l => l.id === id))) {
    return res.status(400).json({ error: 'order must contain every lodging id for this stop exactly once' });
  }
  order.forEach((id, i) => { P.lodging.find(l => l.id === id).rank = i + 1; });
  save(req.params.slug, data);
  res.json(data);
});

app.put(`${BASE}/api/days/:date`, (req, res) => {
  const data = load(req.params.slug);
  const P = activePlan(data);
  const day = P.days.find(d => d.date === req.params.date);
  if (!day) return res.status(404).json({ error: 'not found' });
  const { plan, workStatus } = req.body;
  if (plan !== undefined) day.plan = plan;
  if (workStatus !== undefined) day.workStatus = workStatus;
  save(req.params.slug, data);
  res.json(data);
});


function autoVerdict(item, config) {
  const bits = [];
  if (item.score != null && item.score !== '') {
    const s = Number(item.score);
    if (s >= 9.2) bits.push(`★${s} outstanding reviews`);
    else if (s >= 8.5) bits.push(`★${s} solid reviews`);
    else bits.push(`★${s} — below the 8.5 bar`);
  }
  if (item.pricePerNight != null && item.pricePerNight !== '') {
    const p = Number(item.pricePerNight);
    if (p === 0) bits.push('free');
    else if (p > config.budgetMax) bits.push(`€${p}/n over budget`);
    else if (p < config.budgetMin) bits.push(`€${p}/n under budget`);
    else bits.push(`€${p}/n in budget`);
  }
  const text = `${item.area || ''} ${item.notes || ''}`.toLowerCase();
  if (/walk|center|centro|altstadt|old town|promenade|via bafile/.test(text)) bits.push('walkable location ✓');
  if (/parking|garage/.test(text)) bits.push('parking ✓');
  if (/famil|kid|child|baby|toddler|playground|crib|cot/.test(text)) bits.push('family-friendly ✓');
  return bits.join(' · ');
}

// Lookup helpers used by async enrich/nearby jobs that resolve items by id.
function allLodging(d) { return d.lodging || []; }
function findLodging(d, id) { return (d.lodging || []).find(l => l.id === id) || null; }
function findStop(d, id) { return (d.stops || []).find(s => s.id === id) || null; }
function planOfLodging(d) { return d; }

// A URL is fetchable only if it's a real http(s) URL with a hostname —
// guards against corrupt pastes (e.g. ".e-8184017829…") that can never resolve.
function isFetchableUrl(u) {
  try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') && /\./.test(x.hostname); }
  catch (e) { return false; }
}


function hasPriceValue(v) {
  return v !== null && v !== undefined && v !== '';
}

function normalizeLodgingPrices(item, stop) {
  if (item.pricePerNight === '') item.pricePerNight = null;
  if (item.totalPrice === '') item.totalPrice = null;
  if (hasPriceValue(item.pricePerNight)) item.pricePerNight = Math.round(Number(item.pricePerNight));
  if (hasPriceValue(item.totalPrice)) item.totalPrice = Math.round(Number(item.totalPrice));
  const nights = stop?.checkin && stop?.checkout
    ? Math.max(1, Math.round((Date.parse(stop.checkout) - Date.parse(stop.checkin)) / 864e5))
    : 0;
  if (!Number.isFinite(item.pricePerNight)) item.pricePerNight = null;
  if (!Number.isFinite(item.totalPrice)) item.totalPrice = null;
  if (!hasPriceValue(item.pricePerNight) && hasPriceValue(item.totalPrice) && nights > 0) {
    item.pricePerNight = Math.round(Number(item.totalPrice) / nights);
  }
  if (!hasPriceValue(item.totalPrice) && hasPriceValue(item.pricePerNight) && nights > 0) {
    item.totalPrice = Math.round(Number(item.pricePerNight) * nights);
  }
  if (hasPriceValue(item.pricePerNight) || hasPriceValue(item.totalPrice)) item.priceUnavailable = false;
}


// Manual prices survive candidate swaps; date changes mark them for review.
function resetDateSensitiveLodging(P, ids) {
  for (const l of P.lodging || []) if (ids.includes(l.stopId)) {
    l.availability = 'unknown';
    delete l.lastCheck;
    l.priceNeedsReview = true;
  }
}
function queueLodgingEnrich() {}
function queueAvailabilityChecks() {}

app.post(`${BASE}/api/lodging`, (req, res) => {
  const data = load(req.params.slug);
  const P = activePlan(data);
  const item = {
    id: crypto.randomUUID().slice(0, 8),
    stopId: '', name: '', url: '', pricePerNight: null, totalPrice: null, priceUnavailable: false,
    score: null, area: '', notes: '', verdict: '', rank: null, status: 'idea',
    ...req.body,
  };
  const stop = findStop(data, item.stopId);
  normalizeLodgingPrices(item, stop);
  if (!item.verdict) item.verdict = autoVerdict(item, data.config);
  if (item.status === 'booked') P.lodging.forEach(l => { if (l.stopId === item.stopId && l.status === 'booked') l.status = 'shortlist'; });
  P.lodging.push(item);
  save(req.params.slug, data);
  res.json(data);
});

app.put(`${BASE}/api/lodging/:id`, (req, res) => {
  const data = load(req.params.slug);
  const item = findLodging(data, req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (req.body.status === 'booked' && item.availability === 'unavailable') {
    return res.status(409).json({ error: 'this option is marked unavailable for your dates' });
  }
  const totalChanged = req.body.totalPrice !== undefined && req.body.totalPrice !== item.totalPrice;
  const nightlyChanged = req.body.pricePerNight !== undefined && req.body.pricePerNight !== item.pricePerNight;
  Object.assign(item, req.body);
  if (totalChanged) item.pricePerNight = null;
  else if (nightlyChanged) item.totalPrice = null;
  const stop = findStop(data, item.stopId);
  normalizeLodgingPrices(item, stop);
  if (!item.verdict) item.verdict = autoVerdict(item, data.config);
  // Only one booked option per stop (within the plan that owns this lodging)
  if (req.body.status === 'booked') {
    (planOfLodging(data, item.id).lodging || []).forEach(l => {
      if (l.stopId === item.stopId && l.id !== item.id && l.status === 'booked') l.status = 'shortlist';
    });
  }
  save(req.params.slug, data);
  res.json(data);

});


app.post(`${BASE}/api/costs`, (req, res) => {
  const data = load(req.params.slug);
  const P = activePlan(data);
  P.costs = P.costs || [];
  const item = { id: crypto.randomUUID().slice(0, 8), label: '', amount: 0, notes: '', ...req.body };
  P.costs.push(item);
  save(req.params.slug, data);
  res.json(data);
});

app.put(`${BASE}/api/costs/:id`, (req, res) => {
  const data = load(req.params.slug);
  const P = activePlan(data);
  const item = (P.costs || []).find(c => c.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  Object.assign(item, req.body);
  save(req.params.slug, data);
  res.json(data);
});

app.delete(`${BASE}/api/costs/:id`, (req, res) => {
  const data = load(req.params.slug);
  const P = activePlan(data);
  P.costs = (P.costs || []).filter(c => c.id !== req.params.id);
  save(req.params.slug, data);
  res.json(data);
});

app.delete(`${BASE}/api/lodging/:id`, (req, res) => {
  const data = load(req.params.slug);
  const P = planOfLodging(data, req.params.id);
  P.lodging = (P.lodging || []).filter(l => l.id !== req.params.id);
  save(req.params.slug, data);
  res.json(data);
});


const OFFER_NESTED = ['resort', 'urls', 'price', 'includes', 'reviews', 'climate'];
function mergeOffer(item, body) {
  for (const [key, value] of Object.entries(body)) {
    if (OFFER_NESTED.includes(key) && value && typeof value === 'object' && !Array.isArray(value) && item[key] && typeof item[key] === 'object') {
      Object.assign(item[key], value);
    } else {
      item[key] = value;
    }
  }
}

app.post(`${BASE}/api/offers`, (req, res) => {
  const data = load(req.params.slug);
  data.offers = data.offers || [];
  const offer = {
    id: crypto.randomUUID().slice(0, 8),
    kind: 'package', source: '', departureId: null,
    checkin: '', nights: 7,
    board: '', verdict: '', rank: null, status: 'idea', favorite: false,
    availability: 'unknown', notes: '',
    priceMatrix: [],
    ...req.body,
    resort: { name: '', destination: '', country: '', stars: null, photos: [], ...(req.body.resort || {}) },
    urls: { offer: '', hotel: '', flight: '', ...(req.body.urls || {}) },
    price: { total: null, currency: 'EUR', includesFlight: true, includesTransfer: true, ...(req.body.price || {}) },
    includes: { ...(req.body.includes || {}) },
    reviews: { ...(req.body.reviews || {}) },
  };
  if (offer.status === 'booked') data.offers.forEach(o => { if (o.status === 'booked') o.status = 'shortlist'; });
  data.offers.push(offer);
  save(req.params.slug, data);
  res.json(data);

});

app.put(`${BASE}/api/offers/:id`, (req, res) => {
  const data = load(req.params.slug);
  const item = (data.offers || []).find(o => o.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (req.body.status === 'booked' && item.availability === 'unavailable') {
    return res.status(409).json({ error: 'this offer is marked unavailable' });
  }
  mergeOffer(item, req.body);
  // one selected offer per trip
  if (req.body.status === 'booked') {
    data.offers.forEach(o => { if (o.id !== item.id && o.status === 'booked') o.status = 'shortlist'; });
  }
  save(req.params.slug, data);
  res.json(data);
});

app.delete(`${BASE}/api/offers/:id`, (req, res) => {
  const data = load(req.params.slug);
  data.offers = (data.offers || []).filter(o => o.id !== req.params.id);
  save(req.params.slug, data);
  res.json(data);
});

app.put(`${BASE}/api/offers-order`, (req, res) => {
  const data = load(req.params.slug);
  const order = req.body.order || [];
  const offers = data.offers || [];
  if (order.length !== offers.length || new Set(order).size !== offers.length || !order.every(id => offers.some(o => o.id === id))) {
    return res.status(400).json({ error: 'order must contain every offer id exactly once' });
  }
  order.forEach((id, i) => { offers.find(o => o.id === id).rank = i + 1; });
  save(req.params.slug, data);
  res.json(data);
});


app.post(`${BASE}/api/departures`, (req, res) => {
  const data = load(req.params.slug);
  data.departures = data.departures || [];
  data.departures.push({ id: crypto.randomUUID().slice(0, 8), city: '', airport: '', driveKm: 0, parkingPerDay: 0, notes: '', ...req.body });
  save(req.params.slug, data);
  res.json(data);
});

app.put(`${BASE}/api/departures/:id`, (req, res) => {
  const data = load(req.params.slug);
  const item = (data.departures || []).find(d => d.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  Object.assign(item, req.body);
  save(req.params.slug, data);
  res.json(data);
});

app.delete(`${BASE}/api/departures/:id`, (req, res) => {
  const data = load(req.params.slug);
  data.departures = (data.departures || []).filter(d => d.id !== req.params.id);
  save(req.params.slug, data);
  res.json(data);
});

// Regenerate nearby places for one lodging item (also used as backfill target)

async function placesRequest(endpoint, options = {}) {
  const response = await fetch('https://places.googleapis.com/v1/' + endpoint, {
    ...options, signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_KEY, ...options.headers },
  });
  if (!response.ok) throw new Error('Place lookup unavailable');
  return response.json();
}
async function legacyPlaces(type, params) {
  const query = new URLSearchParams({ ...params, key: PLACES_KEY });
  const response = await fetch('https://maps.googleapis.com/maps/api/place/' + type + '/json?' + query, { signal: AbortSignal.timeout(8000) });
  const result = await response.json();
  if (!response.ok || !['OK', 'ZERO_RESULTS'].includes(result.status)) throw new Error('Place lookup unavailable');
  return result;
}
app.get(`${BASE}/api/places/autocomplete`, async (req, res) => {
  if (!NETWORK || !PLACES_KEY) return res.json([]);
  const q = String(req.query.q || '').trim();
  if (q.length < 3 || q.length > 200) return res.json([]);
  const token = String(req.query.session || '').slice(0, 80);
  try {
    if (PLACES_LEGACY) {
      const result = await legacyPlaces('autocomplete', { input: q, types: 'geocode', ...(token ? { sessiontoken: token } : {}) });
      return res.json((result.predictions || []).slice(0, 6).map(p => ({ description: p.description, placeId: p.place_id })));
    }
    const result = await placesRequest('places:autocomplete', { method: 'POST', body: JSON.stringify({ input: q, ...(token ? {sessionToken: token} : {}) }) });
    res.json((result.suggestions || []).filter(s => s.placePrediction).slice(0, 6).map(s => ({ description: s.placePrediction.text.text, placeId: s.placePrediction.placeId })));
  } catch { res.status(502).json({ error: 'Place suggestions unavailable. Enter coordinates manually.' }); }
});
app.get(`${BASE}/api/places/details`, async (req, res) => {
  if (!NETWORK || !PLACES_KEY) return res.status(501).json({ error: 'Enter coordinates manually; place lookup is not configured.' });
  const id = String(req.query.placeId || '');
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(id)) return res.status(400).json({ error: 'Select a place suggestion first.' });
  const token = String(req.query.session || '').slice(0, 80);
  try {
    if (PLACES_LEGACY) {
      const { result: place } = await legacyPlaces('details', { place_id: id, fields: 'name,geometry,formatted_address', ...(token ? { sessiontoken: token } : {}) });
      return res.json({ name: place.name, lat: place.geometry.location.lat, lng: place.geometry.location.lng, address: place.formatted_address || '' });
    }
    const place = await placesRequest('places/' + encodeURIComponent(id) + (token ? '?sessionToken=' + encodeURIComponent(token) : ''), { headers: { 'X-Goog-FieldMask': 'displayName,location,formattedAddress' } });
    res.json({ name: place.displayName?.text || '', lat: place.location.latitude, lng: place.location.longitude, address: place.formattedAddress || '' });
  } catch { res.status(502).json({ error: 'Place lookup unavailable. Enter coordinates manually.' }); }
});
app.use(`${BASE}/api`, (req, res) => res.status(501).json({ error: 'Online research and assistant automation are not included. Enter details manually and verify prices with the provider.' }));

app.use(`${BASE}`, express.static(path.join(__dirname, 'public'), {
  // Only this asset directory is served. Runtime data stays outside it.
  setHeaders: res => res.set('Cache-Control', 'no-cache, must-revalidate'),
}));

// --- Session index: list existing trips, create new ones ---
function listSlugs() {
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && SLUG_RE.test(f.slice(0, -5)) && !fs.lstatSync(path.join(DATA_DIR, f)).isSymbolicLink())
    .map(f => f.slice(0, -5));
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDay(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}
function fmtRange(from, to) {
  if (!from && !to) return '';
  const fy = from?.slice(0, 4), ty = to?.slice(0, 4);
  const yr = ty || fy;
  return `${fmtDay(from)}${to ? ` – ${fmtDay(to)}` : ''}${yr ? ` ${yr}` : ''}`;
}

function cloneTrip(sourceSlug, targetSlug) {
  if (!SLUG_RE.test(sourceSlug) || !SLUG_RE.test(targetSlug) || targetSlug === 'trip') {
    throw new Error('invalid slug');
  }
  if (!fs.existsSync(dataFile(sourceSlug))) throw new Error('source not found');
  if (fs.existsSync(dataFile(targetSlug))) throw new Error('target exists');
  const data = load(sourceSlug);
  data.rev = 0;
  data.clonedFrom = sourceSlug;
  data.clonedAt = new Date().toISOString();
  if (data.config) data.config.tripName = `${data.config.tripName || sourceSlug} variation`;
  if (Array.isArray(data.researchJobs)) data.researchJobs = [];
  fs.writeFileSync(dataFile(targetSlug), JSON.stringify(data, null, 2), { mode: 0o600 });
  log('cloned session', sourceSlug, '→', targetSlug);
}

// Build a card summary from a trip's data file (best-effort; never throws)
function tripSummary(slug) {
  let d;
  try { d = load(slug); } catch (e) { return { slug, broken: true }; }
  const c = d.config || {};
  const type = c.type === 'package' ? 'package' : 'roadtrip';
  const title = c.tripName && c.tripName !== slug ? c.tripName : slug;
  const mtime = fs.statSync(dataFile(slug)).mtime;

  if (type === 'package') {
    const offers = d.offers || [];
    const booked = offers.find(o => o.status === 'booked');
    const dest = booked?.resort?.destination || offers[0]?.resort?.destination || '';
    return {
      slug, type, title, mtime,
      meta: dest ? esc(dest) : 'no destination yet',
      dates: booked?.checkin ? fmtRange(booked.checkin) : '',
      stat: `${offers.length} offer${offers.length === 1 ? '' : 's'}`,
      booked: booked ? esc(booked.resort?.name || 'selected') : null,
      thumb: null,
    };
  }
  const stops = activeStops(d);
  const places = stops.map(s => s.place).filter(Boolean);
  const from = stops.map(s => s.checkin).filter(Boolean).sort()[0];
  const to = stops.map(s => s.checkout).filter(Boolean).sort().slice(-1)[0];
  const bookedCount = (d.lodging || []).filter(l => l.status === 'booked').length;
  return {
    slug, type, title, mtime,
    meta: places.length ? esc(places.join(' → ')) : 'no stops yet',
    dates: fmtRange(from, to),
    stat: `${stops.length} stop${stops.length === 1 ? '' : 's'}`,
    booked: bookedCount ? `${bookedCount} selected` : null,
    thumb: null,
  };
}

function tripCard(t) {
  if (t.broken) {
    return `<div class="trip-card broken"><a class="tc-main" href="/${t.slug}/"><div class="tc-body"><div class="tc-title">${esc(t.slug)}</div><div class="tc-meta">⚠️ unreadable</div></div></a></div>`;
  }
  const badge = t.type === 'package' ? '🏖 Package' : '🚗 Road trip';
  return `
    <div class="trip-card ${t.type}">
      <a class="tc-main" href="/${t.slug}/">
        <div class="tc-thumb"${t.thumb ? ` style="background-image:url('${esc(t.thumb)}')"` : ''}>
          <span class="tc-badge">${badge}</span>
          ${t.thumb ? '' : `<span class="tc-emoji">${t.type === 'package' ? '🏖' : '🗺️'}</span>`}
        </div>
        <div class="tc-body">
          <div class="tc-title">${esc(t.title)}</div>
          <div class="tc-meta">${t.meta}</div>
          <div class="tc-foot">
            ${t.dates ? `<span class="tc-dates">📅 ${t.dates}</span>` : ''}
            <span class="tc-stat">${t.stat}</span>
            ${t.booked ? `<span class="tc-booked">✓ ${t.booked}</span>` : ''}
          </div>
        </div>
      </a>
      <form class="tc-actions" method="POST" action="/clone" data-clone-source="${esc(t.slug)}">
        <input type="hidden" name="source" value="${esc(t.slug)}">
        <input type="hidden" name="slug" value="">
        <button type="submit">Clone</button>
      </form>
    </div>`;
}

app.get('/', (req, res) => {
  const trips = listSlugs().map(tripSummary).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const cards = trips.map(tripCard).join('\n');
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Trip Planner</title>
  <style>
    :root { --bg:#f6f5f2; --card:#fff; --ink:#1f2430; --muted:#8a8f9c; --line:#e4e2dc; --accent:#2563eb; --green:#16a34a; --radius:12px; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--ink); }
    header { background:var(--ink); color:#fff; padding:26px 20px; }
    header .wrap { max-width:1100px; margin:0 auto; display:flex; align-items:baseline; justify-content:space-between; gap:16px; flex-wrap:wrap; }
    header h1 { margin:0; font-size:1.4rem; font-weight:700; letter-spacing:-0.02em; }
    header h1 .globe { opacity:.9; }
    header p { margin:4px 0 0; font-size:.9rem; opacity:.7; }
    header .count { font-size:.85rem; opacity:.65; white-space:nowrap; }
    main { max-width:1100px; margin:0 auto; padding:24px 20px 60px; }

    .grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); }
    .trip-card {
      display:flex; flex-direction:column; background:var(--card); border:1px solid var(--line);
      border-radius:var(--radius); overflow:hidden; color:inherit;
      transition:transform .12s ease, box-shadow .12s ease;
    }
    .trip-card:hover { transform:translateY(-2px); box-shadow:0 8px 24px rgba(0,0,0,.1); border-color:#d7d3ca; }
    .tc-main { display:flex; flex-direction:column; flex:1; text-decoration:none; color:inherit; }
    .tc-thumb {
      height:96px; background-size:cover; background-position:center; position:relative;
      display:flex; align-items:center; justify-content:center;
      background-color:#eef1f6;
    }
    .trip-card.package .tc-thumb { background-color:#fef3e8; }
    .tc-emoji { font-size:2.4rem; opacity:.4; }
    .tc-badge {
      position:absolute; top:8px; left:8px; background:rgba(255,255,255,.92); color:var(--ink);
      font-size:.7rem; font-weight:700; border-radius:999px; padding:3px 9px; box-shadow:0 1px 3px rgba(0,0,0,.15);
    }
    .tc-body { padding:12px 14px; display:flex; flex-direction:column; gap:4px; flex:1; }
    .tc-title { font-weight:700; font-size:1.02rem; line-height:1.25; }
    .tc-meta { color:var(--muted); font-size:.85rem; line-height:1.35; flex:1; }
    .tc-foot { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:center; margin-top:6px; font-size:.78rem; }
    .tc-dates { color:var(--ink); font-weight:600; }
    .tc-stat { color:var(--muted); }
    .tc-booked { color:var(--green); font-weight:600; }
    .tc-actions { display:flex; justify-content:flex-end; padding:0 12px 12px; }
    .tc-actions button {
      border:1px solid var(--line); background:var(--card); color:var(--muted);
      border-radius:7px; padding:6px 10px; font:inherit; font-size:.78rem; font-weight:650; cursor:pointer;
    }
    .tc-actions button:hover { border-color:var(--accent); color:var(--accent); background:#eef4ff; }
    .trip-card.broken { opacity:.6; }

    .new-card {
      display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px;
      border:2px dashed var(--line); border-radius:var(--radius); background:transparent;
      min-height:180px; cursor:pointer; color:var(--muted); padding:16px;
    }
    .new-card:hover { border-color:var(--accent); color:var(--accent); }
    .new-card .plus { font-size:1.8rem; line-height:1; }
    dialog { border:none; border-radius:var(--radius); padding:0; box-shadow:0 20px 60px rgba(0,0,0,.3); max-width:92vw; }
    dialog::backdrop { background:rgba(31,36,48,.45); }
    .modal { padding:22px; width:360px; max-width:88vw; }
    .modal h2 { margin:0 0 4px; font-size:1.1rem; }
    .modal p { margin:0 0 16px; color:var(--muted); font-size:.85rem; }
    .modal label { display:block; font-size:.78rem; font-weight:600; color:var(--muted); margin:12px 0 4px; text-transform:uppercase; letter-spacing:.04em; }
    .modal input, .modal select { width:100%; font:inherit; padding:9px 11px; border:1px solid var(--line); border-radius:8px; }
    .modal input:focus, .modal select:focus { outline:none; border-color:var(--accent); }
    .type-toggle { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .type-toggle label { margin:0; cursor:pointer; }
    .type-toggle input { display:none; }
    .type-toggle span {
      display:block; text-align:center; padding:12px 8px; border:1px solid var(--line);
      border-radius:8px; font-weight:600; font-size:.9rem; color:var(--ink); text-transform:none; letter-spacing:0;
    }
    .type-toggle input:checked + span { border-color:var(--accent); background:#eef4ff; color:var(--accent); }
    .modal .actions { display:flex; gap:8px; justify-content:flex-end; margin-top:20px; }
    .modal button { font:inherit; padding:9px 16px; border-radius:8px; border:1px solid var(--line); background:var(--card); cursor:pointer; }
    .modal button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
    .empty { text-align:center; color:var(--muted); padding:40px 0; }
  </style>
<script src="/assets/home.js" defer></script>
</head>
<body>
  <header>
    <div class="wrap">
      <div>
        <h1><span class="globe">🌍</span> Trip Planner</h1>
        <p>Road trips & resort packages — plan routes and compare stays.</p>
      </div>
      <div class="count">${trips.length} trip${trips.length === 1 ? '' : 's'}</div>
    </div>
  </header>
  <main>
    <div class="grid">
      <button class="new-card" data-new-trip>
        <span class="plus">＋</span>
        <span>New trip</span>
      </button>
      ${cards || '<div class="empty">No trips yet — create your first one.</div>'}
    </div>
  </main>

  <dialog id="new-dialog">
    <form class="modal" method="POST" action="/">
      <h2>New trip</h2>
      <p>Pick a type and a short name.</p>
      <div class="type-toggle">
        <label><input type="radio" name="type" value="roadtrip" checked><span>🚗 Road trip<br><small style="font-weight:400;color:var(--muted)">cities, stops, day plans</small></span></label>
        <label><input type="radio" name="type" value="package"><span>🏖 Package<br><small style="font-weight:400;color:var(--muted)">resort & flight deals</small></span></label>
      </div>
      <label for="slug-input">Trip name (URL slug)</label>
      <input id="slug-input" name="slug" placeholder="vienna-city-break" pattern="[a-z0-9\\-]+" required autofocus>
      <div class="actions">
        <button type="button" data-close-dialog>Cancel</button>
        <button type="submit" class="primary">Create trip</button>
      </div>
    </form>
  </dialog>
  <dialog id="clone-dialog">
    <form class="modal" method="POST" action="/clone">
      <h2>Clone trip</h2>
      <p>Keep this plan and create an independent copy.</p>
      <input type="hidden" name="source">
      <label for="clone-slug">New trip name (URL slug)</label>
      <input id="clone-slug" name="slug" pattern="[a-z0-9\\-]+" maxlength="80" required>
      <div class="actions"><button type="button" data-close-dialog>Cancel</button><button type="submit" class="primary">Create copy</button></div>
    </form>
  </dialog>
</body>
</html>`);
});

app.post('/', (req, res) => {
  const slug = String(req.body.slug || '').trim();
  const type = req.body.type === 'package' ? 'package' : 'roadtrip';
  if (!SLUG_RE.test(slug) || slug === 'trip') {
    return res.status(400).send('Invalid slug: lowercase letters, digits and hyphens only');
  }
  if (!fs.existsSync(dataFile(slug))) {
    fs.writeFileSync(dataFile(slug), JSON.stringify(skeleton(slug, type), null, 2), { mode: 0o600 });
    log('created session', slug, `(${type})`);
  }
  res.redirect(`/${slug}/`);
});

app.post('/clone', (req, res) => {
  const source = String(req.body.source || '').trim();
  const slug = String(req.body.slug || '').trim().toLowerCase();
  try {
    cloneTrip(source, slug);
    res.redirect(`/${slug}/`);
  } catch (e) {
    res.status(400).send(`Clone failed: ${esc(e.message)}`);
  }
});


app.use((err, req, res, next) => {
  res.status(err.status === 413 ? 413 : 400).json({ error: 'Request could not be saved. Check the input and retry.' });
});
const server = app.listen(PORT, '127.0.0.1', () => console.log(`Trip Dashboard: http://127.0.0.1:${server.address().port}/`));
