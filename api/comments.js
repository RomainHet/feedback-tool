// Vercel serverless function — handles GET, POST, and DELETE on /api/comments.
// Talks to Supabase via the PostgREST endpoint using the service-role key.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

async function sb(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await r.text();
  return { status: r.status, body: body ? JSON.parse(body) : null };
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const project_id = req.query.project_id;
      const path = req.query.path;
      if (!project_id) {
        res.status(400).json({ error: 'project_id is required' });
        return;
      }
      const params = new URLSearchParams({
        select: '*',
        project_id: `eq.${project_id}`,
        order: 'created_at.asc',
      });
      // path is optional — omit to fetch every comment across the project
      // (used by the widget's "All comments" panel).
      if (path) params.set('pathname', `eq.${path}`);
      const { status, body } = await sb(`comments?${params}`);
      res.status(status).json(body);
      return;
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const { project_id, pathname, x_pct, y_pct, text, author } = b;
      if (
        !project_id ||
        !pathname ||
        typeof x_pct !== 'number' ||
        typeof y_pct !== 'number' ||
        !text ||
        typeof text !== 'string'
      ) {
        res.status(400).json({ error: 'invalid payload' });
        return;
      }
      const row = {
        project_id,
        pathname,
        x_pct,
        y_pct,
        text: text.slice(0, 4000),
        author: author ? String(author).slice(0, 120) : null,
      };
      const { status, body } = await sb('comments', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      res.status(status).json(Array.isArray(body) ? body[0] : body);
      return;
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
      }
      // Lightweight UUID sanity check — prevents accidental wildcard deletes.
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        res.status(400).json({ error: 'id must be a UUID' });
        return;
      }
      const { status } = await sb(`comments?id=eq.${id}`, { method: 'DELETE' });
      res.status(status === 204 ? 200 : status).json({ ok: status === 204, id });
      return;
    }

    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
    res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
};
