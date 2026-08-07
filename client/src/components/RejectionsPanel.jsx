import { useState } from 'react';
import { relativeTime } from '../api';

export default function RejectionsPanel({ rejections }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="card panel">
      <button className="panel-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="panel-title">Rejected topics</span>
        <span className="panel-toggle-right">
          <span className="count-badge">{rejections.length}</span>
          <span className={`caret${open ? ' caret-open' : ''}`}>▸</span>
        </span>
      </button>

      <div className={`collapsible${open ? ' collapsible-open' : ''}`}>
        <div className="collapsible-inner">
          {rejections.length === 0 ? (
            <p className="muted small">Nothing rejected yet.</p>
          ) : (
            <ul className="rejection-list">
              {rejections.map((r) => (
                <li key={r.id}>
                  <p className="rejection-topic">{r.topic}</p>
                  <p className="rejection-reason">{r.reason}</p>
                  <time dateTime={r.createdAt}>{relativeTime(r.createdAt)}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
