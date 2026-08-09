import { useState } from 'react';
import { relativeTime } from '../api';

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Human label for the structural format the writer used. */
const FORMAT_LABELS = {
  analysis: 'Analysis',
  contrarian: 'Counterpoint',
  'field-note': 'Field note',
  'threat-model': 'Threat model',
  context: 'Context',
  skeptic: 'Scrutiny',
};

/**
 * Post artwork.
 *
 * Generated images load from Pollinations' CDN, which can be slow on a cold cache and is a
 * third party that may be unreachable. The image is therefore never allowed to hold up or
 * break the card: a shimmer holds the aspect ratio while it loads, and a failure removes
 * the element entirely rather than leaving a broken-image icon in a permanent feed.
 */
function PostImage({ src, alt }) {
  const [state, setState] = useState('loading');

  if (state === 'error') return null;

  return (
    <figure className={`post-image${state === 'loaded' ? ' post-image-loaded' : ''}`}>
      {state === 'loading' && <div className="post-image-skeleton" aria-hidden="true" />}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setState('loaded')}
        onError={() => setState('error')}
      />
    </figure>
  );
}

/**
 * Initials for the author mark. Two words give two letters, one word gives one — the same
 * rule every contact list uses, so it reads as an avatar rather than as a decoration.
 */
function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '·';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/**
 * Break the post into paragraphs.
 *
 * Explicit blank lines are honoured first, because a writer who broke the text deliberately
 * knows where the break belongs. Failing that, a long single block is split once at the
 * sentence boundary closest to its midpoint: several personas are instructed to write one
 * or two paragraphs, so aggressive splitting would fight the voice, but a 250-word wall
 * with no visual entry point goes unread whatever it says.
 */
export function toParagraphs(text = '') {
  const explicit = String(text)
    .split(/\n{2,}|\r\n\r\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length > 1) return explicit;

  const body = explicit[0] || '';
  if (body.length < 520) return body ? [body] : [];

  // Sentence ends, keeping the terminator with the sentence it closes.
  const sentences = body.match(/[^.!?]+[.!?]+(?:\s|$)/g);
  if (!sentences || sentences.length < 4) return [body];

  const mid = body.length / 2;
  let run = 0;
  let cut = 0;
  let best = Infinity;
  for (let i = 0; i < sentences.length - 1; i++) {
    run += sentences[i].length;
    const distance = Math.abs(run - mid);
    if (distance < best) {
      best = distance;
      cut = i + 1;
    }
  }

  return [sentences.slice(0, cut).join('').trim(), sentences.slice(cut).join('').trim()].filter(Boolean);
}

/** Reading time, rounded up, floored at one minute. */
const readingMinutes = (text = '') =>
  Math.max(1, Math.round(String(text).trim().split(/\s+/).filter(Boolean).length / 220));

export default function PostCard({ post, isNew, author }) {
  const [open, setOpen] = useState(false);
  const formatLabel = post.format ? FORMAT_LABELS[post.format] || null : null;

  // The rationale ends with the source list, which is already rendered as links below.
  // Splitting it off keeps the editorial reasoning readable instead of trailing into URLs.
  const [reasoning, sourceTail] = splitRationale(post.rationale);

  const paragraphs = toParagraphs(post.text);
  const authorName = author?.name || 'Unknown author';
  const authorRole = author?.role || author?.domain || '';

  return (
    <article className={`card post-card${isNew ? ' card-enter' : ''}`}>
      {/* The byline is what makes this read as something written by someone rather than as
          a row in a table. It carries the persona identity the whole app is built around. */}
      <header className="post-byline">
        <span className="post-avatar" aria-hidden="true">
          {initials(authorName)}
        </span>
        <span className="post-byline-text">
          <span className="post-author">{authorName}</span>
          <span className="post-author-meta">
            {authorRole && <span className="post-author-role">{authorRole}</span>}
            <span className="dot-sep" aria-hidden="true">
              ·
            </span>
            <time dateTime={post.createdAt} title={new Date(post.createdAt).toLocaleString()}>
              {relativeTime(post.createdAt)}
            </time>
            <span className="dot-sep" aria-hidden="true">
              ·
            </span>
            <span>{readingMinutes(post.text)} min read</span>
          </span>
        </span>
        {post.tag && <span className="chip post-byline-chip">{post.tag}</span>}
      </header>

      <div className="post-body">
        {post.title && <h2 className="post-headline">{post.title}</h2>}

        {post.takeaway && <p className="post-deck">{post.takeaway}</p>}
      </div>

      {post.imageUrl && (
        <PostImage src={post.imageUrl} alt={`Illustration for: ${post.title || 'this post'}`} />
      )}

      <div className="post-body post-body-lower">
        {paragraphs.map((p, i) => (
          <p key={i} className="post-text">
            {p}
          </p>
        ))}

        <footer className="post-footer">
          {post.sources?.length > 0 && (
            <div className="sources">
              {post.sources.map((s) => (
                <a key={s} href={s} target="_blank" rel="noopener noreferrer" className="source-link">
                  <span className="source-dot" aria-hidden="true" />
                  {hostOf(s)}
                  <span className="source-arrow" aria-hidden="true">
                    ↗
                  </span>
                </a>
              ))}
            </div>
          )}

          <div className="post-footer-row">
            {/* The editorial reasoning is the part that distinguishes this from a scraper,
                so it gets a labelled affordance rather than a bare caret. */}
            <button className="disclosure" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              <span className={`caret${open ? ' caret-open' : ''}`} aria-hidden="true">
                ▸
              </span>
              {open ? 'Hide editorial reasoning' : 'Why this topic?'}
            </button>
            <span className="post-footer-marks">
              {formatLabel && <span className="post-format-mark">{formatLabel}</span>}
              <SocialBadge network="twitter" record={post.tweet} />
              <SocialBadge network="bluesky" record={post.skeet} />
            </span>
          </div>

          <div className={`collapsible${open ? ' collapsible-open' : ''}`}>
            <div className="collapsible-inner">
              <p className="rationale">{reasoning}</p>
              {sourceTail && <p className="rationale-sources">{sourceTail}</p>}
            </div>
          </div>
        </footer>
      </div>
    </article>
  );
}

/** Per-network glyph and verb for the badge — data, not a second copy of the component. */
const SOCIAL_BADGE = {
  twitter: { glyph: '𝕏', verb: 'tweeted', failVerb: 'tweet' },
  bluesky: { glyph: '🦋', verb: 'posted', failVerb: 'post' },
};

/**
 * Whether and how this post was promoted to a social network.
 *
 * Three distinct states, not two: a real post (a link out), a dry-run post (a preview of what
 * would have been sent, since dry run is the honest default until credentials are confirmed
 * working — see twitter.js / bluesky.js), and a failed attempt (surfaced rather than hidden,
 * since a silently-failing integration is worse than an absent one). No badge at all when
 * promotion was never attempted, which is the common case for most posts. Renders once per
 * network that has ever attempted this post — a post can carry both a tweet badge and a
 * Bluesky badge if both were enabled.
 */
function SocialBadge({ network, record }) {
  if (!record) return null;
  const { glyph, verb, failVerb } = SOCIAL_BADGE[network];

  if (record.error) {
    return (
      <span className={`tweet-mark tweet-mark-error`} title={record.error}>
        ⚠ {failVerb} failed
      </span>
    );
  }
  if (record.dryRun) {
    return (
      <span className="tweet-mark tweet-mark-dry" title={record.text}>
        {glyph} dry-run preview
      </span>
    );
  }
  return (
    <a
      className="tweet-mark tweet-mark-live"
      href={record.url}
      target="_blank"
      rel="noopener noreferrer"
      title={record.text}
    >
      {glyph} {verb} ↗
    </a>
  );
}

/** Separates the analytical sentences from the trailing "Sources: …" list. */
function splitRationale(rationale = '') {
  const i = rationale.search(/\bSources?:/i);
  if (i === -1) return [rationale, null];
  return [rationale.slice(0, i).trim(), rationale.slice(i).trim()];
}
