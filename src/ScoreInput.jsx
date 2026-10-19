// Numeric per-category score entry. Snaps to tenths and clamps to
// [min, max] — mirrors the DB's scores range/tenths check constraint.
import { useState, useEffect } from 'react';

// Snap to nearest 0.10 and clamp to [min,max]. Float-safe (no 8.6999999).
export function normalizeScore(raw, min, max) {
  if (raw === '' || raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.min(max, Math.max(min, n));
  return Math.round(clamped * 10) / 10;
}

// Allow only digits and a single decimal point while typing. Precision beyond
// tenths is allowed here and snapped to the nearest 0.10 on commit.
function sanitizeTyping(s) {
  s = s.replace(/[^0-9.]/g, '');
  const dot = s.indexOf('.');
  if (dot !== -1) {
    s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
  }
  return s;
}

export default function ScoreInput({ categoryName, value, min, max, onCommit, disabled }) {
  const [text, setText] = useState(value == null ? '' : value.toFixed(1));

  // Re-sync if value arrives from a restore / sync-on-reconnect.
  useEffect(() => {
    setText(value == null ? '' : value.toFixed(1));
  }, [value]);

  const commit = () => {
    const normalized = normalizeScore(text, min, max);
    setText(normalized == null ? '' : normalized.toFixed(1));
    onCommit(normalized);
  };

  return (
    <div className="cat-head">
      <span className="cat-name">{categoryName}</span>
      <input
        type="text"
        inputMode="decimal"
        enterKeyHint="done"
        className="score-input"
        aria-label={`${categoryName} score, ${min} to ${max} in tenths`}
        placeholder="—"
        disabled={disabled}
        value={text}
        onChange={(e) => setText(sanitizeTyping(e.target.value))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </div>
  );
}
