# Veyago Workspace

Static HTML/CSS/JavaScript workspace dashboard for Veyago Inc.

## Run locally

From this directory, serve the `dist` folder with any static file server. For example:

```bash
python3 -m http.server 4173 --directory dist
```

Then open `http://localhost:4173`.

## Structure

- `dist/index.html` — application shell and metadata
- `dist/styles.css` — base Veyago / Apple-inspired visual system
- `dist/workspace.css` — workspace-specific layouts and responsive styling
- `dist/app.js` — shell, icons, dialogs, and core interactions
- `dist/workspace.js` — connected app views, detail routes, notes, tasks, and subpages
- `dist/data/` — the Supabase layer (see below)
- `.openai/hosting.json` — Sites project identity

Bump the `?v=N` query on the `<script>`/`<link>` tags in `index.html` whenever
you change CSS or JS, or browsers keep serving the old file.

## It runs on the database

Every view reads Supabase. The arrays at the top of `app.js` start **empty** —
they used to hold sample rows, which meant a failed load looked like a working
workspace belonging to somebody else. `dist/data/store.js` fills them once
someone signs in.

Ticking a task, replying to a ticket, adding a note and the whole "Create new"
dialog all write, and wait for the database before the screen changes.

## The data layer — `dist/data/`

Backed by the same Supabase project as `veyago.cloud/admin`: one database, one
set of accounts, `employees.role` deciding what each person sees. The anon key
in `config.js` is public-safe — every workspace table is private, with no
anonymous policy at all, so the key alone opens nothing.

| File | What it is |
|---|---|
| `supabase.js` | vendored supabase-js v2 (no CDN — the site's CSP is `script-src 'self'`) |
| `config.js` | project URL + anon key |
| `session.js` | who is signed in, and their role |
| `gate.js` / `gate.css` | the sign-in screen, TOTP step, header session chip |
| `queries.js` | one read function per view |
| `actions.js` | the writes |
| `writes.js` | takes over the app's own handlers so they reach the database |
| `store.js` | loads everything and swaps it into the arrays the views render from |

**Script order matters** — `writes.js` before `app.js`, `store.js` after it.
The reasons are in `veyagocloud/docs/workspace-backend.md`; both failure modes
are silent.

```js
await workspaceSession.ready();           // never query before this resolves
if (!workspaceSession.isStaff()) return;  // signed in, but not a team member

const tickets  = await workspaceData.tickets();
const overview = await workspaceData.overview();   // the four KPI tiles, one call
await workspaceActions.replyToTicket(id, 'On it.', 'reply');
```

**`ready()` is not optional.** On a fresh load `getSession()` can hand back a
session before supabase-js has finished restoring it; a query fired in that
window runs with a stale JWT, RLS sees no user, and every private row comes back
empty — which reads as "there is no data" rather than "you asked too early".

Reads are filtered by Row Level Security, so a query returning `[]` for one
person and rows for another is the database working, not a bug. Finance is
managers only; `overview().revenue_month` is `null` rather than `0` for everyone
else, because a zero would read as a real number.

Available: `overview`, `activity`, `events`, `tickets`, `ticket`, `projects`,
`projectTasks`, `contacts`, `companies`, `invoices`, `transactions`, `team`,
`mailThreads`, `mailMessages`, `integrations`.

## Backend

Schema, permissions, the test suites, and how to connect Gmail and Google
Calendar: **`veyagocloud/docs/workspace-backend.md`**.

## Deployment

Vercel, from this repo, at **workspace.veyago.cloud**. `vercel.json` sets
`outputDirectory: dist`, so there is no build step — the committed files ship
verbatim, the same arrangement veyago.cloud uses.

### The CSP, and the one place it is loose

Everything is `'self'` except images:

```
img-src 'self' data: https:
```

That is deliberate and it is the interesting one. The Mail view renders real
email, and email is full of remote images — a stricter `img-src` would make
the "Show images" button do nothing. Remote images are still blocked *by
default* in `data/mail-html.js`, because a remote image is how a sender learns
you opened their message; the CSP only permits them once you ask.

The properly private version proxies images through a function so the sender
sees the server rather than you, the way Gmail does. Worth building; not built.

`connect-src` allows the Supabase REST, auth and realtime origins and nothing
else. `script-src` is `'self'` alone — supabase-js and DOMPurify are vendored
into `dist/data/` rather than pulled from a CDN.

### Not indexed

`X-Robots-Tag: noindex, nofollow, noarchive` on every response, a matching
`<meta name="robots">`, and a `robots.txt` that disallows everything. The URL
is public and the sign-in gate is the boundary — but there is no reason for it
to be in a search index.

### Cache

CSS and JS are `max-age=3600, must-revalidate`; the shell is `no-cache`. Short
enough that the stale-stylesheet class of bug (see veyagocloud's
`tools/version-assets.js`) cannot bite here, so the manual `?v=N` on the script
tags stays a convenience rather than a load-bearing mechanism.
