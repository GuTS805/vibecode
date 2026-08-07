import { useState } from 'react';
import { relativeTime } from '../api';

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export default function PostCard({ post, isNew }) {
  const [open, setOpen] = useState(false);

  return (
    <article className={`card post-card${isNew ? ' card-enter' : ''}`}>
      <div className="post-meta">
        {post.tag && <span className="chip">{post.tag}</span>}
        <time dateTime={post.createdAt} title={new Date(post.createdAt).toLocaleString()}>
          {relativeTime(post.createdAt)}
        </time>
      </div>

      <p className="post-text">{post.text}</p>

      <button
        className="disclosure"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
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
    </article>
  );
}
