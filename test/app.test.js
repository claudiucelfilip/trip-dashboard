const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
let server, base, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-test-'));
  const env = { PATH: process.env.PATH, HOME: os.homedir(), PORT: '0', TRIP_DEMO: '1', TRIP_DATA_DIR: dir };
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    server.stdout.on('data', b => { const m = b.toString().match(/http:\/\/127.0.0.1:\d+/); if (m) resolve(m[0]); });
    server.once('exit', code => reject(new Error(`Server exited: ${code}`)));
    server.once('error', reject);
  });
});
after(async () => { if (server) { server.kill(); await new Promise(r => server.once('exit', r)); } fs.rmSync(dir, { recursive: true, force: true }); });
async function api(method, route, body, headers = {}) {
  const res = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  return { status: res.status, headers: res.headers, body: await res.text() };
}
const trip = '/coast-demo/api';
test('demo is synthetic, private runtime files are outside static assets', async () => {
  const r = await api('GET', trip + '/data');
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.config.demo, true);
  assert.equal(d.config.capabilities.network, false);
  assert.equal(d.config.mapsKey, undefined);
  for (const file of ['data/coast-demo.json','server.js','.env','context/memory.md','antalya-resorts.html','../data.json']) {
    const r = await api('GET', '/coast-demo/' + file);
    assert.notEqual(r.status, 200, file);
  }
});
test('swapping a candidate preserves peer lodging and persists across reads', async () => {
  let r = await api('PUT', trip + '/slots/coast/active', { stopId: 'tavira' });
  assert.equal(r.status, 200);
  let d = JSON.parse(r.body);
  assert.equal(d.slots[1].activeStopId, 'tavira');
  assert.ok(d.lodging.some(l => l.stopId === 'lagos'));
  assert.equal(d.days.find(d => d.date === '2027-05-12').sleep, 'Tavira');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'coast-demo.json'))).slots[1].activeStopId, 'tavira');
  assert.equal(JSON.parse((await api('GET', trip + '/data')).body).slots[1].activeStopId, 'tavira');
});
test('batch dates propagate to peers without erasing manual prices', async () => {
  const r = await api('PUT', trip + '/stops-dates', { updates: [{ id: 'tavira', checkin: '2027-05-12', checkout: '2027-05-16' }] });
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.stops.find(s => s.id === 'lagos').checkout, '2027-05-16');
  assert.equal(d.lodging.find(l => l.id === 'stay2').totalPrice, 390);
  assert.equal(d.lodging.find(l => l.id === 'stay2').priceNeedsReview, true);
});
test('invalid or reversed dates cannot mutate stored state', async () => {
  const before = fs.readFileSync(path.join(dir, 'coast-demo.json'), 'utf8');
  for (const payload of [{ checkout: '2027-02-31' }, { checkin: '2027-06-10', checkout: '2027-06-01' }, { checkout: '2999-01-01' }]) {
    assert.equal((await api('PUT', trip + '/stops/evora', payload)).status, 400);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'coast-demo.json'), 'utf8'), before);
});
test('unsafe links, injected numbers, ID overwrite and prototype keys are rejected', async () => {
  for (const payload of [{ url: 'javascript:alert(1)' }, { url: 'https://user:pass@example.com' }, { pricePerNight: '<img src=x onerror=alert(1)>' }, { id: 'other' }, JSON.parse('{"__proto__":{"polluted":true}}')]) {
    assert.equal((await api('PUT', trip + '/lodging/stay0', payload)).status, 400);
  }
  assert.equal({}.polluted, undefined);
});
test('cross-site writes and rebinding hosts are rejected', async () => {
  assert.equal((await api('POST', '/', { slug: 'bad' }, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await api('POST', '/', { slug: 'bad' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const status = await new Promise((resolve, reject) => { const req = require('node:http').get(base, { headers: { Host: 'example.com' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(status, 403);
});
test('cloning produces independent trips and rejects collisions/traversal', async () => {
  assert.equal((await api('POST', '/clone', { source: 'coast-demo', slug: 'variation' })).status, 302);
  assert.equal((await api('PUT', '/variation/api/config', { tripName: 'Independent copy' })).status, 200);
  assert.equal(JSON.parse((await api('GET', trip + '/data')).body).config.tripName, 'The coast, two ways');
  assert.equal((await api('POST', '/clone', { source: 'coast-demo', slug: 'variation' })).status, 400);
  assert.equal((await api('POST', '/', { slug: '../outside' })).status, 400);
});
test('lodging selection is exclusive and zero-cost stays remain valid', async () => {
  const r = await api('PUT', trip + '/lodging/stay1', { status: 'booked', pricePerNight: 0, totalPrice: 0 });
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.lodging.find(l => l.id === 'stay0').status, 'shortlist');
  assert.equal(d.lodging.find(l => l.id === 'stay1').totalPrice, 0);
});
test('orders must contain unique complete IDs', async () => {
  assert.equal((await api('PUT', trip + '/lodging-order', { stopId: 'evora', order: ['stay0','stay0'] })).status, 400);
  assert.equal((await api('PUT', '/package-demo/api/offers-order', { order: ['offer0','offer0','offer0'] })).status, 400);
});
test('package selection keeps other offers and nested price configuration', async () => {
  const r = await api('PUT', '/package-demo/api/offers/offer1', { status: 'booked', price: { total: 1700 } });
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.offers[0].status, 'shortlist');
  assert.equal(d.offers[1].price.currency, 'EUR');
});
test('research and chat fail honestly without invoking accounts or fetching URLs', async () => {
  for (const route of ['/chat','/jobs','/lodging/stay0/check','/lodging/stay0/enrich','/lodging/stay0/nearby','/offers/offer0/enrich','/lodging-search']) {
    const r = await api('POST', trip + route, { message: 'Synthetic test' });
    assert.equal(r.status, 501, route);
    assert.match(JSON.parse(r.body).error, /not included/);
  }
});
test('manual price edits recalculate the other price field', async () => {
  const r = await api('PUT', trip + '/lodging/stay0', { totalPrice: 260, pricePerNight: 95 });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).lodging.find(l => l.id === 'stay0').pricePerNight, 130);
});
test('day plans persist as text without changing unrelated dates', async () => {
  assert.equal((await api('PUT', trip + '/days/2027-05-10', { plan: 'A synthetic museum visit' })).status, 200);
  const d = JSON.parse((await api('GET', trip + '/data')).body);
  assert.equal(d.days[0].plan, 'A synthetic museum visit');
});
test('unsafe scoring weights are rejected before saving', async () => {
  assert.equal((await api('PUT', '/package-demo/api/config', { weights: { price: '" onfocus="alert(1)' } })).status, 400);
});
test('optional authentication has no default password', async () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-auth-test-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, HOME: os.homedir(), PORT: '0', TRIP_DATA_DIR: authDir, TRIP_USER: 'demo-user', TRIP_PASS: 'synthetic:passphrase' }, stdio: ['ignore','pipe','pipe'] });
  try {
    const url = await new Promise((resolve, reject) => { child.stdout.on('data', b => { const m = b.toString().match(/http:\/\/127.0.0.1:\d+/); if (m) resolve(m[0]); }); child.once('error', reject); child.once('exit', () => reject(new Error('Auth server failed'))); });
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from('demo-user:synthetic:passphrase').toString('base64') } })).status, 200);
    assert.equal((await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from('demo-user:wrong').toString('base64') } })).status, 401);
  } finally { child.kill(); await new Promise(r => child.once('exit', r)); fs.rmSync(authDir, { recursive: true, force: true }); }
});
