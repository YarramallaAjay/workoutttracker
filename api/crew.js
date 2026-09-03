/**
 * Iron Ledger — shared crew board.
 *
 * Storage is any Upstash-compatible Redis REST endpoint. Both the Vercel
 * Upstash marketplace integration (KV_REST_API_*) and a direct Upstash
 * project (UPSTASH_REDIS_REST_*) inject the two variables this reads, so
 * connecting either one is the whole setup.
 *
 * Without those variables the route still answers: the board loads empty
 * and reports that its store is not connected, rather than failing the page.
 */

const KEY = 'ironledger:crew';
const MAX_POSTS = 200;
const MAX_TEXT = 600;
const MAX_NAME = 32;
const RATE_SECONDS = 60;

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const PASSCODE = process.env.CREW_PASSCODE || '';

const hasStore = () => Boolean(REST_URL && REST_TOKEN);

async function redis(command) {
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error('store responded ' + res.status);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

/* Drop control characters, collapse runs of whitespace, keep paragraph breaks. */
function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

async function readPosts() {
  const rows = await redis(['LRANGE', KEY, '0', String(MAX_POSTS - 1)]);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      try {
        return JSON.parse(row);
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    if (!hasStore()) {
      return res.status(200).json({ posts: [], storage: false, passcode: Boolean(PASSCODE) });
    }
    try {
      return res.status(200).json({ posts: await readPosts(), storage: true, passcode: Boolean(PASSCODE) });
    } catch (err) {
      return res.status(200).json({ posts: [], storage: false, passcode: Boolean(PASSCODE) });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Use GET to read the board or POST to add to it.' });
  }

  if (!hasStore()) {
    return res.status(503).json({ error: 'The board store is not connected yet.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = null;
    }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Send a JSON body.' });
  }

  if (PASSCODE && String(body.code || '') !== PASSCODE) {
    return res.status(401).json({ error: 'Wrong passcode.' });
  }

  const text = clean(body.text, MAX_TEXT);
  const who = clean(body.who, MAX_NAME) || 'Anonymous';
  const kind = ['checkin', 'pr', 'note'].includes(body.kind) ? body.kind : 'checkin';
  if (!text) return res.status(400).json({ error: 'Write something first.' });

  try {
    const gate = KEY + ':rate:' + clientIp(req);
    const fresh = await redis(['SET', gate, '1', 'NX', 'EX', String(RATE_SECONDS)]);
    if (fresh === null) {
      return res.status(429).json({ error: 'One post a minute, please.' });
    }

    const post = {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      who: who,
      ts: Date.now(),
      kind: kind,
      text: text,
    };
    await redis(['LPUSH', KEY, JSON.stringify(post)]);
    await redis(['LTRIM', KEY, '0', String(MAX_POSTS - 1)]);
    return res.status(200).json({ posts: await readPosts(), storage: true });
  } catch (err) {
    return res.status(500).json({ error: 'The board store did not accept that post.' });
  }
}
