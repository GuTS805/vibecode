import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Model selection.
 *
 * PRIMARY_MODEL defaults to `gemini-2.0-flash` as specified. Some Google AI Studio
 * projects report a hard free-tier entitlement of `limit: 0` for that pinned alias,
 * which returns 429 forever rather than transiently. FALLBACK_MODELS are tried in
 * order when the primary answers 429 (quota) or 404 (alias unavailable in region),
 * so the agent keeps running and automatically returns to the primary once the
 * project is entitled to it. See README > Known constraints.
 */
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-flash-latest,gemini-2.0-flash-lite')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const CHAIN = [PRIMARY_MODEL, ...FALLBACK_MODELS.filter((m) => m !== PRIMARY_MODEL)];

let client = null;
/** Sticky choice: once a model works we keep using it instead of re-burning 429s each call. */
let activeModel = null;

function getClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.');
  if (!client) client = new GoogleGenerativeAI(key);
  return client;
}

export function getActiveModel() {
  return activeModel || PRIMARY_MODEL;
}

const isQuotaOrMissing = (err) => {
  const s = err?.status ?? err?.response?.status;
  const msg = String(err?.message || '');
  return s === 429 || s === 404 || /429|404|quota|RESOURCE_EXHAUSTED|not found/i.test(msg);
};

/**
 * Generate text, walking the model chain on quota/availability errors.
 * Retries transient 5xx/network errors once per model with a short backoff.
 */
export async function generate(prompt, { json = false, temperature = 0.85, maxOutputTokens = 2048 } = {}) {
  // Try the sticky model first, then anything else in the chain.
  const order = activeModel ? [activeModel, ...CHAIN.filter((m) => m !== activeModel)] : CHAIN;

  let lastErr;
  for (const modelName of order) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const model = getClient().getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature,
            maxOutputTokens,
            ...(json ? { responseMimeType: 'application/json' } : {}),
          },
        });
        const res = await model.generateContent(prompt);
        const text = res.response.text();
        if (activeModel !== modelName) {
          console.log(`[gemini] using model: ${modelName}`);
          activeModel = modelName;
        }
        return text;
      } catch (err) {
        lastErr = err;
        if (isQuotaOrMissing(err)) break; // move to next model, don't retry this one
        await new Promise((r) => setTimeout(r, 800)); // transient — retry once
      }
    }
  }
  throw new Error(`All Gemini models failed (${CHAIN.join(', ')}): ${lastErr?.message || lastErr}`);
}

/** Generate and parse JSON, tolerating markdown fences the model sometimes emits. */
export async function generateJSON(prompt, opts = {}) {
  const raw = await generate(prompt, { ...opts, json: true });
  return parseLooseJSON(raw);
}

export function parseLooseJSON(raw) {
  const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(cleaned);
  } catch { /* fall through to repair */ }

  // Grab the outermost object/array in the response.
  const m = cleaned.match(/[{[][\s\S]*[}\]]/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch { /* fall through to repair */ }
  }

  const repaired = repairTruncatedJSON(cleaned);
  if (repaired) return repaired;

  throw new Error(`Model did not return valid JSON: ${cleaned.slice(0, 200)}`);
}

/**
 * Salvage a response cut off mid-generation by the output-token limit: drop the
 * incomplete tail and close any brackets left open. Losing the last rejection entry
 * is much better than discarding an entire cycle's judging work.
 */
function repairTruncatedJSON(s) {
  const start = s.search(/[{[]/);
  if (start === -1) return null;

  // Walk cut points from the end backwards; the first one that parses wins, so we
  // keep as much of the model's output as possible.
  for (let end = s.length; end > start + 1; end--) {
    let candidate = s.slice(start, end);

    // Track bracket depth and string state, ignoring escaped chars.
    const stack = [];
    let inStr = false, esc = false;
    for (const ch of candidate) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') stack.pop();
    }
    if (esc) continue;                    // ends on a dangling escape — cut earlier
    if (inStr) candidate += '"';          // truncated mid-string: close it
    candidate = candidate.replace(/,\s*$/, '');
    while (stack.length) candidate += stack.pop() === '{' ? '}' : ']';

    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* try an earlier cut point */ }
  }
  return null;
}
