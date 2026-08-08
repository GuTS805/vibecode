/**
 * Pollinations.ai provider — images and text.
 *
 * WHAT ACTUALLY WORKS ANONYMOUSLY (probed 2026-08-08, see README > Known constraints):
 *
 *   Images  free, no key, no signup. `sana` is the only anonymous model. Verified end to
 *           end: a real 1024x576 JPEG in ~1.6s. This is what powers post artwork.
 *
 *   Text    NOT usable without funding. Pollinations moved text to a "pollen" balance and
 *           the anonymous balance is exactly 0.0000, so any prompt with real content is
 *           refused with 402 (`cost 0.0002 pollen, but this key has 0.0000`). Bisected: a
 *           6-character prompt succeeds, 200 characters already fails, and a referrer —
 *           in the body, as a header, or as a query param — does not change it.
 *
 * The text client below is therefore complete and correct but gated: it activates when
 * POLLINATIONS_TOKEN is set (or TEXT_PROVIDER=pollinations forces it). Until then the
 * router in llm.js keeps text on Gemini, so the pipeline keeps working rather than 402ing
 * on every call. Fund a token at https://enter.pollinations.ai and text moves over with no
 * code change.
 */

const TEXT_ENDPOINT = 'https://text.pollinations.ai/';
const IMAGE_ENDPOINT = 'https://image.pollinations.ai/prompt/';

const TEXT_MODEL = process.env.POLLINATIONS_TEXT_MODEL || 'openai-fast';
const IMAGE_MODEL = process.env.POLLINATIONS_IMAGE_MODEL || 'sana';
const TOKEN = process.env.POLLINATIONS_TOKEN || '';

/** Anonymous requests are aggressively throttled; keep a floor between calls. */
const MIN_GAP_MS = Number(process.env.POLLINATIONS_MIN_GAP_MS || 6_000);
let lastCallAt = 0;

async function throttle() {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

export const hasPollinationsToken = () => Boolean(TOKEN);

const authHeaders = () => (TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {});

/* ---------------------------------- errors ---------------------------------- */

function classify(status, body) {
  // 402 is the anonymous-balance case and never clears by retrying.
  if (status === 402 || /PAYMENT_REQUIRED|budget too low/i.test(body)) {
    const e = new Error(
      'Pollinations text requires a funded account. The anonymous pollen balance is 0, so any ' +
        'real prompt is refused. Set POLLINATIONS_TOKEN from https://enter.pollinations.ai, or ' +
        'leave TEXT_PROVIDER unset to keep text on Gemini.'
    );
    e.code = 'POLLINATIONS_UNFUNDED';
    e.retryable = false;
    return e;
  }
  // Their edge answers a challenge page rather than JSON when a client is going too fast.
  if (/^\s*<!DOCTYPE html/i.test(body) || status === 403) {
    const e = new Error('Pollinations rate-limited this client (edge challenge). Backing off.');
    e.code = 'POLLINATIONS_RATE_LIMITED';
    e.retryable = true;
    return e;
  }
  if (status === 429) {
    const e = new Error('Pollinations rate limit reached.');
    e.code = 'POLLINATIONS_RATE_LIMITED';
    e.retryable = true;
    return e;
  }
  const e = new Error(`Pollinations error ${status}: ${String(body).slice(0, 200)}`);
  e.code = 'POLLINATIONS_ERROR';
  e.retryable = status >= 500;
  return e;
}

/* ----------------------------------- text ----------------------------------- */

/**
 * One text completion. Signature matches the Gemini provider's `complete()` so llm.js can
 * route between them without either caller knowing which one answered.
 *
 * `searchResults` comes back empty because Pollinations has no web-search grounding — the
 * feed-based discovery path exists precisely so the pipeline does not depend on it.
 */
export async function pollinationsComplete({
  system,
  prompt,
  maxTokens = 2048,
  json = false,
  label = 'call',
  timeoutMs = 90_000,
}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const started = Date.now();
  await throttle();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  let body;
  try {
    res = await fetch(TEXT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: TEXT_MODEL,
        messages,
        max_tokens: maxTokens,
        ...(json ? { jsonMode: true } : {}),
        ...(TOKEN ? { token: TOKEN } : {}),
      }),
    });
    body = await res.text();
  } catch (err) {
    clearTimeout(timer);
    const e = new Error(`Could not reach Pollinations: ${err.message}`);
    e.code = 'NETWORK';
    e.retryable = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok || /^\s*<!DOCTYPE html/i.test(body)) throw classify(res.status, body);

  // A 200 can still carry an error envelope.
  if (body.trim().startsWith('{') && /"error"\s*:/.test(body)) {
    try {
      const parsed = JSON.parse(body);
      if (parsed.error) throw classify(parsed.status || res.status, body);
    } catch (e) {
      if (e.code) throw e;
    }
  }

  const text = body.trim();
  console.log(`[pollinations:${label}] ${TEXT_MODEL} ${Date.now() - started}ms chars=${text.length}`);
  return { text, searchResults: { results: [], domains: new Set(), errors: [] } };
}

/* ---------------------------------- images ---------------------------------- */

/**
 * Deterministic seed from the post's identity, so the same post always resolves to the
 * same artwork. Pollinations regenerates from (prompt, seed) rather than storing a file,
 * so a stable seed is what makes the stored URL stable.
 */
function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 1_000_000;
}

/**
 * Generated taller than the 16:9 box it renders into.
 *
 * `sana` ignores "no text" instructions and `nologo=true` often enough that a strip of
 * garbled pseudo-text appears along the bottom edge — verified on real output. The card
 * crops that strip off with `object-position: center top`, so the extra height here is what
 * makes the crop possible. 640 against a 576 box discards the bottom ~10%.
 */
const GEN_HEIGHT = Number(process.env.POLLINATIONS_IMAGE_HEIGHT || 640);

export function buildImageUrl(imagePrompt, { seed, width = 1024, height = GEN_HEIGHT } = {}) {
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    model: IMAGE_MODEL,
    nologo: 'true',
    seed: String(seed ?? seedFrom(imagePrompt)),
  });
  if (TOKEN) params.set('token', TOKEN);
  return `${IMAGE_ENDPOINT}${encodeURIComponent(imagePrompt)}?${params}`;
}

/**
 * Generate artwork and return a URL that is known to work.
 *
 * The request is made here rather than left to the browser for two reasons: it warms
 * Pollinations' cache so the card paints immediately, and it verifies the response really
 * is an image. Storing an unverified URL would put broken images in the permanent feed —
 * posts are append-only, so a bad URL is never corrected.
 *
 * Non-fatal by design: a post without artwork is still a good post, so every failure path
 * returns null and the card renders text-only.
 */
export async function generateImage(imagePrompt, { seed, width = 1024, height = GEN_HEIGHT, timeoutMs = 60_000 } = {}) {
  const url = buildImageUrl(imagePrompt, { seed, width, height });
  const started = Date.now();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) {
      console.warn(`[image] generation failed: HTTP ${res.status} type=${type || 'none'}`);
      return null;
    }
    // Drain the body so the CDN records a complete fetch and caches the result.
    const bytes = (await res.arrayBuffer()).byteLength;
    if (bytes < 1000) {
      console.warn(`[image] suspiciously small response (${bytes}B) — treating as failure`);
      return null;
    }
    console.log(`[image] ${IMAGE_MODEL} ${width}x${height} ${Math.round(bytes / 1024)}KB ${Date.now() - started}ms`);
    return url;
  } catch (err) {
    console.warn(`[image] generation error: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
