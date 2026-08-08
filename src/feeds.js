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
 * Source list, tagged by beat.
 *
 * The security-specific outlets are weighted toward primary technical writing: the general
 * tech feeds alone produced a poor candidate pool for a specialist beat, mostly secondary
 * reporting on product announcements, which the SUBSTANCE and CREDIBILITY standards reject
 * on sight.
 *
 * The non-tech sections exist because the tech-only list was a silent shutout for four of
 * the six registered personas. A History or Music persona reading a security feed scores
 * every candidate near zero on BEAT FIT, correctly — so it rejected everything, every cycle,
 * and the empty feed looked like a strict editor rather than a source list that could not
 * possibly serve it. Beat tags let `selectFeeds` pull the right sources per persona.
 */
const FEEDS = [
  // Security-specific, high publishing cadence.
  { name: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews', beats: ['security', 'tech'] },
  { name: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/', beats: ['security', 'tech'] },
  { name: 'Krebs on Security', url: 'https://krebsonsecurity.com/feed/', beats: ['security'] },
  { name: 'Schneier on Security', url: 'https://www.schneier.com/feed/atom/', beats: ['security'] },
  // Primary vendor research. Infrequent, but exactly the inspectable-artifact material the
  // credibility standard rewards; the staleness discount keeps old entries from crowding in.
  { name: 'Google Security Blog', url: 'https://security.googleblog.com/feeds/posts/default', beats: ['security'] },
  { name: 'Project Zero', url: 'https://googleprojectzero.blogspot.com/feeds/posts/default', beats: ['security'] },
  // General AI/tech.
  { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', beats: ['tech'] },
  { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', beats: ['tech'] },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', beats: ['tech', 'science'] },
  { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed/', beats: ['tech', 'science'] },

  // History and archaeology.
  { name: 'Live Science', url: 'https://www.livescience.com/feeds/all', beats: ['history', 'science'] },
  { name: 'Smithsonian Magazine', url: 'https://www.smithsonianmag.com/rss/history/', beats: ['history'] },
  { name: 'Guardian Archaeology', url: 'https://www.theguardian.com/science/archaeology/rss', beats: ['history'] },

  // Geography, environment, earth science.
  { name: 'NASA Science', url: 'https://science.nasa.gov/feed/', beats: ['geography', 'science'] },
  { name: 'Guardian Environment', url: 'https://www.theguardian.com/environment/rss', beats: ['geography'] },
  { name: 'BBC Science & Environment', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', beats: ['geography', 'science'] },

  // Politics and policy.
  { name: 'NPR Politics', url: 'https://feeds.npr.org/1014/rss.xml', beats: ['politics'] },
  { name: 'Politico', url: 'https://rss.politico.com/politics-news.xml', beats: ['politics'] },
  { name: 'The Guardian Politics', url: 'https://www.theguardian.com/politics/rss', beats: ['politics'] },
  { name: 'BBC Politics', url: 'https://feeds.bbci.co.uk/news/politics/rss.xml', beats: ['politics'] },

  // Sport.
  { name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/rss.xml', beats: ['sports'] },
  { name: 'ESPN', url: 'https://www.espn.com/espn/rss/news', beats: ['sports'] },
  { name: 'The Guardian Sport', url: 'https://www.theguardian.com/sport/rss', beats: ['sports'] },

  // Music.
  { name: 'Pitchfork', url: 'https://pitchfork.com/feed/feed-news/rss', beats: ['music'] },
  { name: 'Rolling Stone Music', url: 'https://www.rollingstone.com/music/feed/', beats: ['music'] },
  { name: 'The Guardian Music', url: 'https://www.theguardian.com/music/rss', beats: ['music'] },
];

/** Words in a persona's beat that map it to a feed tag. */
const BEAT_KEYWORDS = {
  security: /secur|vulnerab|exploit|threat|malware|privacy|cryptograph|red.?team/i,
  tech: /\b(ai|ml|tech|software|comput|machine learning|llm|data|engineer|startup|internet)\b/i,
  history: /histor|archaeolog|ancient|medieval|antiquit|civilisation|civilization/i,
  geography: /geograph|climat|environment|earth|map|terrain|ocean|urban|migration/i,
  politics: /politic|policy|government|election|democra|diplomat|geopolit|legislat/i,
  sports: /sport|football|soccer|basketball|athlet|cricket|tennis|olympic|racing/i,
  music: /music|album|song|band|record|concert|touring|producer|genre/i,
  science: /science|research|physic|biolog|chemistr|astronom|space|medicine/i,
};

/**
 * The feeds worth pulling for this persona.
 *
 * Matching is on the persona's declared domain and covers list, so a persona added to the
 * registry later is served without touching this file. An unmatched beat falls back to the
 * full list rather than to nothing — a broad pool the judge mostly rejects is recoverable,
 * an empty pool is not.
 */
export function selectFeeds(persona) {
  const beatsMatching = (text) =>
    Object.entries(BEAT_KEYWORDS)
      .filter(([, pattern]) => pattern.test(text))
      .map(([beat]) => beat);

  // The declared domain is the authoritative signal and is tried alone first. Matching the
  // covers list as well sounds more thorough and is actively worse: a music persona whose
  // covers mention streaming data and the internet picks up the tech keyword, and then
  // half its pool is AI news. Covers are only consulted when the domain names no known
  // beat at all, which is the custom-persona case.
  const matched = beatsMatching(String(persona?.domain || '')).length
    ? beatsMatching(String(persona?.domain || ''))
    : beatsMatching((persona?.covers || []).join(' '));

  if (!matched.length) return FEEDS;

  const selected = FEEDS.filter((f) => f.beats.some((b) => matched.includes(b)));
  return selected.length ? selected : FEEDS;
}

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

async function fromRSS(feeds) {
  const batches = await Promise.all(
    feeds.map(async (feed) => {
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
function rankForPersona(items, persona, { techBeat = true } = {}) {
  const beatTokens = new Set([
    ...tokenize(persona.domain),
    ...(persona.covers || []).flatMap((c) => tokenize(c)),
  ]);

  return [...items]
    .map((item) => {
      const haystack = `${item.title} ${item.summary}`;
      const overlap = tokenize(haystack).filter((t) => beatTokens.has(t)).length;
      // The hint list is tech vocabulary, so it is only evidence of relevance for a tech or
      // security beat. Applied to a Music persona it would promote the one AI story in the
      // pool above everything actually on that beat.
      const hintBonus = techBeat && DOMAIN_HINTS.test(haystack) ? 0.35 : 0;
      const relevance = Math.min(1, overlap * 0.25) + hintBonus;
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
 * Take the top `limit` items, but no more than two from any one publisher.
 *
 * Ranking alone lets a single high-cadence feed fill every slot: a history beat pulling
 * three sources came back with six Live Science items, none of them from the archaeology
 * sources that exist precisely for that persona. The relaxation pass at the end matters —
 * when only one source responded, two candidates is worse than six, so the cap yields
 * rather than starve the cycle.
 */
function capPerSource(ranked, limit) {
  const counts = new Map();
  const picked = [];

  for (const item of ranked) {
    if (picked.length >= limit) break;
    const n = counts.get(item.publisher) || 0;
    if (n >= 2) continue;
    counts.set(item.publisher, n + 1);
    picked.push(item);
  }

  if (picked.length < limit) {
    for (const item of ranked) {
      if (picked.length >= limit) break;
      if (!picked.includes(item)) picked.push(item);
    }
  }

  return picked;
}

/**
 * Pull every source concurrently, collapse the same story across sources, rank for this
 * persona, and return candidates in the shape the judge already expects.
 *
 * `limit` is small on purpose: each candidate costs one judging call, and judging is the
 * expensive part of a cycle on any provider.
 */
export async function discoverFromFeeds(persona, memory, { limit = 6 } = {}) {
  const feeds = selectFeeds(persona);

  // Hacker News is a tech front page, so it only helps a tech or security beat. Pulling it
  // for a Music or History persona just fills the pool with candidates that beat fit will
  // correctly reject, crowding out the sources that could actually serve that persona.
  const wantsHN = feeds.some((f) => f.beats.includes('tech') || f.beats.includes('security'));

  const [hn, rss] = await Promise.all([wantsHN ? fromHackerNews() : [], fromRSS(feeds)]);
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
  const ranked = capPerSource(rankForPersona(unseen, persona, { techBeat: wantsHN }), limit);

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
    `[feeds] ${feeds.length} sources for "${persona.domain}" -> ${all.length} items -> ${byKey.size} unique -> ` +
      `${unseen.length} unseen -> ${candidates.length} candidates ` +
      `(${[...byKey.values()].filter((c) => c.alsoSeenIn.length).length} multi-source)`
  );

  return {
    candidates,
    searchNotes:
      `Pulled ${all.length} items from ${feeds.length} RSS feeds selected for this beat` +
      `${wantsHN ? ' plus Hacker News' : ''}; ${byKey.size} unique stories after cross-source dedup.`,
    searchResults: { results: [], domains: new Set(), errors: [] },
  };
}
