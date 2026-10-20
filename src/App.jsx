import { useState, useRef, useEffect } from 'react';
import { supabase } from './supabaseClient';
import { EVENT_CODE } from './config';
import ScoreInput from './ScoreInput';

// Persists across page loads (including the OAuth-redirect round trip) and
// across sessions on the same device — it's "the event this device is
// currently pointed at," not a one-shot flag. Overwritten whenever a judge
// types a different code. Old builds kept this fixed to one event; renamed
// away from the old 'test26_pending_code' key for that reason.
const CURRENT_CODE_KEY = 'judge_current_event_code';
// Pre-dynamic-event-code builds keyed local score caches only by enrollment
// id (fine when there's exactly one event per deployment). Keep the old
// key format around so loadScoring can migrate it forward without loss.
const legacyLsKey = (enrollmentId) => `test26_${enrollmentId}`;
const lsKey = (eventId, enrollmentId) => `scores_${eventId}_${enrollmentId}`;

const DEFAULT_THEME_VARS = { '--amber': '#EF9F27', '--amber-dim': '#C9983A', '--amber-bg': '#1A1300' };
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Blend a hex color t% of the way toward black (t in [0,1]) — used to derive
// a dim/hover shade and a very dark tinted background from an event's single
// accent hex, so an operator only has to pick one color per event.
function shadeToward(hex, toHex, t) {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(toHex.slice(1), 16);
  const mix = (shift) => {
    const av = (a >> shift) & 0xff;
    const bv = (b >> shift) & 0xff;
    return Math.round(av + (bv - av) * t);
  };
  const r = mix(16), g = mix(8), bch = mix(0);
  return '#' + [r, g, bch].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// Unscored categories count as 0 toward the running total — this is a live,
// provisional view while judging is in progress, not a final placement.
// Only counts scores actually confirmed saved (cell.synced) — a value that's
// only sitting in local state (still queued, retrying, or rejected by the
// DB) isn't "scored" yet from the judge's or organizer's point of view.
function entryStats(entryId, categories, scores) {
  let total = 0;
  let scoredCount = 0;
  for (const c of categories) {
    const cell = scores[`${entryId}|${c.id}`];
    if (cell && cell.value != null && cell.synced) { total += cell.value; scoredCount++; }
  }
  return { total, scoredCount, avg: categories.length ? total / categories.length : 0 };
}

// (entry, category) pairs with no confirmed score — surfaced before submit.
function unscoredPairs(entries, categories, scores) {
  const pairs = [];
  for (const en of entries) {
    for (const c of categories) {
      const cell = scores[`${en.id}|${c.id}`];
      if (!cell || cell.value == null || !cell.synced) {
        pairs.push({ entryNumber: en.entry_number, categoryName: c.name });
      }
    }
  }
  return pairs;
}

function sortedEntries(entries, categories, scores, sortOrder) {
  if (sortOrder === 'rank') {
    return [...entries].sort((a, b) => entryStats(b.id, categories, scores).total - entryStats(a.id, categories, scores).total);
  }
  return [...entries].sort((a, b) => a.entry_number - b.entry_number);
}

// Splits on the first sentence-ending punctuation so the modal can show a
// short teaser with the rest tucked behind a "more" toggle.
function splitFirstSentence(text) {
  if (!text) return [null, null];
  const match = text.match(/^(.*?[.?!])(?:\s+(.*))?$/s);
  if (!match) return [text, null];
  return [match[1], match[2] || null];
}

function CategoryDescription({ text }) {
  const [expanded, setExpanded] = useState(false);
  const [first, rest] = splitFirstSentence(text);
  if (!first) return null;
  return (
    <div className="cat-desc">
      <span>{first}</span>
      {rest && (
        <>
          {' '}
          <button type="button" className="cat-desc-toggle" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'less' : 'more'}
          </button>
          {expanded && <div className="cat-desc-rest">{rest}</div>}
        </>
      )}
    </div>
  );
}

function timeAgo(date) {
  if (!date) return '';
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return '1 min ago';
  return `${minutes} min ago`;
}

function saveStatusLabel(status, lastSavedAt) {
  switch (status) {
    case 'saving': return 'Saving…';
    case 'retrying': return 'Save failed — retrying…';
    case 'error': return 'Save failed — reopen this entry to try again';
    case 'saved': return `Saved ${timeAgo(lastSavedAt)}`;
    default: return '';
  }
}

export default function App() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState('code');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const [codeInput, setCodeInput] = useState(EVENT_CODE);
  const [email, setEmail] = useState('');
  const [nameInput, setNameInput] = useState('');

  const [eventRow, setEventRow] = useState(null);
  const [trackRow, setTrackRow] = useState(null);
  const [categories, setCategories] = useState([]);
  const [entries, setEntries] = useState([]);
  const [scores, setScores] = useState({});
  const [notes, setNotes] = useState({});
  const [openEntry, setOpenEntry] = useState(null);
  const [sortOrder, setSortOrder] = useState('rank');
  const [saveStatus, setSaveStatus] = useState('idle');
  const [lastSavedAt, setLastSavedAt] = useState(null);
  // Per-category messages from a DB-rejected score (check_violation) — keyed
  // entryId|categoryId, shown inline on that exact ScoreInput.
  const [fieldErrors, setFieldErrors] = useState({});
  // Set right before submit when some (entry, category) pairs aren't scored
  // yet; submitting again with the same unresolved list proceeds anyway.
  const [missingList, setMissingList] = useState(null);

  const ejRef = useRef(null);
  const scoresRef = useRef({});
  const notesRef = useRef({});
  const dirty = useRef(new Set());
  const timers = useRef({});
  const retries = useRef({});
  const inFlight = useRef(0);
  const hardFailed = useRef(new Set());

  useEffect(() => { scoresRef.current = scores; }, [scores]);
  useEffect(() => { notesRef.current = notes; }, [notes]);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      if (data.session) bootstrap(data.session); else setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (s) bootstrap(s);
    });
    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    const iv = setInterval(() => { dirty.current.forEach((k) => flush(k)); }, 60000);
    const onVis = () => { if (document.visibilityState === 'visible') dirty.current.forEach((k) => flush(k)); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  // Tick every 15s so "Saved X ago" stays fresh without a real state change
  useEffect(() => {
    const iv = setInterval(() => {
      setLastSavedAt((prev) => (prev ? new Date(prev.getTime()) : prev));
    }, 15000);
    return () => clearInterval(iv);
  }, []);

  // Theme provider: the resolved event's events.theme (nullable jsonb —
  // background_url, overlay_opacity, accent, logo_url) drives everything
  // visual via CSS variables on the document root. Null/missing fields fall
  // back to the dababase defaults baked into index.css's :root block — never
  // hardcode a specific event's look here.
  useEffect(() => {
    const root = document.documentElement;
    const theme = (eventRow && eventRow.theme) || null;
    const accent = theme && typeof theme.accent === 'string' && HEX_RE.test(theme.accent) ? theme.accent : null;
    if (accent) {
      root.style.setProperty('--amber', accent);
      root.style.setProperty('--amber-dim', shadeToward(accent, '#000000', 0.25));
      root.style.setProperty('--amber-bg', shadeToward(accent, '#000000', 0.90));
    } else {
      root.style.setProperty('--amber', DEFAULT_THEME_VARS['--amber']);
      root.style.setProperty('--amber-dim', DEFAULT_THEME_VARS['--amber-dim']);
      root.style.setProperty('--amber-bg', DEFAULT_THEME_VARS['--amber-bg']);
    }
  }, [eventRow]);

  // Page title: event name once resolved, generic fallback otherwise.
  useEffect(() => {
    document.title = (eventRow && (eventRow.name || eventRow.event_code))
      ? `${eventRow.name || eventRow.event_code} — Judge Scoring`
      : 'Judge Scoring';
  }, [eventRow]);

  async function bootstrap(s) {
    setError('');
    // Resolving the events table requires an authenticated role (RLS), so a
    // code typed before sign-in can't be validated yet — submitCode() just
    // stores it and this is where it actually gets looked up, for both the
    // immediate post-guest-signin path and the OAuth-redirect round trip
    // (where component state, including eventRow, was lost on reload).
    let ev = eventRow;
    if (!ev) {
      const code = localStorage.getItem(CURRENT_CODE_KEY);
      if (!code) { setStep('code'); setReady(true); return; }
      const { data: found } = await supabase.from('events').select('*').ilike('event_code', code).maybeSingle();
      if (!found) {
        localStorage.removeItem(CURRENT_CODE_KEY);
        setError('Code not recognized. Check with the organizer.');
        setStep('code'); setReady(true); return;
      }
      ev = found;
      setEventRow(ev);
    }
    const { data: judge } = await supabase.from('judges').select('*').eq('user_id', s.user.id).maybeSingle();
    if (!judge) { setStep('name'); setReady(true); return; }
    setNameInput(judge.display_name || '');
    const { data: enrollment } = await supabase.from('event_judges').select('*').eq('event_id', ev.id).eq('judge_id', judge.id).maybeSingle();
    if (!enrollment) { await enroll(ev, judge.display_name); return; }
    ejRef.current = enrollment;
    if (enrollment.submitted_at) { setStep('submitted'); setReady(true); return; }
    await loadScoring(ev, enrollment);
  }

  async function enroll(ev, displayName) {
    // Enrollment goes through the gated enroll_me RPC (SECURITY DEFINER): it
    // verifies the event code server-side, resolves/creates the judge from
    // auth.uid(), and inserts event_judges idempotently. Returns event_judge_id.
    const { data: ejId, error: e } = await supabase.rpc('enroll_me', {
      p_display_name: displayName,
      p_event_id: ev.id,
      p_event_code: ev.event_code,
    });
    if (e || !ejId) { setError('Could not join the event. Check the code and try again.'); setReady(true); return; }
    const { data: enrollment, error: se } = await supabase.from('event_judges').select('*').eq('id', ejId).single();
    if (se || !enrollment) { setError('Enrolled, but could not load your session. Refresh.'); setReady(true); return; }
    ejRef.current = enrollment;
    await loadScoring(ev, enrollment);
  }

  async function loadScoring(ev, enrollment) {
    const { data: tracks } = await supabase.from('event_tracks').select('*').eq('event_id', ev.id).order('display_order');
    const track = tracks && tracks[0];
    if (!track) { setError('No track configured.'); setReady(true); return; }
    setTrackRow(track);
    const [{ data: cats }, { data: ents }] = await Promise.all([
      supabase.from('categories').select('*').eq('track_id', track.id).order('display_order'),
      supabase.from('entries').select('*').eq('track_id', track.id).order('entry_number'),
    ]);
    setCategories(cats || []);
    setEntries(ents || []);
    const [{ data: savedScores }, { data: savedNotes }] = await Promise.all([
      supabase.from('scores').select('entry_id,category_id,raw_score,note').eq('event_judge_id', enrollment.id),
      supabase.from('entry_notes').select('entry_id,note').eq('event_judge_id', enrollment.id),
    ]);
    const sMap = {};
    (savedScores || []).forEach((r) => { sMap[`${r.entry_id}|${r.category_id}`] = { value: r.raw_score, note: r.note || '', synced: true }; });
    const nMap = {};
    (savedNotes || []).forEach((r) => { nMap[r.entry_id] = r.note || ''; });
    // Migrate any unsynced data left under the old single-event key format
    // forward to the event-namespaced key, then layer in whatever's already
    // under the new key (should rarely coexist, but new wins if so). Local
    // overlay values aren't trusted as already-in-the-DB — queued below so
    // they get a real flush and a confirmed `synced` flag.
    const oldKey = legacyLsKey(enrollment.id);
    const newKey = lsKey(ev.id, enrollment.id);
    const unsyncedKeys = new Set();
    try {
      const old = JSON.parse(localStorage.getItem(oldKey) || 'null');
      if (old && old.scores) {
        for (const [k, v] of Object.entries(old.scores)) { sMap[k] = { value: v.value, note: v.note || '', synced: false }; unsyncedKeys.add(k); }
      }
      if (old && old.notes) Object.assign(nMap, old.notes);
    } catch (_) {}
    try {
      const current = JSON.parse(localStorage.getItem(newKey) || 'null');
      if (current && current.scores) {
        for (const [k, v] of Object.entries(current.scores)) { sMap[k] = { value: v.value, note: v.note || '', synced: false }; unsyncedKeys.add(k); }
      }
      if (current && current.notes) Object.assign(nMap, current.notes);
    } catch (_) {}
    localStorage.removeItem(oldKey);
    scoresRef.current = sMap; notesRef.current = nMap;
    setScores(sMap); setNotes(nMap);
    mirrorNow(sMap, nMap);
    unsyncedKeys.forEach((k) => queue('s:' + k));
    setStep('scoring'); setReady(true);
  }

  function mirrorNow(s, n) {
    const ej = ejRef.current;
    if (!ej) return;
    try { localStorage.setItem(lsKey(ej.event_id, ej.id), JSON.stringify({ scores: s, notes: n, t: Date.now() })); } catch (_) {}
  }

  function setValue(eid, cid, value) {
    const key = `${eid}|${cid}`;
    const cur = scoresRef.current[key] || {};
    const next = { ...scoresRef.current, [key]: { value, note: cur.note || '', synced: false } };
    scoresRef.current = next; setScores(next); mirrorNow(next, notesRef.current); queue('s:' + key);
    if (fieldErrors[key]) setFieldErrors((prev) => { const { [key]: _drop, ...rest } = prev; return rest; });
  }
  function setScoreNote(eid, cid, note) {
    const key = `${eid}|${cid}`;
    const cur = scoresRef.current[key] || {};
    // A note-only edit doesn't invalidate an already-confirmed score — only
    // changing the value itself does (avoids the progress count flickering
    // "scored" -> "unscored" -> "scored" while someone's just typing a note).
    const next = { ...scoresRef.current, [key]: { value: cur.value != null ? cur.value : null, note, synced: cur.synced || false } };
    scoresRef.current = next; setScores(next); mirrorNow(next, notesRef.current); queue('s:' + key);
  }
  function setEntryNote(eid, note) {
    const next = { ...notesRef.current, [eid]: note };
    notesRef.current = next; setNotes(next); mirrorNow(scoresRef.current, next); queue('n:' + eid);
  }

  function queue(key) {
    dirty.current.add(key);
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => flush(key), 600);
  }

  function markSynced(key) {
    const cur = scoresRef.current[key];
    if (!cur || cur.synced) return;
    const next = { ...scoresRef.current, [key]: { ...cur, synced: true } };
    scoresRef.current = next; setScores(next); mirrorNow(next, notesRef.current);
  }

  async function flush(key) {
    if (!ejRef.current) return;
    const ejId = ejRef.current.id;
    dirty.current.delete(key);
    inFlight.current += 1;
    setSaveStatus('saving');
    let ok = true;
    try {
      if (key.startsWith('s:')) {
        const [eid, cid] = key.slice(2).split('|');
        const k = `${eid}|${cid}`;
        const cell = scoresRef.current[k] || {};
        if (cell.value == null && !cell.note) {
          // Nothing to keep — no score, no note. Delete rather than write a
          // placeholder row.
          const { error: e } = await supabase.from('scores').delete()
            .eq('event_judge_id', ejId).eq('entry_id', eid).eq('category_id', cid);
          if (e) throw e;
        } else {
          // raw_score may be null here (a note with no score yet) — the
          // column allows that; only a non-null score still has to pass the
          // category's min/max range.
          const payload = { event_judge_id: ejId, entry_id: eid, category_id: cid, raw_score: cell.value != null ? cell.value : null, note: cell.note || null, is_self_score: false };
          const { error: e } = await supabase.from('scores').upsert(payload, { onConflict: 'event_judge_id,entry_id,category_id' });
          if (e) throw e;
        }
        markSynced(k);
      } else if (key.startsWith('n:')) {
        const eid = key.slice(2);
        const payload = { event_judge_id: ejId, entry_id: eid, note: notesRef.current[eid] || null };
        const { error: e } = await supabase.from('entry_notes').upsert(payload, { onConflict: 'event_judge_id,entry_id' });
        if (e) throw e;
      }
      retries.current[key] = 0;
      hardFailed.current.delete(key);
    } catch (e) {
      if (key.startsWith('s:') && e && e.code === '23514') {
        // DB rejected the score as outside the category's range
        // (check_violation) — shouldn't normally happen, since ScoreInput
        // already validates against the same min/max, but a category's
        // range could change mid-session. Don't retry a value the DB will
        // never accept: drop it back to "not scored" locally so the entry
        // list's progress count flags it, surface exactly which field needs
        // fixing, and let every other queued write keep syncing on its own.
        const [eid, cid] = key.slice(2).split('|');
        const k = `${eid}|${cid}`;
        const cur = scoresRef.current[k] || {};
        const next = { ...scoresRef.current, [k]: { value: null, note: cur.note || '', synced: true } };
        scoresRef.current = next; setScores(next); mirrorNow(next, notesRef.current);
        setFieldErrors((prev) => ({ ...prev, [k]: 'That score was rejected by the server — enter a valid value.' }));
        retries.current[key] = 0;
        hardFailed.current.delete(key);
      } else {
        ok = false;
        const n = (retries.current[key] || 0) + 1;
        retries.current[key] = n;
        if (n <= 5) {
          dirty.current.add(key);
          setTimeout(() => flush(key), Math.min(1000 * Math.pow(2, n), 15000));
        } else {
          // Retries exhausted — stop hammering Supabase, but keep this flagged
          // so the status indicator doesn't quietly report "saved" for a write
          // that never actually landed.
          hardFailed.current.add(key);
        }
      }
    } finally {
      inFlight.current -= 1;
    }
    if (hardFailed.current.size > 0) {
      setSaveStatus('error');
    } else if (!ok) {
      setSaveStatus('retrying');
    } else if (inFlight.current === 0 && dirty.current.size === 0) {
      setSaveStatus('saved');
      setLastSavedAt(new Date());
    }
  }

  async function signInGoogle() {
    setError('');
    const { error: e } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
    if (e) setError('Google sign-in failed. Try email or guest.');
  }
  async function sendMagic() {
    setError(''); setInfo('');
    const addr = email.trim();
    if (!addr) { setError('Enter your email first.'); return; }
    setBusy(true);
    const { error: e } = await supabase.auth.signInWithOtp({ email: addr, options: { emailRedirectTo: window.location.origin } });
    setBusy(false);
    if (e) setError('Could not send the link. Check the address.'); else setInfo('Check your email for a sign-in link.');
  }
  async function signInGuest() {
    setError('');
    const { error: e } = await supabase.auth.signInAnonymously();
    if (e) setError('Guest sign-in is not enabled. Use email or Google.');
  }

  function submitCode() {
    setError('');
    const code = codeInput.trim().toUpperCase();
    if (!code) return;
    // Can't validate against the events table yet — RLS requires an
    // authenticated role, and this judge may not have signed in at all yet.
    // bootstrap() does the real lookup once there's a session, and bounces
    // back here with an error if the code turns out not to match anything.
    localStorage.setItem(CURRENT_CODE_KEY, code);
    if (session) bootstrap(session); else setStep('signin');
  }

  async function submitName() {
    setError('');
    const nm = nameInput.trim();
    if (!nm) { setError('Enter a name so your scores are labeled.'); return; }
    if (!session) { setStep('signin'); return; }
    if (!eventRow) { setError('Event not found. Refresh and try again.'); return; }
    setBusy(true);
    // enroll_me creates/updates the judge from auth.uid() + display name, so no
    // direct judges write is needed here anymore.
    await enroll(eventRow, nm);
    setBusy(false);
  }

  async function submitAll() {
    if (!ejRef.current) return;
    setBusy(true);
    const pending = Array.from(dirty.current);
    await Promise.all(pending.map((k) => flush(k)));
    const missing = unscoredPairs(entries, categories, scoresRef.current);
    if (missing.length > 0) {
      const sameAsShown = missingList && missingList.length === missing.length
        && missingList.every((m, i) => m.entryNumber === missing[i].entryNumber && m.categoryName === missing[i].categoryName);
      if (!sameAsShown) {
        // First time seeing this exact list (or it shrank/changed since
        // last shown) — surface it and let the judge decide, rather than
        // submitting an incomplete set silently. Submitting again with the
        // same list unresolved goes through.
        setMissingList(missing);
        setBusy(false);
        return;
      }
    }
    setMissingList(null);
    const { error: e } = await supabase.from('event_judges').update({ submitted_at: new Date().toISOString() }).eq('id', ejRef.current.id);
    setBusy(false);
    if (e) { setError('Submit failed — your scores are saved. Try submitting again.'); return; }
    setStep('submitted');
  }

  if (!ready) return (<div className="wrap"><div className="center muted-note">Loading…</div></div>);

  // Before eventRow loads (signin screen reached straight off submitCode, no
  // DB round trip yet — see bootstrap()), fall back to what the judge typed.
  const eventLabel = (eventRow && (eventRow.name || eventRow.event_code)) || codeInput || 'Judge Scoring';
  const theme = (eventRow && eventRow.theme) || null;
  const overlayOpacity = theme && typeof theme.overlay_opacity === 'number'
    ? Math.min(1, Math.max(0, theme.overlay_opacity))
    : 0.7;

  return (
    <>
      {theme && theme.background_url && (
        <div className="bg-artwork" style={{ backgroundImage: `url(${theme.background_url})` }}>
          <div className="bg-artwork-scrim" style={{ background: `rgba(10,10,10,${overlayOpacity})` }} />
        </div>
      )}
      <div className="wrap">
      {theme && theme.logo_url && (
        <div className="logo-header"><img src={theme.logo_url} alt="" className="logo-header-img" /></div>
      )}

      {step === 'code' && (<>
        <div className="eyebrow">Blind Judging</div>
        <h1>Enter event code</h1>
        <p className="sub">Your organizer gave you a code to unlock scoring.</p>
        <label>Event code</label>
        <input type="text" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submitCode()} placeholder="Event code" autoCapitalize="characters" />
        <button className="btn primary" onClick={submitCode}>Continue</button>
        {error && <div className="err">{error}</div>}
      </>)}

      {step === 'signin' && (<>
        <div className="eyebrow">{eventLabel}</div>
        <h1>Sign in to score</h1>
        <p className="sub">This keeps your scores tied to you across devices.</p>
        <button className="btn primary" onClick={signInGoogle}>Continue with Google</button>
        <div className="divider">or</div>
        <label>Email sign-in link</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" />
        <button className="btn outline" onClick={sendMagic} disabled={busy}>{busy ? 'Sending…' : 'Email me a link'}</button>
        <div className="divider">or</div>
        <button className="btn ghost" onClick={signInGuest}>Continue as guest</button>
        {info && <div className="ok">{info}</div>}
        {error && <div className="err">{error}</div>}
      </>)}

      {step === 'name' && (<>
        <div className="eyebrow">{eventLabel}</div>
        <h1>What should we call you?</h1>
        <p className="sub">This labels your scores. It isn't shown to other judges.</p>
        <label>Judge name</label>
        <input type="text" value={nameInput} onChange={(e) => setNameInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submitName()} placeholder="Your name" />
        <button className="btn primary" onClick={submitName} disabled={busy}>{busy ? 'Starting…' : 'Start scoring'}</button>
        {error && <div className="err">{error}</div>}
      </>)}

      {step === 'scoring' && (<>
        <div className="eyebrow">{eventLabel}{trackRow && trackRow.name ? ` · ${trackRow.name}` : ''}</div>
        <h1>Score the entries</h1>
        <p className="sub">Blind — entry numbers only. Tap an entry to score it.</p>
        {saveStatus !== 'idle' && (
          <div className={'save-status' + ((saveStatus === 'error' || saveStatus === 'retrying') ? ' save-status-error' : '')}>
            {saveStatusLabel(saveStatus, lastSavedAt)}
          </div>
        )}

        <div className="sort-toggle">
          <button className={'sort-opt' + (sortOrder === 'rank' ? ' active' : '')} onClick={() => setSortOrder('rank')}>Ranking</button>
          <button className={'sort-opt' + (sortOrder === 'sequential' ? ' active' : '')} onClick={() => setSortOrder('sequential')}>Entry #</button>
        </div>

        <ul className="entry-list">
          {sortedEntries(entries, categories, scores, sortOrder).map((en, idx) => {
            const { avg, scoredCount } = entryStats(en.id, categories, scores);
            const avgMax = categories.length ? categories.reduce((s, c) => s + (c.max_points || 0), 0) / categories.length : 0;
            return (
              <li className="entry-row" key={en.id} onClick={() => setOpenEntry(en.id)}>
                {sortOrder === 'rank' && <span className="entry-row-pos">{idx + 1}</span>}
                <span className="entry-row-num">Entry #{en.entry_number}</span>
                <span className="entry-row-progress">{scoredCount}/{categories.length}</span>
                <span className="entry-row-avg">{scoredCount ? avg.toFixed(1) + '/' + avgMax : '—'}</span>
              </li>
            );
          })}
        </ul>

        {missingList && missingList.length > 0 && (
          <div className="err" style={{ marginBottom: '8px' }}>
            Still unscored: {missingList.map((m) => `Entry #${m.entryNumber} — ${m.categoryName}`).join(', ')}. Tap Submit again to submit anyway.
          </div>
        )}
        <button className="btn primary" onClick={submitAll} disabled={busy}>{busy ? 'Submitting…' : 'Submit my scores'}</button>
        {error && <div className="err">{error}</div>}
        <p className="muted-note" style={{ marginTop: '12px' }}>You can return and change scores until you submit.</p>

        {openEntry != null && (
          <EntryModal
            entry={entries.find((e) => e.id === openEntry)}
            categories={categories}
            scores={scores}
            note={notes[openEntry] || ''}
            disabled={busy}
            saveStatus={saveStatus}
            lastSavedAt={lastSavedAt}
            fieldErrors={fieldErrors}
            onCommitScore={(cid, v) => setValue(openEntry, cid, v)}
            onCommitCategoryNote={(cid, n) => setScoreNote(openEntry, cid, n)}
            onCommitEntryNote={(n) => setEntryNote(openEntry, n)}
            onClose={() => {
              Array.from(dirty.current).forEach((k) => flush(k));
              setOpenEntry(null);
            }}
          />
        )}
      </>)}

      {step === 'submitted' && (
        <div className="center">
          <div className="big-check">✓</div>
          <h1>Scores submitted</h1>
          <p className="muted-note">Thanks, {nameInput || 'judge'}. Your scores are locked in for {eventLabel}.</p>
        </div>
      )}
      </div>
    </>
  );
}

function EntryModal({ entry, categories, scores, note, disabled, saveStatus, lastSavedAt, fieldErrors, onCommitScore, onCommitCategoryNote, onCommitEntryNote, onClose }) {
  if (!entry) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Entry #{entry.entry_number}</h2>
          <div className="modal-header-right">
            {saveStatus !== 'idle' && (
              <span className={'save-status' + ((saveStatus === 'error' || saveStatus === 'retrying') ? ' save-status-error' : '')}>
                {saveStatusLabel(saveStatus, lastSavedAt)}
              </span>
            )}
            <button className="close-btn" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>
        <div className="modal-body">
          {categories.map((c) => {
            const key = `${entry.id}|${c.id}`;
            const cell = scores[key];
            const min = c.min_points ?? 0;
            const max = c.max_points ?? 10;
            return (
              <div className="cat" key={c.id}>
                <ScoreInput
                  categoryName={c.name}
                  value={cell && cell.value != null ? cell.value : null}
                  min={min}
                  max={max}
                  onCommit={(v) => onCommitScore(c.id, v)}
                  disabled={disabled}
                  serverError={fieldErrors && fieldErrors[key]}
                />
                <CategoryDescription text={c.description} />
                <div className="note-label">Notes (optional)</div>
                <textarea value={(cell && cell.note) || ''} onChange={(e) => onCommitCategoryNote(c.id, e.target.value)} />
              </div>
            );
          })}
          <div className="note-label" style={{ marginTop: '16px' }}>Overall note for this entry</div>
          <textarea value={note} onChange={(e) => onCommitEntryNote(e.target.value)} />
        </div>
      </div>
    </div>
  );
}
