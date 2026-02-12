# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Camdram Connected — a web app that finds connections between people in Cambridge theatre via [Camdram](https://www.camdram.net). No build step. Deploys to Cloudflare Pages (static files + Pages Function for CORS proxy).

## Development

```sh
npx wrangler pages dev . --port 8788
```

Open http://localhost:8788. Must use wrangler (not a plain static server) because the Camdram API lacks CORS headers — the Pages Function at `functions/api/[[path]].js` proxies `/api/*` requests and adds CORS headers.

## Architecture

Static files + one Cloudflare Pages Function:

- **index.html** — Structure: search inputs with autocomplete, filter controls, graph container, details panel
- **style.css** — Dark theme with CSS custom properties in `:root`
- **app.js** — All application logic in a single file:
  - **API layer** (`rateLimitedFetch`, `searchPeople`, `getPersonRoles`, `getShowRoles`) — Wraps Camdram API with 200ms rate limiting
  - **Autocomplete** (`setupAutocomplete`) — Debounced search with keyboard navigation, wired to both person inputs
  - **BFS pathfinder** (`findConnection`) — Lazily discovers the graph: fetches a person's roles, then each show's roles to find co-workers. Caches all fetched data. Returns path + edges on success
  - **Graph rendering** (`renderGraph`) — vis.js Network with person nodes (circles) and show nodes (boxes)
  - **Details panel** (`renderDetails`) — HTML listing of each connection step with show links and roles
  - **URL state** (`loadFromURL`) — Reads `?p1=&p2=&d=` params to support shareable links; auto-triggers search
- **functions/api/[[path]].js** — Cloudflare Pages Function that proxies `/api/*` to `https://www.camdram.net/*`, adding CORS headers and 5-minute cache

## Camdram API

Base: `https://www.camdram.net` (accessed via `/api/` proxy)

| Endpoint | Returns |
|---|---|
| `/people.json?q={query}` | Array of `{id, name, slug}` |
| `/people/{slug}.json` | `{id, name, slug}` |
| `/people/{slug}/roles.json` | Array of role objects |
| `/shows/{slug}/roles.json` | Array of role objects |

Role object shape:
```json
{
  "type": "cast|prod|band",
  "role": "Director",
  "person": {"id": 123, "name": "...", "slug": "..."},
  "show": {"id": 456, "name": "...", "slug": "..."}
}
```

No auth required for public data. Rate limits apply — the app enforces 200ms between requests.
