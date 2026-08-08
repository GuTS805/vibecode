/**
 * Text-provider router.
 *
 * Every text call in the pipeline goes through here so the provider is a configuration
 * choice rather than something wired into discovery, judging, and writing separately.
 *
 *   TEXT_PROVIDER=auto         (default) Pollinations when it is funded, else Gemini.
 *   TEXT_PROVIDER=pollinations Force Pollinations. Fails loudly if unfunded.
 *   TEXT_PROVIDER=gemini       Force Gemini.
 *
 * "auto" resolves once per process and then sticks. Probing per call would spend a request
 * on every call to learn something that does not change during a run.
 *
 * Note the asymmetry: images always come from Pollinations regardless of this setting,
 * because image generation there is genuinely free while text is not.
 */
import { complete as geminiComplete, getActiveModel as geminiModel } from './gemini.js';
import { pollinationsComplete, hasPollinationsToken } from './pollinations.js';

export { SEARCH_TOOL, parseLooseJSON, withRetry } from './gemini.js';

const MODE = (process.env.TEXT_PROVIDER || 'auto').toLowerCase();

let resolved = null;

function resolveProvider() {
  if (resolved) return resolved;

  if (MODE === 'pollinations') {
    resolved = 'pollinations';
  } else if (MODE === 'gemini') {
    resolved = 'gemini';
  } else {
    // A token is the only thing that makes Pollinations text usable. Without one, every
    // call would 402, so auto stays on Gemini rather than breaking the pipeline.
    resolved = hasPollinationsToken() ? 'pollinations' : 'gemini';
  }

  console.log(
    `[llm] text provider: ${resolved}` +
      (MODE === 'auto' && resolved === 'gemini'
        ? ' (Pollinations text needs POLLINATIONS_TOKEN — its anonymous balance is 0; images still use Pollinations)'
        : '')
  );
  return resolved;
}

export function getTextProvider() {
  return resolveProvider();
}

/** Reported in /api/agent/status so the running configuration is visible, not inferred. */
export function getActiveModel() {
  return resolveProvider() === 'pollinations'
    ? process.env.POLLINATIONS_TEXT_MODEL || 'openai-fast'
    : geminiModel();
}

/**
 * One completion from whichever provider is active.
 *
 * When auto-selected Pollinations turns out to be unfunded mid-run, fall back to Gemini
 * once and switch the process over. An explicit TEXT_PROVIDER=pollinations is never
 * silently overridden — if you asked for that provider, a failure should surface.
 */
export async function complete(opts) {
  const provider = resolveProvider();

  if (provider === 'pollinations') {
    try {
      return await pollinationsComplete(opts);
    } catch (err) {
      if (err.code === 'POLLINATIONS_UNFUNDED' && MODE === 'auto') {
        console.warn('[llm] Pollinations text is unfunded — switching this process to Gemini');
        resolved = 'gemini';
        return geminiComplete(opts);
      }
      throw err;
    }
  }

  return geminiComplete(opts);
}

export async function completeJSON(opts) {
  const { parseLooseJSON } = await import('./gemini.js');
  const { text, searchResults } = await complete({ ...opts, json: true });
  return { data: parseLooseJSON(text), searchResults };
}

/** True when the active provider can run web searches — only Gemini grounding can. */
export function supportsGrounding() {
  return resolveProvider() === 'gemini';
}
