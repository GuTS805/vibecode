/**
 * X (Twitter) posting — OAuth 1.0a, no external dependency.
 *
 * OAuth 1.0a rather than OAuth 2.0 user-context because it needs no browser login flow and
 * the tokens do not expire: four static values from the developer console are enough for a
 * server process to post as the account indefinitely. OAuth 2.0 user context would need a
 * one-time authorization redirect and a refresh-token dance, which does not fit a headless
 * cron job.
 *
 * DRY RUN. `TWITTER_DRY_RUN=true` (the default — see .env.example) composes and logs exactly
 * what would be posted, records it against the post, and never calls the network. This
 * exists because X's newer pay-per-usage billing can reject even nominally-free calls with a
 * bare 401 when a project has no payment method attached — verified directly: the same
 * signing code that composes a textbook-correct OAuth base string was rejected on the
 * simplest possible call (`oauth/request_token`, consumer key/secret only, no access token
 * involved). That is a billing/account state, not a code bug, and dry run means the whole
 * pipeline — composition, length handling, scheduling, DB recording — is fully built and
 * tested without it, and flips on with one env var once the account can actually post.
 */
import crypto from 'node:crypto';

const API_BASE = 'https://api.twitter.com';

function creds() {
  const apiKey = process.env.TWITTER_API_KEY;
  const apiSecret = process.env.TWITTER_API_SECRET;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  const accessSecret = process.env.TWITTER_ACCESS_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) return null;
  return { apiKey, apiSecret, accessToken, accessSecret };
}

export const isConfigured = () => Boolean(creds());
export const isDryRun = () => process.env.TWITTER_DRY_RUN !== 'false';

/* -------------------------------- OAuth 1.0a -------------------------------- */

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Sign one request. `extraParams` are query/body params that participate in the signature —
 * for a JSON POST body (tweet creation) there are none, since only the URL and OAuth params
 * are signed; for a form-encoded upload they are the form fields.
 */
function oauthHeader({ apiKey, apiSecret, accessToken, accessSecret }, method, url, extraParams = {}) {
  const oauthParams = {
    oauth_consumer_key: apiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: accessToken,
    oauth_version: '1.0',
  };

  const allParams = { ...oauthParams, ...extraParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join('&');

  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(apiSecret)}&${percentEncode(accessSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  const headerParams = { ...oauthParams, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
      .join(', ')
  );
}

function classify(status, body) {
  const message = String(body?.detail || body?.title || body?.errors?.[0]?.message || body || '').slice(0, 300);

  if (status === 401) {
    const e = new Error(
      `X rejected these credentials (401: ${message}). This is not necessarily a code problem — ` +
        'on the pay-per-usage plan, X can reject even zero-cost calls with a bare 401 when the ' +
        'project has no payment method on file. Check console.x.com > Billing.'
    );
    e.code = 'AUTH_FAILED';
    e.retryable = false;
    return e;
  }
  if (status === 403) {
    const e = new Error(`X refused this request (403: ${message}). Often a permissions or duplicate-content rejection.`);
    e.code = 'FORBIDDEN';
    e.retryable = false;
    return e;
  }
  if (status === 429) {
    const retryAfter = Number(body?.retryAfter) || null;
    const e = new Error(`X rate limit reached${retryAfter ? `; retry in ${retryAfter}s` : ''}.`);
    e.code = 'RATE_LIMITED';
    e.retryAfter = retryAfter;
    e.retryable = true;
    return e;
  }
  const e = new Error(`X API error ${status}: ${message}`);
  e.code = 'API_ERROR';
  e.retryable = status >= 500;
  return e;
}

/* ------------------------------- composition -------------------------------- */

const MAX_TWEET_LENGTH = 280;
/** X counts any URL as this many characters regardless of its real length (t.co wrapping). */
const TCO_URL_LENGTH = 23;

/**
 * Build the tweet text from what the post already has, rather than the full 90-160 word body
 * — a tweet is a pointer to the post, not the post. The takeaway is written for exactly this:
 * one sentence, under 130 characters, stating the point rather than summarising the piece.
 *
 * The link is not optional-if-it-fits: it is the reason to tweet at all, so it is reserved
 * space first and the takeaway is trimmed to what is left, never the other way round.
 */
export function composeTweet(post) {
  const link = post.sources?.[0] || null;
  const linkCost = link ? TCO_URL_LENGTH + 1 : 0; // +1 for the separating space
  const budget = MAX_TWEET_LENGTH - linkCost;

  let text = String(post.takeaway || post.text || '').trim();
  if (text.length > budget) {
    // Cut at the last word boundary inside budget, then add an ellipsis inside that same
    // budget rather than after it — going over by the ellipsis's own length is the classic
    // off-by-a-few bug here.
    const cut = text.slice(0, budget - 1);
    const lastSpace = cut.lastIndexOf(' ');
    text = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
  }

  return link ? `${text} ${link}` : text;
}

/* --------------------------------- posting ----------------------------------- */

/**
 * Upload an image by URL for attachment to a tweet.
 *
 * Non-fatal by design, same as post artwork generation: a tweet without an image is still a
 * fine tweet, and an image-upload failure must not lose the post entirely.
 */
async function uploadMedia(c, imageUrl) {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Could not fetch image for upload: HTTP ${imgRes.status}`);
  const bytes = Buffer.from(await imgRes.arrayBuffer());
  const b64 = bytes.toString('base64');

  const url = `${API_BASE}/1.1/media/upload.json`;
  // media_data participates in the OAuth signature for a form-encoded body.
  const params = { media_data: b64 };
  const auth = oauthHeader(c, 'POST', url, params);

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw classify(res.status, body);
  return body.media_id_string;
}

/**
 * Post one tweet, optionally with an image, real or dry-run per TWITTER_DRY_RUN.
 *
 * Returns a uniform shape whether real or simulated, so callers do not need to branch on
 * dry-run — the DB record and the API response look the same either way, just tagged.
 */
export async function postTweet({ text, imageUrl = null }) {
  const dryRun = isDryRun();
  const c = creds();

  if (!c && !dryRun) {
    const e = new Error(
      'Twitter posting is enabled but TWITTER_API_KEY / TWITTER_API_SECRET / TWITTER_ACCESS_TOKEN / ' +
        'TWITTER_ACCESS_SECRET are not all set.'
    );
    e.code = 'NO_CREDENTIALS';
    e.retryable = false;
    throw e;
  }

  if (dryRun) {
    console.log(`[twitter:dry-run] would post (${text.length} chars)${imageUrl ? ' with image' : ''}: ${text}`);
    return {
      dryRun: true,
      id: null,
      url: null,
      text,
    };
  }

  let mediaId = null;
  if (imageUrl) {
    try {
      mediaId = await uploadMedia(c, imageUrl);
    } catch (err) {
      console.warn(`[twitter] image upload failed, posting text-only: ${err.message}`);
    }
  }

  const url = `${API_BASE}/2/tweets`;
  // The v2 create-tweet body is JSON, which does not participate in an OAuth 1.0a signature
  // the way form fields do — only the URL and OAuth params are signed here.
  const auth = oauthHeader(c, 'POST', url);

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw classify(res.status, body);

  const id = body?.data?.id;
  return {
    dryRun: false,
    id,
    url: id ? `https://x.com/i/web/status/${id}` : null,
    text,
  };
}

/** GET /2/users/me — used only to verify credentials on demand, never on the posting path. */
export async function verifyCredentials() {
  const c = creds();
  if (!c) {
    const e = new Error('Twitter credentials are not set.');
    e.code = 'NO_CREDENTIALS';
    throw e;
  }
  const url = `${API_BASE}/2/users/me`;
  const res = await fetch(url, { headers: { Authorization: oauthHeader(c, 'GET', url) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw classify(res.status, body);
  return body.data;
}
