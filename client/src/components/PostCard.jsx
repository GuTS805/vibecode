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
    <div className={`post-image${state === 'loaded' ? ' post-image-loaded' : ''}`}>
      {state === 'loading' && <div className="post-image-skeleton" aria-hidden="true" />}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setState('loaded')}
        onError={() => setState('error')}
      />
    </div>
  );
}

export default function PostCard({ post, isNew }) {
  const [open, setOpen] = useState(false);
  const formatLabel = post.format ? FORMAT_LABELS[post.format] || null : null;

  return (
    <article className={`card post-card${isNew ? ' card-enter' : ''}`}>
      {post.imageUrl && (
        <PostImage
          src={post.imageUrl}
          alt={`Abstract illustration for: ${post.title || 'this post'}`}
        />
      )}

      <div className="post-body">
        <div className="post-meta">
          {post.tag && <span className="chip">{post.tag}</span>}
          {formatLabel && <span className="chip chip-format">{formatLabel}</span>}
          <time dateTime={post.createdAt} title={new Date(post.createdAt).toLocaleString()}>
            {relativeTime(post.createdAt)}
          </time>
        </div>

        {post.takeaway && <p className="post-takeaway">{post.takeaway}</p>}

        <p className="post-text">{post.text}</p>

        <button className="disclosure" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className={`caret${open ? ' caret-open' : ''}`}>▸</span>
          Why this topic?
        </button>

        <div className={`collapsible${open ? ' collapsible-open' : ''}`}>
          <div className="collapsible-inner">
            <p className="rationale">{post.rationale}</p>
          </div>
        </div>

        {post.sources?.length > 0 && (
          <div className="sources">
            {post.sources.map((s) => (
              <a key={s} href={s} target="_blank" rel="noopener noreferrer" className="source-link">
                ↗ {hostOf(s)}
              </a>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
