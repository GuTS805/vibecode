/**
 * Text-provider router.
 *
 * Every text call in the pipeline goes through here so the provider is a configuration
 * choice rather than something wired into discovery, judging, and writing separately.
 *
 *   TEXT_PROVIDER=auto         (default) Groq -> Pollinations (if funded) -> Gemini
 *   TEXT_PROVIDER=groq         Force Groq
 *   TEXT_PROVIDER=gemini       Force Gemini
 *   TEXT_PROVIDER=pollinations Force Pollinations. Fails loudly if unfunded.
 *
 * Groq is preferred because its free tier is measured per minute at high volume rather than
 * ~20 requests per model per day, which is what previously forced a six-model fallback chain
 * and a daily-call budget just to publish a few posts. Resolution happens once per process
 * and then sticks; probing per call would spend a request to learn something that does not
 * change during a run.
 *
 * Images are always Pollinations regardless of this setting, because image generation there
 * is genuinely free while its text tier is not.
 */
import { complete as geminiComplete, getActiveModel as geminiModel, parseLooseJSON } from './gemini.js';
import { groqComplete, getActiveGroqModel } from './groq.js';
import { pollinationsComplete, hasPollinationsToken } from './pollinations.js';

export { SEARCH_TOOL, parseLooseJSON, withRetry } from './gemini.js';

const MODE = (process.env.TEXT_PROVIDER || 'auto').toLowerCase();

let resolved = null;

function resolveProvider() {
  if (resolved) return resolved;

  if (['groq', 'gemini', 'pollinations'].includes(MODE)) {
    resolved = MODE;
  } else if (process.env.GROQ_API_KEY) {
    resolved = 'groq';
  } else if (hasPollinationsToken()) {
    // Pollinations text needs a funded token; without one every call would 402.
    resolved = 'pollinations';
  } else {
    resolved = 'gemini';
  }

  console.log(`[llm] text provider: ${resolved}${MODE === 'auto' ? ' (auto)' : ' (forced)'}`);
  return resolved;
}

export const getTextProvider = () => resolveProvider();

/** Reported in /api/agent/status so the running configuration is visible, not inferred. */
export function getActiveModel() {
  switch (resolveProvider()) {
    case 'groq':
      return getActiveGroqModel();
    case 'pollinations':
      return process.env.POLLINATIONS_TEXT_MODEL || 'openai-fast';
    default:
      return geminiModel();
  }
}

const PROVIDERS = {
  groq: groqComplete,
  gemini: geminiComplete,
  pollinations: pollinationsComplete,
};

/**
 * One completion from whichever provider is active.
 *
 * On `auto`, a provider that turns out to be unusable for a reason no retry can fix — a
 * missing key, a rejected key, an unfunded account — hands off to the next one and the
 * process switches over. An explicitly forced provider is never silently overridden: if you
 * asked for it, its failure should surface rather than be papered over.
 */
export async function complete(opts) {
  const provider = resolveProvider();

  try {
    return await PROVIDERS[provider](opts);
  } catch (err) {
    const unusable = ['NO_API_KEY', 'AUTH_FAILED', 'POLLINATIONS_UNFUNDED'].includes(err.code);
    if (!unusable || MODE !== 'auto') throw err;

    const next = ['groq', 'gemini'].find((p) => p !== provider && hasCredentials(p));
    if (!next) throw err;

    console.warn(`[llm] ${provider} is unusable (${err.code}) — switching this process to ${next}`);
    resolved = next;
    return PROVIDERS[next](opts);
  }
}

const hasCredentials = (p) =>
  p === 'groq' ? Boolean(process.env.GROQ_API_KEY) : p === 'gemini' ? Boolean(process.env.GEMINI_API_KEY) : false;

export async function completeJSON(opts) {
  const { text, searchResults } = await complete({ ...opts, json: true });
  return { data: parseLooseJSON(text), searchResults };
}

/**
 * True when the active provider can run web searches. Only Gemini's Google Search grounding
 * can; Groq's `groq/compound` advertises it but rejects requests on the free tier. Discovery
 * uses this to pick between grounded search and the feed path.
 */
export function supportsGrounding() {
  return resolveProvider() === 'gemini';
}
