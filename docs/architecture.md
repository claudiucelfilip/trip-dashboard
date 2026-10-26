# Architecture and contributor guide

The app uses [Express](https://expressjs.com/en/starter/installing/) and plain browser JavaScript. There is no compilation step, database server, cloud account or AI dependency. [Leaflet](https://leafletjs.com) supplies the map UI.

## Source and state

| Location | Purpose |
| --- | --- |
| `server.js` | Local HTTP server, trip persistence, input checks and CRUD API |
| `public/app.js` | Itinerary, lodging, map, package scoring and budget UI |
| `public/style.css` | Responsive presentation |
| `public/vendor/` | Leaflet and its license |
| `demo/` | Two wholly synthetic starting trips; never a runtime data directory |
| `test/app.test.js` | HTTP behavior, persistence and privacy tests |
| `TRIP_DATA_DIR` | Private runtime JSON files, outside the repo by default |

Each trip is one `<slug>.json` file. Saves write a temporary file and rename it into place. Revisions let open pages detect saved changes. Run one server process for each data directory; there is no multi-process locking or conflict resolution.

A road trip contains `config`, `slots`, `stops`, `lodging`, `days` and `costs`. Each slot owns a date range and a set of candidate stop IDs; one candidate is active. Switching candidates preserves the other stops and their lodging. Days, routes and budgets use active candidates only. Slot date edits propagate to siblings. Existing manual lodging prices remain as estimates marked for review after a date change or swap.

A package trip contains `config`, `departures`, `offers` and `costs`. The selected offer supplies the headline price. Door-to-door totals add estimated round-trip fuel, airport parking for the stay plus one day, and extra costs. Weighted scores are a transparent comparison aid derived from entered data, not a provider rating or recommendation.

## HTTP surface

All API endpoints are under `/<slug>/api/`. Unknown trips return 404. Only files under `public/` are served as static assets.

| Routes | Behavior |
| --- | --- |
| `GET /` and `POST /` | Trip index and new trip form |
| `POST /clone` | Independent copy; rejects collisions |
| `GET data`, `GET rev`, `PUT config` | Trip state, revision and settings |
| `POST stops`, `PUT/DELETE stops/:id` | Stop management |
| `PUT stops-dates`, `PUT stops-order` | Batch dates and slot order |
| `POST stops/:id/candidates` | Park a new alternative |
| `PUT slots/:slotId/active` | Swap active candidate |
| `DELETE slots/:slotId/candidates/:stopId` | Remove one alternative |
| `PUT days/:date` | Save a day plan or work/day-off status |
| `POST lodging`, `PUT/DELETE lodging/:id`, `PUT lodging-order` | Manual lodging comparisons |
| `POST costs`, `PUT/DELETE costs/:id` | Extra budget items |
| `POST offers`, `PUT/DELETE offers/:id`, `PUT offers-order` | Package offers |
| `POST departures`, `PUT/DELETE departures/:id` | Departure estimates |
| `GET places/autocomplete` | Empty suggestions; place names remain editable |
| Other API routes | 501 with an explanation; research/chat workers are not included |

JSON requests are limited to 256 KB. IDs are server managed, slugs are bounded, link schemes and date inputs are checked, and duplicate reorder IDs are rejected. Cross-site writes and non-local Host headers are rejected. Errors exclude request bodies, file paths and integration credentials.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
npm audit --omit=dev
```

Tests start a real HTTP server with isolated temporary state and synthetic fixtures. CI runs the same checks on Node 22 and 24. No tests contact travel providers. For manual validation, use the demo: select a lodging card, swap the coastal alternative, save a day plan, reload, clone a trip, and compare package dates and totals.

To set a starting point or other settings without a dedicated form, use `PUT /<slug>/api/config` with JSON such as `{"home":{"name":"Starting point","lat":40,"lng":-8}}`. Coordinates for individual stops are editable in the UI. A new blank trip has no starting coordinates and therefore no home leg until configured.
