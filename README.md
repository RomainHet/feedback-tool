# Feedback widget

Lightweight pin-on-page feedback widget. Zero build step, drop-in `<script>` tag,
backed by Supabase via a Vercel serverless function.

## Layout

```
schema.sql          -- Supabase table
api/comments.js     -- Vercel route, handles GET and POST on /api/comments
widget.js           -- Vanilla JS widget, served at /widget.js
```

Vercel serves any file at the project root as a static asset, so `widget.js`
is available at `https://<your-deployment>/widget.js` with no config.

## Setup

1. **Supabase.** Create a project, then run [schema.sql](schema.sql) in the SQL
   editor. Grab the project URL and the service-role key.
2. **Vercel.** Import this repo. Set environment variables:
   - `SUPABASE_URL` — e.g. `https://xxxx.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` — service role key (server-side only)
3. **Embed.** On any page, add:
   ```html
   <script src="https://<your-deployment>/widget.js" data-project-id="my-project"></script>
   ```

The API route uses the service-role key, so RLS does not need to be configured
for the prototype. Two routes share `/api/comments` — one file, dispatching on
`req.method`.

## API

- `GET /api/comments?project_id=…&path=…` → returns rows ordered by
  `created_at asc`.
- `POST /api/comments` with JSON body
  `{ project_id, pathname, x_pct, y_pct, text, author? }` → returns the
  inserted row.

CORS is wide-open (`*`) so the widget works from any origin.

## Widget behavior

- Floating "Comment" button toggles comment mode.
- In comment mode, any click on the page drops a pin and opens a small popover
  for name + text. Submit → POST → pin becomes a numbered bubble.
- Pin coordinates are stored as percentages of the viewport and rendered with
  `position: fixed`, so pins stay anchored to where they were dropped relative
  to the window (not the document).
- Existing pins are fetched on load and on every route change. `pushState` is
  monkey-patched and `popstate` is listened to.
- Only pins whose `pathname` matches `location.pathname` are shown.
- Click a pin to expand its comment; click again or click elsewhere to close.
