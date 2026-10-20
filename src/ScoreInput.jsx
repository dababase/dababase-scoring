// Numeric per-category score entry. Validates on commit (blur/Enter), never
// on keystroke — typing "55" digit by digit must never flag at "5". Mirrors
// the DB's scores_nonneg_tenths_chk + validate_score_range trigger: value
// must be min_points..max_points for the category, at most one decimal place.
import { useState, useEffect, useRef } from 'react';

// Returns { value, error }. value is a tenths-rounded number, or null for an
// empty field (a valid "not scored" state — never an error). error is a
// user-facing message, or null when the text is valid.
export function parseScore(raw, min, max) {
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null, error: null };
  const message = `Enter a score from ${min} to ${max}, up to one decimal`;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return { value: null, error: message };
  const decimals = trimmed.includes('.') ? trimmed.split('.')[1].length : 0;
  if (decimals > 1) return { value: null, error: message };
  const n = Number(trimmed);
  if (n < min || n > max) return { value: null, error: message };
  return { value: Math.round(n * 10) / 10, error: null };
}

export default function ScoreInput({ categoryName, value, min, max, onCommit, disabled, serverError }) {
  const [text, setText] = useState(value == null ? '' : value.toFixed(1));
  const [localError, setLocalError] = useState(null);
  const inputRef = useRef(null);

  // Re-sync if value arrives from a restore / sync-on-reconnect.
  useEffect(() => {
    setText(value == null ? '' : value.toFixed(1));
  }, [value]);

  const commit = () => {
    const { value: parsed, error } = parseScore(text, min, max);
    if (error) {
      setLocalError(error);
      // Blur already happened by the time this runs — snap focus back so
      // the judge stays on the field until it's fixed, as required.
      if (inputRef.current) inputRef.current.focus();
      return;
    }
    setLocalError(null);
    setText(parsed == null ? '' : parsed.toFixed(1));
    onCommit(parsed);
  };

  const errorText = localError || serverError || null;

  return (
    <div>
      <div className="cat-head">
        <span className="cat-name">{categoryName}</span>
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          enterKeyHint="done"
          className={'score-input' + (errorText ? ' score-input-error' : '')}
          aria-label={`${categoryName} score, ${min} to ${max} in tenths`}
          aria-invalid={errorText ? 'true' : 'false'}
          placeholder="—"
          disabled={disabled}
          value={text}
          onChange={(e) => { setText(e.target.value); if (localError) setLocalError(null); }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      </div>
      {errorText && <div className="score-error">{errorText}</div>}
    </div>
  );
}
