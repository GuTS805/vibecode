import Parser from 'rss-parser';

const parser = new Parser({ timeout: 10_000 });

const HN_TOP = 'https://hacker-news.firebaseio.com/v0/topstories.json';
const HN_ITEM = (id) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

const RSS_FEEDS = [
  { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
];

/** Words too generic to help identify a story; dropped before building the dedup key. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'be', 'as', 'at', 'by', 'from', 'that', 'this', 'it', 'its', 'has', 'have', 'was', 'were',
  'new', 'now', 'how', 'why', 'what', 'says', 'said', 'will', 'can', 'you', 'your', 'we',
  'show', 'ask', 'hn', 'more', 'about', 'into', 'after', 'over', 'up', 'out', 'not',
]);

/**
 * Stable identity for a story: the 5 most significant words, sorted.
 * "OpenAI launches GPT-5 model" and "GPT-5: OpenAI launches new model" collapse to
 * the same key, so the same story from HN and TechCrunch is judged only once.
 */
export function topicKey(title) {
  const words = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)].sort().slice(0, 5).join('-') || String(title).toLowerCase().slice(0, 40);
}

const hoursAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 3_600_000;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  mdash: '—', ndash: '–', hellip: '…', trade: '™',
};

/** RSS titles arrive HTML-escaped ("Jony Ive&#8217;s"); decode before storing or judging. */
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJSON(url, ms = 10_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fromHackerNews(limit = 25) {
  try {
    const ids = (await fetchJSON(HN_TOP)).slice(0, limit);
    const items = await Promise.all(
      ids.map((id) => fetchJSON(HN_ITEM(id)).catch(() => null))
    );
    return items
      .filter((i) => i && i.title)
      .map((i) => ({
        title: decodeEntities(i.title),
        url: i.url || `https://news.ycombinator.com/item?id=${i.id}`,
        source: 'Hacker News',
        publishedAt: new Date((i.time || 0) * 1000).toISOString(),
        score: i.score || 0,
      }));
  } catch (err) {
    console.warn('[discovery] Hacker News failed:', err.message);
    return [];
  }
}

async function fromRSS() {
  const results = await Promise.all(
    RSS_FEEDS.map(async (feed) => {
      try {
        const parsed = await parser.parseURL(feed.url);
        return (parsed.items || []).slice(0, 12).map((i) => ({
          title: decodeEntities(i.title || ''),
          url: i.link || '',
          source: feed.name,
          publishedAt: i.isoDate || i.pubDate || new Date().toISOString(),
          score: 0,
        }));
      } catch (err) {
        console.warn(`[discovery] ${feed.name} failed:`, err.message);
        return [];
      }
    })
  );
  return results.flat().filter((i) => i.title && i.url);
}

/**
 * Pull from every source, deduplicate the same story across sources, and attach a
 * freshness score (1.0 = brand new, decaying to 0 at 72h) used by the judge.
 */
export async function discoverTopics() {
  const [hn, rss] = await Promise.all([fromHackerNews(), fromRSS()]);
  const all = [...hn, ...rss];

  const byKey = new Map();
  for (const item of all) {
    const key = topicKey(item.title);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item, key, alsoSeenIn: [] });
    } else {
      // Same story from a second source — merge rather than judge it twice.
      if (!existing.alsoSeenIn.includes(item.source) && item.source !== existing.source) {
        existing.alsoSeenIn.push(item.source);
      }
      if (item.score > existing.score) existing.score = item.score;
    }
  }

  return [...byKey.values()]
    .map((t) => {
      const age = hoursAgo(t.publishedAt);
      const freshness = Number(Math.max(0, Math.min(1, 1 - age / 72)).toFixed(2));
      return { ...t, ageHours: Number(age.toFixed(1)), freshness };
    })
    .sort((a, b) => b.freshness + b.alsoSeenIn.length - (a.freshness + a.alsoSeenIn.length));
}
