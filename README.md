# Trip Dashboard

Plan a trip without throwing away the alternatives. Compare places and stays, swap one stop at a time, and see how each choice changes the route and budget.

![A synthetic road trip with lodging choices, interchangeable coastal stops and a running budget](docs/screenshots/roadtrip.jpg)

A local planner for road trips and package holidays. Runs with [Node.js](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm/) and a browser; the demo needs no account, API key or AI subscription. All property names, prices and travel plans shown here are synthetic examples.

## Plan, compare, decide

- **Keep several trips.** Create road trips or package comparisons, then clone a trip to explore a separate version.
- **Swap a stop, keep its alternatives.** Try a different coastal town for the same dates. Each candidate keeps its own lodging, and parked places stay out of the active route and budget.
- **Compare stays in context.** Keep prices, notes, favorites and rankings under the stop they belong to. Select one stay per stop; a different choice updates the total.
- **Build a day-by-day plan.** Edit stop dates together, save daily notes, mark days off and choose how to travel each leg. Reorder stops without changing their dates.
- **See the whole budget.** Selected lodging, estimated fuel, manual transport costs and extras feed one running total. The offline map shows the active route as a schematic.
- **Compare package holidays.** Look beyond the headline price: include airport access, parking and extras, compare entered date/price options, and adjust comparison weights.

![Synthetic package offers with door-to-door totals and comparison weights](docs/screenshots/packages.jpg)

Prices are entered manually. Selecting a card records your planning choice; it does not make a reservation or payment.

## Try it locally

Requires [Node.js 22 or newer and npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm/). These commands use a macOS/Linux shell, from the repository root:

```bash
npm ci --ignore-scripts
TRIP_DATA_DIR="$(mktemp -d)" npm run demo
```

Open the local URL printed by the server, normally `http://127.0.0.1:8090/`. Choose **The coast, two ways** for the road trip or **A week by the sea** for packages. Keep the terminal open while using the app; press Ctrl+C to stop it.

The temporary directory is for trying the app. For your own trips, run `npm start`: it stores JSON files in `~/.trip-dashboard/`. Use `TRIP_DATA_DIR` to choose a persistent private directory outside the source tree. Back up that directory separately. Demo mode copies only missing sample files and never replaces an existing trip.

A first walkthrough:

1. Open the road trip and select **Demo · Garden studio**. The lodging subtotal and trip total change.
2. Click the circle beside **Tavira** to swap it into the itinerary. **Lagos** and its lodging remain available to swap back.
3. Edit a day plan, click **Save**, then reload to see the saved text.
4. Return to **All trips** and use **Clone** to keep a separate version.
5. Open the package demo, compare the door-to-door totals, and use the calendar button to inspect its synthetic date/price alternatives.

## Configuration and privacy

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8090` | Local HTTP port |
| `TRIP_DATA_DIR` | `~/.trip-dashboard` | Private runtime JSON directory; must be outside the source tree |
| `TRIP_DEMO` | Off | Set to `1` to copy the synthetic fixtures on startup |
| `TRIP_USER`, `TRIP_PASS` | Unset | Set both to enable HTTP Basic authentication; there is no built-in password |
| `TRIP_NETWORK` | Off | Set to `1` for optional online map tiles and road routing |

Export variables in your shell; `.env.example` is a reference, not an automatically loaded file. The server binds to `127.0.0.1` and accepts local hostnames. It is intended for one local user, not direct Internet hosting. Trip files are not encrypted.

By default the app makes no map, travel-provider or AI requests. Online mode loads [OpenStreetMap tiles](https://operations.osmfoundation.org/policies/tiles/) and requests road geometry from [OSRM](https://project-osrm.org/docs/v26.6.1/http); those services receive map areas or route coordinates. They can be unavailable, and approximate distances remain available as a fallback. There is no place autocomplete: enter stop coordinates manually. External property and directions links open only when you choose them.

The public edition does not include account-based scraping, live availability checks, assistant chat, browser profiles, background research workers or personal prompt files. Nearby research has an explanatory unavailable state; you can keep your own findings in the notes. External property photography is not bundled, and remote photos are blocked by the app's content policy.

## How it works

[Express](https://expressjs.com/en/starter/installing/) serves a plain JavaScript UI and a JSON API. [Leaflet](https://leafletjs.com) renders the map. Each trip has one JSON file, saved through a temporary file and rename. A revision counter lets open pages pick up saved changes.

Road trips use ordered slots with one active candidate per slot. Changing candidates updates the active itinerary without deleting the parked stops or their lodging. Package trips keep offers, departures and extra costs separately. See the [architecture and API guide](docs/architecture.md) for the data model, endpoint list and contributor setup, and [security notes](SECURITY.md) for the privacy boundary.

```bash
npm run check
npm test
npm audit --omit=dev
```

Tests use isolated temporary state and synthetic fixtures. The included CI runs syntax, HTTP behavior and dependency checks on Node 22 and 24.

## Limits

This is a planning tool, not a booking engine. Prices, availability, property details and comparison scores need your judgment and independent verification. Fuel costs are estimates; offline route lines are schematic. Entered full-stay prices remain estimates marked for review after date changes. Budget displays use euros. Package scores reflect the entered fields and weights, not independent research.

Run one server process per data directory. There is no account system, change history, multi-user conflict resolution, cloud sync or mobile app. Some settings, including a new trip's starting point and departure creation, currently use the JSON API rather than a dedicated form. Responsive browser layouts are included.

## License and provenance

Distributed under the [ISC license](LICENSE), matching the original project's declared license. [Third-party notices](THIRD_PARTY_NOTICES.md) cover the bundled map library and installed dependencies. The demo contains fictional stays and offers, without copied property photos or reviews.

AI coding assistance was used for public-edition preparation, tests and documentation. It is not required to run the app, and no AI-generated travel recommendation is presented as verified provider data.
