# Camdram Connected

Find the connection between any two people in Cambridge theatre, using data from [Camdram](https://www.camdram.net).

Enter two people's names, and the app finds how they're connected through shared shows — like "six degrees of separation" for Cambridge theatre.

## Features

- **Autocomplete search** for Camdram people
- **BFS pathfinding** to find shortest connection between two people
- **Interactive graph** visualization (vis.js) showing people and shows
- **Filter by role type** (cast, crew/production, band)
- **Configurable search depth** (1–4 degrees of separation)
- **Shareable URLs** with pre-filled names
- **Export** graph as PNG

## Setup

No build step required. Static HTML/CSS/JS plus a Cloudflare Pages Function for CORS proxying.

### Local development

Use Wrangler to run locally (this enables the CORS proxy function):

```sh
npx wrangler pages dev . --port 8788
```

Then open http://localhost:8788.

> **Note:** A plain static server (`python3 -m http.server`) won't work because the Camdram API doesn't send CORS headers. The Cloudflare Pages Function at `functions/api/[[path]].js` proxies requests through `/api/*` and adds the required headers.

### Deploy to Cloudflare Pages

1. Push this repo to GitHub
2. In the Cloudflare dashboard, go to **Workers & Pages > Create > Pages**
3. Connect your GitHub repo
4. No build command needed; output directory: `/`
5. Deploy — the `functions/` directory is automatically picked up

Or use the Wrangler CLI:

```sh
npx wrangler pages deploy . --project-name=camdram-connected
```

## Camdram API

The app uses these public Camdram API endpoints (no auth required for basic usage):

| Endpoint | Purpose |
|---|---|
| `GET /people.json?q={query}` | Search people by name |
| `GET /people/{slug}.json` | Get person details |
| `GET /people/{slug}/roles.json` | Get all roles for a person |
| `GET /shows/{slug}/roles.json` | Get all roles in a show |

Role objects include `type` field: `cast`, `prod` (crew/production), or `band`.

## How it works

1. User selects two people via autocomplete search
2. BFS explores outward from person 1, fetching their shows and co-workers
3. At each depth level, if person 2 is found among co-workers, the path is returned
4. The path is rendered as an interactive graph (people = circles, shows = boxes)
5. A details panel lists each connection step with show names and roles
