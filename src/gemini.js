import { GoogleGenAI, ApiError } from '@google/genai';

/**
 * Gemini client for the whole pipeline.
 *
 * Everything the agent does — discovery, judging, writing, the voice review — goes
 * through `complete()`. That gives one place to handle what a 48-hour unattended run on
 * a free tier actually needs: a model fallback chain for quota exhaustion, error
 * classification specific enough that the scheduler can tell "retry in ten minutes" from
 * "retrying cannot help", and grounding-metadata extraction for source verification.
 */

/**
 * Model selection.
 *
 * `gemini-2.5-flash` is the primary: it is on the free tier, supports Google Search
 * grounding, and supports thinking budgets. FALLBACK_MODELS are tried in order when the
 * primary returns 429 (quota) or 404 (alias unavailable in this project/region) — some
 * free-tier projects report a hard entitlement of `limit: 0` on a given alias, which
 * returns 429 forever rather than transiently, so retrying the same model can never
 * succeed. Once a model works it is used for subsequent calls instead of re-burning 429s.
 */
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

/**
 * The free tier's daily cap is `GenerateRequestsPerDayPerProjectPerModel` — measured
 * per model, and small (20/day/model on the key this was built against). A long chain is
 * therefore not just failover, it is the capacity strategy: each model contributes its own
 * daily allowance, so six usable models is roughly six times the headroom of one. Entries
 * that turn out to be unavailable are dropped from the chain at runtime.
 */
const FALLBACK_MODELS = (
  process.env.GEMINI_FALLBACK_MODELS ||
  'gemini-3.5-flash,gemini-flash-latest,gemini-3-flash-preview,gemini-3.6-flash,gemini-2.0-flash-lite'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const CHAIN = [PRIMARY_MODEL, ...FALLBACK_MODELS.filter((m) => m !== PRIMARY_MODEL)];

/** Google Search grounding. Free tier includes a daily allowance of grounded requests. */
export const SEARCH_TOOL = { googleSearch: {} };

/** Thinking budgets, in tokens, mapped from the pipeline's abstract effort levels. */
const EFFORT_BUDGET = { low: 0, medium: 2048, high: 8192 };

/**
 * How long to wait out a per-minute rate limit when the server does not send a
 * retry-after. The free tier's window is a minute, so anything shorter just burns
 * another attempt against a quota that has not reset.
 */
const RATE_LIMIT_BACKOFF_MS = Number(process.env.RATE_LIMIT_BACKOFF_SECONDS || 35) * 1000;

/** Minimum gap between consecutive API calls, to stay under the free tier's RPM cap. */
const MIN_CALL_GAP_MS = Number(process.env.MIN_CALL_GAP_MS || 4_000);

let lastCallAt = 0;

/**
 * Serialize the run rate of outbound calls.
 *
 * A cycle fires one discovery call, one judging call per candidate, and one write call
 * per published post. Issued back-to-back that is comfortably over the free tier's
 * requests-per-minute cap, and the first live run died exactly there — on the write call,
 * after judging had already succeeded. Cycles are hours apart, so spacing calls by a few
 * seconds costs nothing that matters.
 */
async function throttle() {
  const wait = lastCallAt + MIN_CALL_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

let client = null;
/** Sticky choice: once a model works we keep using it rather than re-testing the chain. */
let activeModel = null;

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const e = new Error(
      'GEMINI_API_KEY is not set. Copy .env.example to .env and add your key — free, no card required: https://aistudio.google.com/apikey'
    );
    e.code = 'NO_API_KEY';
    e.retryable = false; // retrying a missing key cannot help
    throw e;
  }
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

export const getActiveModel = () => activeModel || PRIMARY_MODEL;

/* -------------------------------- error mapping ------------------------------- */

const statusOf = (err) => err?.status ?? err?.response?.status ?? null;

/** True for the two conditions that mean "this model is unusable; try the next one". */
function isQuotaOrMissing(err) {
  const status = statusOf(err);
  if (status === 429 || status === 404) return true;
  return /\b429\b|\b404\b|quota|RESOURCE_EXHAUSTED|not found/i.test(String(err?.message || ''));
}

/**
 * Map transport and API failures onto codes the rest of the app branches on. Google
 * reports per-minute and per-day caps through the same 429, and the distinction matters:
 * a per-minute cap clears on its own, a daily cap does not until midnight Pacific.
 */
function classify(err, model = getActiveModel(), grounded = false) {
  if (err?.code) return err; // already ours

  const status = statusOf(err);
  const message = String(err?.message || '');

  if (status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(message)) {
    const daily = /PerDay/i.test(message);
    const retry = message.match(/retry in ([0-9.]+)s/i)?.[1];

    // Google Search grounding is metered separately from text generation, and the
    // grounding allowance is project-wide rather than per-model. Verified directly: the
    // same model, key, and moment answers a plain request and 429s a grounded one. So a
    // 429 on a grounded call means something different from a 429 on a plain one, and
    // saying "this key is out of quota" would be wrong — generation may be fine.
    const e = new Error(
      grounded
        ? 'Google Search grounding quota is exhausted for this project. It is metered separately ' +
          'from text generation and shared across all models, so no fallback model can serve a ' +
          'grounded request until it resets at midnight Pacific. Judging and writing are unaffected. ' +
          'The autonomous loop keeps ticking and discovery resumes as soon as grounding returns.'
        : daily
          ? `Daily generation quota is exhausted for ${model}. It resets at midnight Pacific Time. ` +
            'The loop keeps ticking and other models in the chain are tried first.'
          : `Gemini rate limit reached${retry ? `; retry in about ${Math.ceil(Number(retry))}s` : ''}. ` +
            'This is a per-minute cap on the free tier, not a failure of the pipeline.'
    );
    e.code = grounded ? 'GROUNDING_QUOTA' : 'RATE_LIMITED';
    e.daily = daily || grounded;
    e.grounded = grounded;
    e.retryAfter = retry ? Math.ceil(Number(retry)) : null;
    // Neither a daily cap nor an exhausted grounding allowance clears inside the
    // scheduler's short retry window.
    e.retryable = !daily && !grounded;
    return e;
  }
  if (status === 401 || status === 403) {
    const e = new Error('Google rejected the API key. Check GEMINI_API_KEY.');
    e.code = 'AUTH_FAILED';
    e.retryable = false;
    return e;
  }
  if (status === 404) {
    // Name the model that actually failed, not the sticky one — otherwise a dead entry
    // in the fallback chain reports itself as a failure of the primary model.
    const e = new Error(`Model "${model}" is not available to this key: ${message.slice(0, 160)}`);
    e.code = 'BAD_MODEL';
    e.retryable = false;
    return e;
  }
  if (err instanceof ApiError) {
    const e = new Error(`Gemini API error ${status}: ${message}`);
    e.code = 'API_ERROR';
    e.retryable = status >= 500;
    return e;
  }
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|socket/i.test(message)) {
    const e = new Error(`Could not reach the Gemini API: ${message}`);
    e.code = 'NETWORK';
    e.retryable = true;
    return e;
  }

  const e = new Error(message || String(err));
  e.code = 'UNKNOWN';
  e.retryable = false;
  return e;
}

/* ---------------------------------- calling ---------------------------------- */

/**
 * One completion, walking the model chain on quota/availability errors.
 *
 * Returns the response text plus the grounding sources the model actually saw, which the
 * discovery step uses to check candidate URLs against real search hits rather than
 * trusting the model's transcription of them.
 */
export async function complete({
  system,
  prompt,
  maxTokens = 2048,
  effort = 'medium',
  thinking = true,
  tools = [],
  json = false,
  label = 'call',
}) {
  const ai = getClient();

  // Try the sticky model first, then anything else in the chain.
  const order = activeModel ? [activeModel, ...CHAIN.filter((m) => m !== activeModel)] : CHAIN;

  const started = Date.now();
  let lastErr;

  for (const model of order) {
    const config = {
      systemInstruction: system,
      maxOutputTokens: maxTokens,
      ...(tools.length ? { tools } : {}),
      // Structured output and tools are mutually exclusive on Gemini — asking for both
      // is rejected. Grounded calls therefore fall back to prompt-instructed JSON, which
      // parseLooseJSON handles.
      ...(json && !tools.length ? { responseMimeType: 'application/json' } : {}),
      // Thinking budgets exist only on the 2.5 series; sending the field to a 2.0 model
      // is an error, so it is attached per-model rather than per-request.
      ...(thinking && model.includes('2.5')
        ? { thinkingConfig: { thinkingBudget: EFFORT_BUDGET[effort] ?? EFFORT_BUDGET.medium } }
        : {}),
    };

    try {
      await throttle();
      const response = await ai.models.generateContent({ model, contents: prompt, config });

      // A prompt blocked by safety filters returns a response with no candidates.
      const blockReason = response.promptFeedback?.blockReason;
      if (blockReason) {
        const e = new Error(`Gemini blocked the prompt (${blockReason}).`);
        e.code = 'BLOCKED';
        e.retryable = false;
        throw e;
      }

      const candidate = response.candidates?.[0];
      const text = (response.text || '').trim();

      if (!text && candidate?.finishReason === 'MAX_TOKENS') {
        const e = new Error(`Response hit maxOutputTokens (${maxTokens}) before producing any text.`);
        e.code = 'TRUNCATED';
        e.retryable = true;
        throw e;
      }
      if (!text && candidate?.finishReason === 'SAFETY') {
        const e = new Error('Gemini stopped generation for safety reasons.');
        e.code = 'BLOCKED';
        e.retryable = false;
        throw e;
      }

      if (activeModel !== model) {
        console.log(`[gemini] using model: ${model}`);
        activeModel = model;
      }

      const usage = response.usageMetadata || {};
      console.log(
        `[gemini:${label}] ${model} ${Date.now() - started}ms ` +
          `in=${usage.promptTokenCount ?? '?'} out=${usage.candidatesTokenCount ?? '?'} ` +
          `finish=${candidate?.finishReason ?? '?'}`
      );

      return { text, searchResults: extractSearchResults(response) };
    } catch (err) {
      const grounded = tools.length > 0 && statusOf(err) === 429;
      lastErr = classify(err, model, grounded);

      // Grounding quota is project-wide, so walking the chain cannot help — every model
      // would return the same 429. Fail immediately instead of burning six requests and
      // half a minute discovering that.
      if (lastErr.code === 'GROUNDING_QUOTA') {
        console.warn('[gemini] grounding quota exhausted — no model can serve this call');
        throw lastErr;
      }

      // Quota or a missing alias means this model is unusable — move down the chain
      // rather than retrying it. Anything else is not a model problem, so stop here.
      if (!isQuotaOrMissing(err)) throw lastErr;
      console.warn(`[gemini] ${model} unavailable (${lastErr.code}); trying next in chain`);
      // A model that is permanently gone should not be retried on every later call.
      if (lastErr.code === 'BAD_MODEL') {
        const i = CHAIN.indexOf(model);
        if (i !== -1) {
          CHAIN.splice(i, 1);
          console.warn(`[gemini] dropped ${model} from the chain for this process`);
        }
      }
    }
  }

  throw lastErr || classify(new Error(`All models failed: ${CHAIN.join(', ')}`));
}

/** Same call, parsed as JSON. */
export async function completeJSON(opts) {
  const { text, searchResults } = await complete({ ...opts, json: true });
  return { data: parseLooseJSON(text), searchResults };
}

/**
 * Retry wrapper for a whole logical step. The model chain already covers quota; this
 * covers what it cannot — a truncated response, a network blip, or a reply that did not
 * parse as JSON — where the fix is simply to ask again.
 */
export async function withRetry(fn, { attempts = 2, label = 'step', delayMs = 3_000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err.retryable !== false;
      console.warn(`[retry] ${label} attempt ${i}/${attempts} failed (${err.code || 'ERR'}): ${err.message}`);
      if (!retryable || i === attempts) break;

      // A per-minute quota does not clear in three seconds. Honour the server's
      // retry-after when it gives one, otherwise wait out the minute window.
      const wait = err.retryAfter
        ? err.retryAfter * 1000 + 1_000
        : err.code === 'RATE_LIMITED'
          ? RATE_LIMIT_BACKOFF_MS
          : delayMs * i;
      console.warn(`[retry] ${label} waiting ${Math.round(wait / 1000)}s before attempt ${i + 1}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/* -------------------------- grounding metadata (sources) ----------------------- */

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

/**
 * Pull the sources Google Search grounding actually returned.
 *
 * An important limitation: `web.uri` is a Vertex redirect URL, not the publisher's own
 * link, so it cannot be compared against the real URLs the model reports for a story.
 * `web.title` is normally the source domain ("techcrunch.com"), so that is what feeds
 * domain-level verification. This is weaker than matching a full URL, and the README
 * says so rather than implying the check is stronger than it is.
 */
export function extractSearchResults(response) {
  const results = [];
  const domains = new Set();

  for (const candidate of response.candidates || []) {
    for (const chunk of candidate.groundingMetadata?.groundingChunks || []) {
      const web = chunk.web;
      if (!web?.uri) continue;

      results.push({ url: web.uri, title: web.title || '' });

      // Titles are usually bare domains; anything host-shaped counts as a seen source.
      const title = String(web.title || '').trim().toLowerCase();
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(title)) domains.add(title.replace(/^www\./, ''));

      const host = hostOf(web.uri);
      // Skip the redirect host itself — it identifies Google, not the source.
      if (host && !host.endsWith('google.com')) domains.add(host);
    }
  }

  return { results, domains, errors: [] };
}

/* ------------------------------- JSON parsing -------------------------------- */

/**
 * Grounded calls cannot use Gemini's JSON mode, so the JSON contract lives in the prompt
 * and is enforced here. This tolerates the two things models actually do: wrapping the
 * object in a markdown fence, and running out of output tokens mid-object.
 */
export function parseLooseJSON(raw) {
  const cleaned = String(raw)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');

  try {
    return JSON.parse(cleaned);
  } catch { /* fall through */ }

  const outermost = cleaned.match(/[{[][\s\S]*[}\]]/);
  if (outermost) {
    try {
      return JSON.parse(outermost[0]);
    } catch { /* fall through */ }
  }

  const repaired = repairTruncatedJSON(cleaned);
  if (repaired) return repaired;

  const e = new Error(`Model did not return valid JSON: ${cleaned.slice(0, 200)}`);
  e.code = 'BAD_JSON';
  e.retryable = true;
  throw e;
}

/**
 * Salvage a response cut off by the output-token limit: walk cut points backwards from
 * the end, close whatever brackets are still open, and keep the first candidate that
 * parses. Losing the last array element beats discarding the entire step's work.
 */
function repairTruncatedJSON(s) {
  const start = s.search(/[{[]/);
  if (start === -1) return null;

  for (let end = s.length; end > start + 1; end--) {
    let candidate = s.slice(start, end);

    const stack = [];
    let inStr = false;
    let esc = false;
    for (const ch of candidate) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') stack.pop();
    }
    if (esc) continue;
    if (inStr) candidate += '"';
    candidate = candidate.replace(/,\s*$/, '');
    while (stack.length) candidate += stack.pop() === '{' ? '}' : ']';

    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* try an earlier cut point */ }
  }
  return null;
}
