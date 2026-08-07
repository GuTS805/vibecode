import { complete, SEARCH_TOOL, parseLooseJSON, withRetry } from './gemini.js';
import { personaSystemPrompt } from './persona.js';

/** Words too generic to identify a story; dropped before building the dedup key. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'be', 'as', 'at', 'by', 'from', 'that', 'this', 'it', 'its', 'has', 'have', 'was', 'were',
  'new', 'now', 'how', 'why', 'what', 'says', 'said', 'will', 'can', 'you', 'your', 'we',
  'more', 'about', 'into', 'after', 'over', 'up', 'out', 'not', 'ai',
]);

/**
 * Crude suffix stemmer. Headlines about the same event routinely differ only in tense
 * or number — "OpenAI discloses" vs "flaw disclosed by OpenAI" — and without this the
 * dedup key treats them as different stories and pays to judge both.
 */
function stem(word) {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Stable identity for a story: its five most significant word stems, sorted.
 * "OpenAI discloses GPT-5 prompt injection flaw" and "Prompt injection flaw disclosed in
 * GPT-5, says OpenAI" collapse to the same key, so a story the agent has already seen is
 * filtered out before it costs a judging call, however the next search phrases it.
 */
export function topicKey(title) {
  const words = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map(stem);
  return [...new Set(words)].sort().slice(0, 5).join('-') || String(title).toLowerCase().slice(0, 40);
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

/** Google hands back opaque redirect links rather than the publisher's own URL. */
const isRedirect = (url) => /vertexaisearch\.cloud\.google\.com\/grounding-api-redirect/.test(url);

/**
 * Follow a grounding redirect to the article it points at.
 *
 * Grounding metadata never exposes the publisher's URL directly, and the model copies the
 * redirect into its answer, so without this step every stored source is an opaque
 * `vertexaisearch.cloud.google.com/...` link — one that tells a reader nothing and stops
 * resolving once the grounding session ages out. Resolving here means posts cite the real
 * article, and domain verification gets a real host to compare.
 *
 * Cheap and non-fatal: a handful of plain HTTP requests per cycle, no LLM quota involved,
 * and an unresolvable link simply stays as it was.
 */
async function resolveRedirect(url, timeoutMs = 10_000) {
  if (!isRedirect(url)) return url;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    // res.url is the final URL after following redirects.
    return res.url && !isRedirect(res.url) ? res.url : url;
  } catch {
    return url;
  } finally {
    clearTimeout(timer);
  }
}

function discoveryPrompt(persona, memory) {
  const covered = memory.publishedTopics.length
    ? memory.publishedTopics.map((t, i) => `${i + 1}. ${t}`).join('\n')
    : '(nothing published yet — this is the first cycle)';

  return `Search the web for current news and developments on your beat, then report the best candidates.

Today is ${new Date().toISOString().slice(0, 10)} (UTC).

YOUR BEAT, restated so your searches stay on it:
${persona.covers.map((c) => `- ${c}`).join('\n')}

WHAT TO SEARCH FOR
Run several searches covering those topics. Prioritise the last
72 hours; anything older than a week needs to be genuinely significant to be worth
reporting. Search for primary sources — vendor security advisories, research papers,
disclosure writeups, incident postmortems, official changelogs — not aggregator
roundups or opinion columns about the news.

YOU HAVE ALREADY PUBLISHED ON THESE TOPICS — do not resurface them:
${covered}

WHAT TO REPORT
Return the 3-4 strongest candidates you found. Include a candidate even if you suspect
it is weak; a separate editorial step judges each one and it needs real options to
reject. Do not pad the list — three good candidates beat four with filler, and every
extra candidate costs a separate judging call against a small daily quota.

For every candidate, copy the url EXACTLY as it appeared in your search results —
character for character, even if it is a long opaque redirect link. A redirect link is
expected and is preferred over a tidier one: it is resolved to the publisher's real
article afterwards, which is what makes the source checkable.

Do NOT reconstruct, clean up, shorten, or guess a URL, and do not write out a
publisher URL from memory because it looks more presentable. A plausible-looking URL you
composed yourself is worse than useless — it cannot be verified and the story will be
rejected for it.

Return ONLY JSON in exactly this shape, with no prose before or after:
{
  "candidates": [
    {
      "title": "<the story in one factual sentence, no editorialising>",
      "summary": "<2-3 sentences: what happened, who is involved, what is concretely new>",
      "url": "<the primary source URL, exactly as it appeared in search results>",
      "extraUrls": ["<0-2 further corroborating URLs from your search results>"],
      "publisher": "<the publishing organisation, e.g. 'NVIDIA Security Bulletin'>",
      "publishedAt": "<YYYY-MM-DD if you saw a date, otherwise null>",
      "claimStatus": "<'demonstrated' if there is an artifact/paper/advisory anyone can inspect, 'reported' if a credible outlet reports it, 'asserted' if it is only a vendor claim>",
      "whyOnBeat": "<one sentence tying it to a specific topic you cover>"
    }
  ],
  "searchNotes": "<one sentence on what you searched and how the results looked overall>"
}`;
}

/**
 * Discovery step: one Gemini call with Google Search grounding enabled.
 *
 * The model runs its own searches and reports structured candidates, which are then
 * checked against the sources grounding actually returned — a cheap guard against a
 * confidently transcribed link that never existed.
 *
 * The check is domain-level, not URL-level, and that is a real limitation rather than a
 * design choice: Gemini's grounding metadata gives Vertex redirect URLs, not publisher
 * links, so there is no full URL to compare against. A candidate whose host appears among
 * the grounded sources is corroborated; one whose host does not appear anywhere is
 * suspect. Unverified candidates are flagged rather than dropped — dropping them would
 * silently starve the feed — and the judge is told, so an unverifiable source fails the
 * credibility standard on the record.
 */
export async function discoverTopics(persona, memory) {
  const { text, searchResults } = await withRetry(
    () =>
      complete({
        system: personaSystemPrompt(persona),
        prompt: discoveryPrompt(persona, memory),
        tools: [SEARCH_TOOL],
        maxTokens: 8000,
        effort: 'medium',
        label: 'discover',
      }),
    { attempts: 2, label: 'discovery' }
  );

  const parsed = parseLooseJSON(text);
  const raw = Array.isArray(parsed?.candidates) ? parsed.candidates : [];

  const searchedUrls = new Set(searchResults.results.map((r) => r.url));
  const searchedHosts = searchResults.domains;

  const seen = new Set();
  const candidates = [];

  for (const c of raw) {
    const title = String(c?.title || '').trim();
    const rawUrl = String(c?.url || '').trim();
    if (!title || !rawUrl || !hostOf(rawUrl)) continue;

    const key = topicKey(title);
    if (seen.has(key)) continue; // two searches surfaced the same story
    seen.add(key);

    // Resolve before verifying: a redirect's host is Google's, which would fail the
    // domain check on every candidate and make the stored source unusable.
    const wasRedirect = isRedirect(rawUrl);
    const url = await resolveRedirect(rawUrl);
    // Following Google's own redirect to its destination is the strongest check available
    // here: the link provably exists and is provably what the search returned. A URL the
    // model typed out itself gets only the weaker domain comparison.
    const resolvedFromGrounding = wasRedirect && url !== rawUrl;

    const extraUrls = (
      await Promise.all(
        (Array.isArray(c.extraUrls) ? c.extraUrls : [])
          .map((u) => String(u).trim())
          .filter((u) => hostOf(u))
          .slice(0, 2)
          .map((u) => resolveRedirect(u))
      )
      // A redirect that would not resolve is dropped from the corroborating links: it
      // adds an opaque, expiring URL to the post's sources and nothing a reader can use.
      // The primary url is kept either way — an unresolved source beats no source.
    ).filter((u) => u !== url && !isRedirect(u));

    candidates.push({
      key,
      title,
      summary: String(c.summary || '').trim(),
      url,
      extraUrls,
      publisher: String(c.publisher || hostOf(url)).trim(),
      publishedAt: c.publishedAt || null,
      ageHours: ageHours(c.publishedAt),
      claimStatus: ['demonstrated', 'reported', 'asserted'].includes(c.claimStatus)
        ? c.claimStatus
        : 'reported',
      whyOnBeat: String(c.whyOnBeat || '').trim(),
      resolvedFromGrounding,
      urlVerified: resolvedFromGrounding || searchedUrls.has(rawUrl) || searchedUrls.has(url),
      hostVerified: searchedHosts.has(hostOf(url)),
    });
  }

  console.log(
    `[discovery] ${candidates.length} candidates from ${searchResults.results.length} grounded sources ` +
      `(${candidates.filter((c) => c.urlVerified || c.hostVerified).length} corroborated)` +
      (searchResults.results.length === 0 ? ' [WARNING: no grounding metadata — search may not have run]' : '')
  );

  return { candidates, searchNotes: String(parsed?.searchNotes || '').trim(), searchResults };
}

function ageHours(publishedAt) {
  if (!publishedAt) return null;
  const t = new Date(publishedAt).getTime();
  if (Number.isNaN(t)) return null;
  return Number(((Date.now() - t) / 3_600_000).toFixed(1));
}
