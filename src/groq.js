/**
 * Groq provider — OpenAI-compatible chat completions.
 *
 * Chosen as the default text provider because it fixes the constraint that shaped most of
 * the earlier design work: Gemini's free tier meters requests per model per day at around
 * 20, which is what forced the long fallback chain, the daily-call budget in the scheduler,
 * and the cadence stretching. Groq's free tier is measured in requests per minute and per
 * day at far higher volume, and responses come back in roughly 0.1-0.5s against Gemini's
 * 4-12s, so a full cycle stops being a quota event.
 *
 * What it does not have is web-search grounding. `groq/compound` advertises built-in search
 * but rejects even a minimal request with `request_too_large` on this key, so discovery runs
 * through the feed path instead (see src/feeds.js) — which is the more honest source of URLs
 * anyway, since every link comes from a real feed response.
 */

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Model chain. The primary is a capable instruct model with a large context; the rest are
 * fallbacks for rate limits rather than for capability. Unlike the Gemini chain, this is
 * failover only — it is not doing double duty as the capacity strategy.
 */
/**
 * `openai/gpt-oss-120b` is primary on measured quality, not size. Against the same fixed
 * candidate, llama-3.3-70b returned a 35-word draft that failed the length lint and a
 * takeaway of "New browser introduces new risks"; gpt-oss-120b returned 105 words first
 * pass, cleared the voice lint without regeneration, and produced a takeaway that actually
 * carried a claim. A regeneration costs a second call, so the better model is also cheaper.
 */
const PRIMARY_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const FALLBACK_MODELS = (
  process.env.GROQ_FALLBACK_MODELS || 'llama-3.3-70b-versatile,qwen/qwen3.6-27b,llama-3.1-8b-instant'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const CHAIN = [PRIMARY_MODEL, ...FALLBACK_MODELS.filter((m) => m !== PRIMARY_MODEL)];

/**
 * The model each kind of call starts from.
 *
 * A cycle makes six judging calls and one or two writes, and the binding free-tier limit is
 * tokens per minute. Left to one shared chain, the judging calls spend the primary model's
 * whole minute and the write — the only call whose output a reader ever sees — lands on
 * whatever is left. Observed directly: a music cycle judged six candidates, exhausted
 * gpt-oss-120b and llama-3.3-70b, and wrote the published post on llama-3.1-8b-instant, the
 * weakest model in the chain. The post was visibly flatter than the same pipeline's output
 * an hour earlier.
 *
 * Judging is the cheaper call to degrade: it returns a score and a sentence, and the
 * thresholds are enforced in code afterwards either way. So judging starts one rung down and
 * the primary model stays reserved for writing.
 */
const ROLE_MODELS = {
  judge: process.env.GROQ_JUDGE_MODEL || FALLBACK_MODELS[0] || PRIMARY_MODEL,
  write: process.env.GROQ_WRITE_MODEL || PRIMARY_MODEL,
};

/**
 * When a model was last rate-limited, so the next call can skip it rather than spend a
 * request rediscovering it. Without this, reserving a model per role would mean every call
 * re-probes a saturated model before falling through.
 */
const coolUntil = new Map();
const COOL_MS = Number(process.env.GROQ_COOLDOWN_MS || 30_000);

/**
 * The order to try models in for this call: the role's model first, then the rest of the
 * chain. Models known to be rate-limited go to the back rather than being dropped, so a
 * fully-saturated chain still makes an attempt instead of failing without one.
 */
function orderFor(role) {
  const preferred = ROLE_MODELS[role];
  const ranked = [preferred, ...CHAIN.filter((m) => m !== preferred)].filter(Boolean);
  const now = Date.now();
  const ready = ranked.filter((m) => (coolUntil.get(m) ?? 0) <= now);
  const cooling = ranked.filter((m) => (coolUntil.get(m) ?? 0) > now);
  return [...ready, ...cooling];
}

/**
 * Spacing between calls.
 *
 * The binding free-tier limit is tokens-per-minute, not requests. A cycle fires six judging
 * calls and up to two writes at roughly 1.6k tokens each, which lands well over the primary
 * model's per-minute token budget if issued back to back — observed directly: the first
 * cycle rate-limited the primary on call two and finished on the third-choice model, with
 * visibly flatter prose. Spacing the calls keeps the good model in play, and a cycle that
 * takes a minute instead of fifteen seconds is still an order of magnitude faster than the
 * provider this replaced.
 */
const MIN_CALL_GAP_MS = Number(process.env.GROQ_MIN_GAP_MS || 6_000);

/**
 * How long to wait out a per-minute limit before giving up on the current model. Dropping to
 * a weaker model is a quality loss that lasts for the whole post; waiting a few seconds is
 * not. Only short waits are honoured — anything longer means the model is genuinely
 * saturated and the fallback chain is the better answer.
 */
const MAX_RATE_LIMIT_WAIT_MS = Number(process.env.GROQ_MAX_RATE_WAIT_SECONDS || 20) * 1000;

let lastCallAt = 0;

async function throttle() {
  const wait = lastCallAt + MIN_CALL_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

let activeModel = null;
export const getActiveGroqModel = () => activeModel || PRIMARY_MODEL;

function getKey() {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    const e = new Error(
      'GROQ_API_KEY is not set. Copy .env.example to .env and add your key — free at https://console.groq.com/keys'
    );
    e.code = 'NO_API_KEY';
    e.retryable = false;
    throw e;
  }
  return key;
}

/* -------------------------------- error mapping -------------------------------- */

/**
 * Map Groq's responses onto the same codes the rest of the app already branches on, so the
 * scheduler and /trigger keep working without knowing which provider answered.
 */
function classify(status, body, model, retryAfter) {
  const message = String(body?.error?.message || body || '').slice(0, 300);

  if (status === 429) {
    // Groq distinguishes per-minute from per-day in the message text.
    const daily = /per day|RPD|TPD|daily/i.test(message);
    const e = new Error(
      daily
        ? `Groq daily quota is exhausted for ${model}. Other models in the chain are tried first, and it resets on Groq's daily schedule.`
        : `Groq rate limit reached for ${model}${retryAfter ? `; retry in about ${retryAfter}s` : ''}. This is a per-minute cap, not a pipeline failure.`
    );
    e.code = 'RATE_LIMITED';
    e.daily = daily;
    e.retryAfter = retryAfter;
    e.retryable = !daily;
    return e;
  }
  if (status === 401 || status === 403) {
    const e = new Error('Groq rejected the API key. Check GROQ_API_KEY.');
    e.code = 'AUTH_FAILED';
    e.retryable = false;
    return e;
  }
  if (status === 404 || /does not exist|decommissioned|model_not_found/i.test(message)) {
    const e = new Error(`Model "${model}" is not available on this key: ${message}`);
    e.code = 'BAD_MODEL';
    e.retryable = false;
    return e;
  }
  if (status === 413) {
    const e = new Error(`Groq rejected the request as too large for ${model}: ${message}`);
    e.code = 'TOO_LARGE';
    e.retryable = false;
    return e;
  }
  const e = new Error(`Groq API error ${status} on ${model}: ${message}`);
  e.code = 'API_ERROR';
  e.retryable = status >= 500;
  return e;
}

/** Conditions meaning "this model is unusable right now; try the next one". */
const shouldTryNextModel = (err) =>
  err.code === 'RATE_LIMITED' || err.code === 'BAD_MODEL' || err.code === 'TOO_LARGE';

/* ----------------------------------- calling ----------------------------------- */

export async function groqComplete({
  system,
  prompt,
  maxTokens = 2048,
  temperature = 0.8,
  json = false,
  label = 'call',
  role = 'default',
  timeoutMs = 90_000,
}) {
  getKey();

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  // Ordering is per role rather than sticky on the last model that happened to answer.
  // Stickiness pinned the writer to whichever weak model the judging calls had degraded to,
  // which is precisely backwards: the write is the call that most needs the good model.
  const order = orderFor(role);
  const started = Date.now();
  let lastErr;

  // Each model gets one chance to clear a short rate limit before the chain moves on.
  const waited = new Set();

  for (const model of order) {
    await throttle();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getKey()}`, 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });

      const raw = await res.text();
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }

      if (!res.ok) {
        const retryAfter = Number(res.headers.get('retry-after')) || null;
        throw classify(res.status, body, model, retryAfter);
      }

      const choice = body?.choices?.[0];
      const text = String(choice?.message?.content || '').trim();

      if (!text) {
        const e = new Error(`Groq returned an empty completion (finish_reason=${choice?.finish_reason}).`);
        e.code = choice?.finish_reason === 'length' ? 'TRUNCATED' : 'EMPTY';
        e.retryable = true;
        throw e;
      }

      coolUntil.delete(model);
      if (activeModel !== model) {
        console.log(`[groq] using model: ${model}`);
        activeModel = model;
      }

      const u = body.usage || {};
      console.log(
        `[groq:${label}] ${model} ${Date.now() - started}ms ` +
          `in=${u.prompt_tokens ?? '?'} out=${u.completion_tokens ?? '?'} finish=${choice?.finish_reason ?? '?'}`
      );

      // No grounding on Groq — discovery uses feeds, so nothing to report here.
      return { text, searchResults: { results: [], domains: new Set(), errors: [] } };
    } catch (err) {
      clearTimeout(timer);

      if (err.name === 'AbortError') {
        lastErr = Object.assign(new Error(`Groq request timed out after ${timeoutMs}ms`), {
          code: 'TIMEOUT',
          retryable: true,
        });
      } else if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|socket/i.test(String(err.message))) {
        lastErr = Object.assign(new Error(`Could not reach Groq: ${err.message}`), {
          code: 'NETWORK',
          retryable: true,
        });
      } else {
        lastErr = err.code ? err : classify(500, err.message, model, null);
      }

      if (lastErr.code === 'RATE_LIMITED') {
        // Remember it so the next call skips straight past rather than spending a request
        // to rediscover the same limit. `retry-after` is authoritative when present.
        const until = Date.now() + Math.max((lastErr.retryAfter ?? 0) * 1000, COOL_MS);
        coolUntil.set(model, lastErr.daily ? Date.now() + 3_600_000 : until);
      }

      if (!shouldTryNextModel(lastErr)) throw lastErr;

      // A short per-minute limit is worth waiting out: the alternative is finishing the post
      // on a weaker model, which degrades the output far more than a few seconds costs.
      if (
        lastErr.code === 'RATE_LIMITED' &&
        !lastErr.daily &&
        !waited.has(model) &&
        (lastErr.retryAfter ?? 0) * 1000 <= MAX_RATE_LIMIT_WAIT_MS
      ) {
        const waitMs = Math.max(1_000, (lastErr.retryAfter ?? 5) * 1000 + 500);
        waited.add(model);
        console.warn(`[groq] ${model} rate-limited; waiting ${Math.round(waitMs / 1000)}s rather than downgrading`);
        await new Promise((r) => setTimeout(r, waitMs));
        // Re-insert at the position just consumed. `for...of` tracks an index, so inserting
        // here makes the next iteration re-read this same model; the `waited` guard stops it
        // from looping. The rest of the chain keeps its order behind it.
        order.splice(order.indexOf(model), 0, model);
        continue;
      }

      console.warn(`[groq] ${model} unavailable (${lastErr.code}); trying next in chain`);
      // A permanently dead alias should not be retried on every later call.
      if (lastErr.code === 'BAD_MODEL') {
        const i = CHAIN.indexOf(model);
        if (i !== -1) {
          CHAIN.splice(i, 1);
          console.warn(`[groq] dropped ${model} from the chain for this process`);
        }
      }
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr || new Error(`All Groq models failed: ${CHAIN.join(', ')}`);
}
