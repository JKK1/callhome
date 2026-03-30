// Cloudflare Pages Function — handles all /api/* routes
// Uses Cloudflare D1 (SQLite) for storage.
//
// Global rolling limit: MAX_PAGES_PER_DAY (default 1000) pages per 24 hours.
// Measured directly from the contacts table — no separate counter.
// When exceeded, requests are queued. The queue is drained automatically
// at the top of every create request as the window rolls forward.

const RESERVED_SLUGS = new Set([
  'api', 'admin', 'www', 'mail', 'ftp', 'static', 'assets',
  'index', 'create', 'new', 'help', 'about', 'contact',
  'login', 'logout', 'signup', 'register', 'dashboard',
  'privacy', 'terms',
]);

const SLUG_RE = /^[a-z0-9][a-z0-9\-_]{1,48}[a-z0-9]$/;

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

// ── Rolling 24h window ────────────────────────────────────────────────────────
// Counts pages created in the last 24 hours directly from the contacts table.

async function getRollingCapacity(db, env) {
  const limit = parseInt(env.MAX_PAGES_PER_DAY ?? '1000');
  const row   = await db.prepare(
    "SELECT COUNT(*) as n FROM contacts WHERE created_at > datetime('now', '-1 day')"
  ).first();
  const used = row?.n ?? 0;
  return { used, limit, capacity: Math.max(0, limit - used) };
}

// ── Queue drain ───────────────────────────────────────────────────────────────
// Promotes queued entries FIFO up to the current rolling capacity.
// Called at the top of every create request — no external cron needed.

async function drainQueue(db, env) {
  const { capacity } = await getRollingCapacity(db, env);
  if (capacity === 0) return;

  const entries = await db.prepare(
    'SELECT slug, salt, iv, data, verifier FROM queue ORDER BY queued_at ASC LIMIT ?'
  ).bind(capacity).all();

  if (!entries.results?.length) return;

  const now = new Date().toISOString();
  for (const e of entries.results) {
    const clash = await db.prepare('SELECT slug FROM contacts WHERE slug = ?').bind(e.slug).first();
    if (!clash) {
      await db.prepare(`
        INSERT INTO contacts (slug, salt, iv, data, verifier, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(e.slug, e.salt, e.iv, e.data, e.verifier, now, now).run();
    }
    await db.prepare('DELETE FROM queue WHERE slug = ?').bind(e.slug).run();
  }
}

// ── Per-IP rate limiting ──────────────────────────────────────────────────────

async function checkRateLimit(db, type, ip, env) {
  const createLimit = parseInt(env.RATE_LIMIT_CREATE_PER_HOUR ?? '5');
  const readLimit   = parseInt(env.RATE_LIMIT_READ_PER_MINUTE ?? '30');
  const windowSecs  = type === 'create' ? 3600 : 60;
  const limit       = type === 'create' ? createLimit : readLimit;
  const bucket      = Math.floor(Date.now() / (windowSecs * 1000));
  const key         = `${type}:${ip}:${bucket}`;

  await db.prepare(`
    INSERT INTO rate_limits (key, count, window_start)
    VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = count + 1
  `).bind(key, Math.floor(Date.now() / 1000)).run();

  const row = await db.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(key).first();

  db.prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .bind(Math.floor(Date.now() / 1000) - windowSecs * 2).run().catch(() => {});

  return (row?.count ?? 1) <= limit;
}

// ── Constant-time comparison ──────────────────────────────────────────────────

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleCheckSlug(db, slug) {
  if (!slug) return err('slug param required');
  const normalized = slug.toLowerCase().trim();
  if (!SLUG_RE.test(normalized) || RESERVED_SLUGS.has(normalized)) {
    return json({ available: false, reason: 'invalid' });
  }
  const inContacts = await db.prepare('SELECT slug FROM contacts WHERE slug = ?').bind(normalized).first();
  const inQueue    = await db.prepare('SELECT slug FROM queue WHERE slug = ?').bind(normalized).first();
  return json({ available: !inContacts && !inQueue });
}

async function handleQueueStatus(db, slug) {
  // Promoted — page is live
  const live = await db.prepare('SELECT slug FROM contacts WHERE slug = ?').bind(slug).first();
  if (live) return json({ status: 'ready' });

  // Still in queue — return current position
  const entry = await db.prepare('SELECT queued_at FROM queue WHERE slug = ?').bind(slug).first();
  if (!entry) return err('Not found.', 404);

  const pos = await db.prepare(
    'SELECT COUNT(*) as n FROM queue WHERE queued_at <= ?'
  ).bind(entry.queued_at).first();

  return json({ status: 'queued', position: pos?.n ?? 1 });
}

async function handleCreate(request, db, ip, env) {
  if (!await checkRateLimit(db, 'create', ip, env)) {
    return err('Too many pages created from your IP. Try again in an hour.', 429);
  }

  // Drain queue first — rolling window may have freed capacity since last request
  await drainQueue(db, env);

  let body;
  try { body = await request.json(); }
  catch { return err('Invalid JSON'); }

  const { slug, salt, iv, data, verifier } = body;

  if (!slug || typeof slug !== 'string') return err('slug is required');
  const normalized = slug.toLowerCase().trim();
  if (!SLUG_RE.test(normalized)) return err('Slug must be 3–50 characters: letters, numbers, hyphens, underscores only.');
  if (RESERVED_SLUGS.has(normalized)) return err('That slug is reserved.');
  if (!salt || !iv || !data || !verifier) return err('Missing encrypted payload fields.');

  const existing = await db.prepare('SELECT slug FROM contacts WHERE slug = ?').bind(normalized).first();
  if (existing) return err('That URL is already taken.', 409);
  const queued = await db.prepare('SELECT slug FROM queue WHERE slug = ?').bind(normalized).first();
  if (queued) return err('That URL is already in the queue.', 409);

  const { capacity } = await getRollingCapacity(db, env);

  if (capacity === 0) {
    // Queue it — calculate FIFO position
    const pos = await db.prepare('SELECT COUNT(*) as n FROM queue').first();
    const position = (pos?.n ?? 0) + 1;
    await db.prepare(`
      INSERT INTO queue (slug, salt, iv, data, verifier, queued_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(normalized, salt, iv, data, verifier, new Date().toISOString()).run();
    return json({ queued: true, slug: normalized, position }, 202);
  }

  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO contacts (slug, salt, iv, data, verifier, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(normalized, salt, iv, data, verifier, now, now).run();

  return json({ slug: normalized }, 201);
}

async function handleRead(request, db, ip, env, slug) {
  if (!await checkRateLimit(db, 'read', ip, env)) {
    return err('Too many requests. Try again in a minute.', 429);
  }
  const row = await db.prepare(
    'SELECT salt, iv, data, updated_at FROM contacts WHERE slug = ?'
  ).bind(slug).first();
  if (!row) return err('Page not found.', 404);
  return json({ salt: row.salt, iv: row.iv, data: row.data, updatedAt: row.updated_at });
}

async function handleUpdate(request, db, ip, env, slug) {
  if (!await checkRateLimit(db, 'create', ip, env)) {
    return err('Too many requests from your IP. Try again in an hour.', 429);
  }
  const row = await db.prepare('SELECT verifier FROM contacts WHERE slug = ?').bind(slug).first();
  if (!row) return err('Page not found.', 404);

  let body;
  try { body = await request.json(); }
  catch { return err('Invalid JSON'); }

  const { verifier, salt, iv, data, newVerifier } = body;
  if (!verifier || !salt || !iv || !data) return err('Missing required fields.');
  if (!safeCompare(verifier, row.verifier)) return err('Wrong password.', 403);

  await db.prepare(`
    UPDATE contacts SET salt = ?, iv = ?, data = ?, verifier = ?, updated_at = ? WHERE slug = ?
  `).bind(salt, iv, data, newVerifier ?? row.verifier, new Date().toISOString(), slug).run();

  return json({ ok: true });
}

async function handleDelete(request, db, ip, slug) {
  const row = await db.prepare('SELECT verifier FROM contacts WHERE slug = ?').bind(slug).first();
  if (!row) return err('Page not found.', 404);

  let body;
  try { body = await request.json(); }
  catch { return err('Invalid JSON'); }

  const { verifier } = body;
  if (!verifier) return err('Missing verifier.');
  if (!safeCompare(verifier, row.verifier)) return err('Wrong password.', 403);

  await db.prepare('DELETE FROM contacts WHERE slug = ?').bind(slug).run();
  return json({ ok: true });
}

// ── Router ────────────────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env, params } = context;
  const method = request.method;
  const url    = new URL(request.url);
  const db     = env.DB;
  const ip     = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';

  const route = Array.isArray(params.route)
    ? params.route
    : (params.route ?? '').split('/').filter(Boolean);

  if (route[0] === 'queue' && route[1]) return handleQueueStatus(db, route[1].toLowerCase());
  if (route[0] !== 'contacts')          return new Response('Not found', { status: 404 });

  const slug = route[1]?.toLowerCase() ?? null;

  if (method === 'GET'    && slug === 'check') return handleCheckSlug(db, url.searchParams.get('slug'));
  if (method === 'POST'   && !slug)            return handleCreate(request, db, ip, env);
  if (method === 'GET'    && slug)             return handleRead(request, db, ip, env, slug);
  if (method === 'PUT'    && slug)             return handleUpdate(request, db, ip, env, slug);
  if (method === 'DELETE' && slug)             return handleDelete(request, db, ip, slug);

  return new Response('Method not allowed', { status: 405 });
}
