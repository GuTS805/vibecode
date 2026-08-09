/**
 * Bluesky posting — AT Protocol, no external dependency.
 *
 * Chosen as the free alternative to X: verified live before writing any integration code
 * (`describeServer` and a deliberately-wrong `createSession` both returned clean, expected
 * JSON), and there is no billing tier at all for basic posting — the constraint that blocked
 * X posting behind a bare 401 does not exist here.
 *
 * Auth is a handle + an "app password" (generated in Bluesky settings, distinct from the
 * account's real login password and independently revocable) rather than OAuth — one POST to
 * `createSession` returns a JWT, no signing, no redirect flow, no expiring-token dance to
 * manage for a process that posts every few hours. A fresh session is created per post rather
 * than caching and refreshing the JWT: at this posting frequency the extra login call is free
 * in practice and removes an entire class of "was my cached token still valid" bugs.
 */

const SERVICE = process.env.BLUESKY_SERVICE || 'https://bsky.social';

function creds() {
  const identifier = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!identifier || !password) return null;
  return { identifier, password };
}

export const isConfigured = () => Boolean(creds());
// Defaults to dry-run for the same reason as Twitter: safe until credentials are confirmed
// working, flipped off deliberately rather than by omission.
export const isDryRun = () => process.env.BLUESKY_DRY_RUN !== 'false';

function classify(status, body) {
  const message = String(body?.message || body?.error || body).slice(0, 300);

  if (status === 401 || body?.error === 'AuthenticationRequired') {
    const e = new Error(
      `Bluesky rejected these credentials (${message}). Check BLUESKY_HANDLE (the full handle, ` +
        'e.g. "name.bsky.social") and BLUESKY_APP_PASSWORD (an app password from Settings > ' +
        'Privacy and Security > App Passwords — not the account login password).'
    );
    e.code = 'AUTH_FAILED';
    e.retryable = false;
    return e;
  }
  if (status === 429) {
    const e = new Error(`Bluesky rate limit reached: ${message}`);
    e.code = 'RATE_LIMITED';
    e.retryable = true;
    return e;
  }
  if (body?.error === 'InvalidRequest' || status === 400) {
    const e = new Error(`Bluesky rejected the request: ${message}`);
    e.code = 'FORBIDDEN'; // post-specific, matches twitter.js's convention for the scheduler
    e.retryable = false;
    return e;
  }
  const e = new Error(`Bluesky API error ${status}: ${message}`);
  e.code = 'API_ERROR';
  e.retryable = status >= 500;
  return e;
}

async function xrpc(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${SERVICE}/xrpc/${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw classify(res.status, parsed);
  return parsed;
}

async function login() {
  const c = creds();
  if (!c) {
    const e = new Error('Bluesky credentials are not set (BLUESKY_HANDLE / BLUESKY_APP_PASSWORD).');
    e.code = 'NO_CREDENTIALS';
    e.retryable = false;
    throw e;
  }
  const session = await xrpc('com.atproto.server.createSession', { method: 'POST', body: c });
  return { accessJwt: session.accessJwt, did: session.did };
}

/** GET-equivalent credential check, parallel to twitter.js's verifyCredentials(). */
export async function verifyCredentials() {
  const { did } = await login();
  const profile = await xrpc(`com.atproto.repo.describeRepo?repo=${encodeURIComponent(did)}`);
  return { did, handle: profile.handle };
}

/* ------------------------------- composition -------------------------------- */

/**
 * Bluesky's limit is 300 grapheme clusters, not UTF-16 code units — an emoji or accented
 * character is one grapheme regardless of how many code units it takes, so `.length` would
 * under-count the room actually available and risk posting text the server rejects as too
 * long. `Intl.Segmenter` counts what the server counts.
 */
const MAX_GRAPHEMES = 300;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemeLength = (s) => [...segmenter.segment(s)].length;

function truncateToGraphemes(s, max) {
  const graphemes = [...segmenter.segment(s)].map((g) => g.segment);
  if (graphemes.length <= max) return s;
  return graphemes.slice(0, max).join('');
}

/**
 * Build the post text from the same takeaway + link a tweet would use — a post promoting a
 * link, not a copy of the post. Unlike X, Bluesky does not special-case URL length in its
 * character count, so the link's real length is what has to be budgeted for, not a fixed
 * shortener cost.
 */
export function composeSkeet(post) {
  const link = post.sources?.[0] || null;
  const linkCost = link ? graphemeLength(link) + 1 : 0;
  const budget = MAX_GRAPHEMES - linkCost;

  let text = String(post.takeaway || post.text || '').trim();
  if (graphemeLength(text) > budget) {
    const cut = truncateToGraphemes(text, Math.max(0, budget - 1));
    const lastSpace = cut.lastIndexOf(' ');
    text = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
  }

  return link ? `${text} ${link}` : text;
}

/* --------------------------------- posting ----------------------------------- */

/**
 * Bluesky requires a "facet" — an explicit byte-range annotation — to make a URL inside the
 * text clickable; plain text is not auto-linkified the way most social apps treat a bare URL.
 * Byte offsets, not character offsets, because that is what the facet spec uses (relevant
 * whenever the text before the link contains multi-byte characters).
 */
function buildFacets(text, link) {
  if (!link) return undefined;
  const idx = text.lastIndexOf(link);
  if (idx === -1) return undefined;
  const byteStart = Buffer.byteLength(text.slice(0, idx), 'utf8');
  const byteEnd = byteStart + Buffer.byteLength(link, 'utf8');
  return [
    {
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: link }],
    },
  ];
}

/**
 * Upload an image by URL as a blob, for embedding in a post.
 *
 * Non-fatal by design, same as the X path and the post-artwork step itself: a post without an
 * image is still a fine post, and an upload failure must not lose it.
 */
async function uploadBlob(token, imageUrl) {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Could not fetch image for upload: HTTP ${imgRes.status}`);
  const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
  const bytes = new Uint8Array(await imgRes.arrayBuffer());

  const res = await fetch(`${SERVICE}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: bytes,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw classify(res.status, body);
  return body.blob;
}

/**
 * Post one skeet, optionally with an image, real or dry-run per BLUESKY_DRY_RUN.
 *
 * Same uniform-shape convention as postTweet() in twitter.js: callers get `{ dryRun, id, url,
 * text }` whether the post was real or simulated, so the scheduler does not need to branch.
 */
export async function postSkeet({ text, imageUrl = null }) {
  const dryRun = isDryRun();

  if (!isConfigured() && !dryRun) {
    const e = new Error('Bluesky posting is enabled but BLUESKY_HANDLE / BLUESKY_APP_PASSWORD are not set.');
    e.code = 'NO_CREDENTIALS';
    e.retryable = false;
    throw e;
  }

  if (dryRun) {
    console.log(`[bluesky:dry-run] would post (${graphemeLength(text)} graphemes)${imageUrl ? ' with image' : ''}: ${text}`);
    return { dryRun: true, id: null, url: null, text };
  }

  const { accessJwt, did } = await login();

  let embed;
  if (imageUrl) {
    try {
      const blob = await uploadBlob(accessJwt, imageUrl);
      embed = { $type: 'app.bsky.embed.images', images: [{ image: blob, alt: 'Post illustration' }] };
    } catch (err) {
      console.warn(`[bluesky] image upload failed, posting text-only: ${err.message}`);
    }
  }

  const link = text.match(/https?:\/\/\S+$/)?.[0] || null;
  const record = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: new Date().toISOString(),
    ...(link ? { facets: buildFacets(text, link) } : {}),
    ...(embed ? { embed } : {}),
  };

  const result = await xrpc('com.atproto.repo.createRecord', {
    method: 'POST',
    token: accessJwt,
    body: { repo: did, collection: 'app.bsky.feed.post', record },
  });

  // Bluesky post URLs are constructed from the handle and the record key, not returned as a
  // ready-made link — the AT URI (at://did/collection/rkey) has to be translated to the
  // bsky.app web form.
  const rkey = result.uri?.split('/').pop();
  const handle = process.env.BLUESKY_HANDLE;
  const url = rkey && handle ? `https://bsky.app/profile/${handle}/post/${rkey}` : null;

  return { dryRun: false, id: result.uri || null, url, text };
}
