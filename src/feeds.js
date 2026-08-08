/**
 * Feed-based discovery — the provider-independent path.
 *
 * Grounded discovery (one Gemini call with Google Search) is powerful but ties the whole
 * pipeline to one vendor's search product and its separately-metered quota. It also has a
 * failure mode this path structurally cannot have: a model asked to report URLs will
 * sometimes compose a plausible one, which is why the grounded path carries redirect
 * resolution and domain verification to catch it.
 *
 * Here every URL arrives from an actual feed response, so it is real by construction. No
 * LLM is involved in discovery at all, nothing is metered, and it works identically
 * whichever text provider is judging and writing.
 */
import Parser from 'rss-parser';
import { topicKey } from './discovery.js';

const parser = new Parser({ timeout: 12_000 });

const HN_TOP = 'https://hacker-news.firebaseio.com/v0/topstories.json';
const HN_ITEM = (id) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

/**
 * Source list, weighted toward security and primary technical writing.
 *
 * The general tech feeds alone produced a poor candidate pool for a specialist beat: mostly
 * secondary reporting on product announcements, which the SUBSTANCE and CREDIBILITY
 * standards reject on sight. Adding security-specific outlets that publish daily raised the
 * share of candidates that can plausibly clear the bar, without touching the bar itself.
 *
 * KNOWN LIMITATION: this list is tech and security only. Feed discovery therefore serves the
 * AI/security personas well and cannot serve the History, Geography, Sports, or Music
 * personas at all — those depend on grounded search, which runs its own queries per beat.
 * See README > Known constraints.
 */
const FEEDS = [
  // Security-specific, high publishing cadence.
  { name: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews' },
  { name: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/' },
  { name: 'Krebs on Security', url: 'https://krebsonsecurity.com/feed/' },
  { name: 'Schneier on Security', url: 'https://www.schneier.com/feed/atom/' },
  // Primary vendor research. Infrequent, but exactly the inspectable-artifact material the
  // credibility standard rewards; the staleness discount keeps old entries from crowding in.
  { name: 'Google Security Blog', url: 'https://security.googleblog.com/feeds/posts/default' },
  { name: 'Project Zero', url: 'https://googleprojectzero.blogspot.com/feeds/posts/default' },
  // General AI/tech.
  { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
  { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed/' },
];

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  mdash: '—', ndash: '–', hellip: '…', trade: '™',
};

/** Feed titles arrive HTML-escaped ("Jony Ive&#8217;s"); decode before storing or judging. */
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

async function fetchJSON(url, ms = 12_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fromHackerNews(limit = 30) {
  try {
    const ids = (await fetchJSON(HN_TOP)).slice(0, limit);
    const items = await Promise.all(ids.map((id) => fetchJSON(HN_ITEM(id)).catch(() => null)));
    return items
      .filter((i) => i?.title)
      .map((i) => ({
        title: decodeEntities(i.title),
        summary: '',
        url: i.url || `https://news.ycombinator.com/item?id=${i.id}`,
        publisher: i.url ? hostOf(i.url) || 'Hacker News' : 'Hacker News',
        source: 'Hacker News',
        publishedAt: new Date((i.time || 0) * 1000).toISOString(),
        score: i.score || 0,
      }));
  } catch (err) {
    console.warn('[feeds] Hacker News failed:', err.message);
    return [];
  }
}

async function fromRSS() {
  const batches = await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const parsed = await parser.parseURL(feed.url);
        return (parsed.items || []).slice(0, 12).map((i) => ({
          title: decodeEntities(i.title || ''),
          summary: decodeEntities(i.contentSnippet || i.summary || '').slice(0, 400),
          url: i.link || '',
          publisher: feed.name,
          source: feed.name,
          publishedAt: i.isoDate || i.pubDate || new Date().toISOString(),
          score: 0,
        }));
      } catch (err) {
        console.warn(`[feeds] ${feed.name} failed:`, err.message);
        return [];
      }
    })
  );
  return batches.flat().filter((i) => i.title && i.url);
}

/** Terms that make a story plausibly relevant to any AI/tech beat. */
const DOMAIN_HINTS =
  /\b(ai|llm|model|gpt|openai|anthropic|claude|gemini|neural|ml|agent|chatbot|inference|training|dataset|transformer|nvidia|gpu|chip|compute|algorithm|automation|robot|security|vulnerab|exploit|breach|malware|privacy|encryption|regulat|policy)\b/i;

const tokenize = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3);

/**
 * Order the pool by relevance to this persona's beat before it reaches the judge.
 *
 * This only orders — it never drops anything. A niche beat given the twelve freshest
 * headlines can correctly reject all of them and publish nothing for hours, which is
 * editorially right but operationally useless. Off-beat stories still reach the judge and
 * are still rejected on the record, because those rejections are a required feature.
 */
function rankForPersona(items, persona) {
  const beatTokens = new Set([
    ...tokenize(persona.domain),
    ...(persona.covers || []).flatMap((c) => tokenize(c)),
  ]);

  return [...items]
    .map((item) => {
      const haystack = `${item.title} ${item.summary}`;
      const overlap = tokenize(haystack).filter((t) => beatTokens.has(t)).length;
      const relevance = Math.min(1, overlap * 0.25) + (DOMAIN_HINTS.test(haystack) ? 0.35 : 0);
      const ageH = (Date.now() - new Date(item.publishedAt).getTime()) / 3_600_000;
      const freshness = Math.max(0, Math.min(1, 1 - ageH / 72));

      // Relevance is weighted heavily so niche beats get a usable pool, but unchecked it
      // lets a three-week-old story outrank today's news purely by being more on-topic —
      // spending a judging call on something TIMELINESS will reject anyway. Anything past
      // a week is discounted hard rather than excluded, so a genuinely major older story
      // can still surface.
      const staleness = ageH > 168 ? 0.3 : 1;

      return {
        ...item,
        ageHours: Number(ageH.toFixed(1)),
        freshness: Number(freshness.toFixed(2)),
        _score:
          relevance * 2 * staleness + freshness + Math.min(item.alsoSeenIn?.length || 0, 2) * 0.15,
      };
    })
    .sort((a, b) => b._score - a._score);
}

/**
 * Pull every source concurrently, collapse the same story across sources, rank for this
 * persona, and return candidates in the shape the judge already expects.
 *
 * `limit` is small on purpose: each candidate costs one judging call, and judging is the
 * expensive part of a cycle on any provider.
 */
export async function discoverFromFeeds(persona, memory, { limit = 6 } = {}) {
  const [hn, rss] = await Promise.all([fromHackerNews(), fromRSS()]);
  const all = [...hn, ...rss];

  // Collapse duplicates across sources, keeping the richest summary and noting corroboration.
  const byKey = new Map();
  for (const item of all) {
    if (!hostOf(item.url)) continue;
    const key = topicKey(item.title);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item, key, alsoSeenIn: [] });
    } else {
      if (item.source !== existing.source && !existing.alsoSeenIn.includes(item.source)) {
        existing.alsoSeenIn.push(item.source);
      }
      if (item.summary.length > existing.summary.length) existing.summary = item.summary;
      if (item.score > existing.score) existing.score = item.score;
    }
  }

  // Drop anything already published or rejected before it costs a judging call.
  const unseen = [...byKey.values()].filter((c) => !memory.seenKeys.has(c.key));
  const ranked = rankForPersona(unseen, persona).slice(0, limit);

  const candidates = ranked.map((c) => ({
    key: c.key,
    title: c.title,
    summary: c.summary || `Reported by ${c.publisher}.`,
    url: c.url,
    extraUrls: [],
    publisher: c.publisher,
    publishedAt: (c.publishedAt || '').slice(0, 10) || null,
    ageHours: c.ageHours,
    freshness: c.freshness,
    claimStatus: 'reported',
    whyOnBeat: c.alsoSeenIn.length
      ? `Covered by ${[c.source, ...c.alsoSeenIn].join(', ')}.`
      : `From ${c.source}.`,
    // URLs come straight from a feed response, so there is nothing to verify against a
    // search transcript — they are real by construction.
    resolvedFromGrounding: false,
    urlVerified: true,
    hostVerified: true,
    fromFeeds: true,
  }));

  console.log(
    `[feeds] ${all.length} items -> ${byKey.size} unique -> ${unseen.length} unseen -> ${candidates.length} candidates ` +
      `(${[...byKey.values()].filter((c) => c.alsoSeenIn.length).length} multi-source)`
  );

  return {
    candidates,
    searchNotes: `Pulled ${all.length} items from Hacker News and ${FEEDS.length} RSS feeds; ${byKey.size} unique stories after cross-source dedup.`,
    searchResults: { results: [], domains: new Set(), errors: [] },
  };
}
