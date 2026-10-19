import { useState, useRef, useEffect } from 'react';
import { supabase } from './supabaseClient';
import { EVENT_CODE } from './config';

const PENDING = 'test26_pending_code';
const lsKey = (id) => `test26_${id}`;

export default function App() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState('code');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const [codeInput, setCodeInput] = useState('');
  const [email, setEmail] = useState('');
  const [nameInput, setNameInput] = useState('');

  const [eventRow, setEventRow] = useState(null);
  const [categories, setCategories] = useState([]);
  const [entries, setEntries] = useState([]);
  const [scores, setScores] = useState({});
  const [notes, setNotes] = useState({});

  const ejRef = useRef(null);
  const scoresRef = useRef({});
  const notesRef = useRef({});
  const dirty = useRef(new Set());
  const timers = useRef({});
  const retries = useRef({});

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

  async function bootstrap(s) {
    setError('');
    const { data: ev } = await supabase.from('events').select('*').ilike('event_code', EVENT_CODE).maybeSingle();
    if (!ev) { setError('Event not found. Refresh and try again.'); setReady(true); return; }
    setEventRow(ev);
    const { data: judge } = await supabase.from('judges').select('*').eq('user_id', s.user.id).maybeSingle();
    if (!judge) {
      setStep(localStorage.getItem(PENDING) === EVENT_CODE ? 'name' : 'code');
      setReady(true); return;
    }
    setNameInput(judge.display_name || '');
    const { data: enrollment } = await supabase.from('event_judges').select('*').eq('event_id', ev.id).eq('judge_id', judge.id).maybeSingle();
    if (!enrollment) {
      if (localStorage.getItem(PENDING) === EVENT_CODE) { await enroll(ev, judge.display_name); }
      else { setStep('code'); setReady(true); }
      return;
    }
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
      p_event_code: EVENT_CODE,
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
    (savedScores || []).forEach((r) => { sMap[`${r.entry_id}|${r.category_id}`] = { value: r.raw_score, note: r.note || '' }; });
    const nMap = {};
    (savedNotes || []).forEach((r) => { nMap[r.entry_id] = r.note || ''; });
    try {
      const local = JSON.parse(localStorage.getItem(lsKey(enrollment.id)) || 'null');
      if (local && local.scores) Object.assign(sMap, local.scores);
      if (local && local.notes) Object.assign(nMap, local.notes);
    } catch (_) {}
    scoresRef.current = sMap; notesRef.current = nMap;
    setScores(sMap); setNotes(nMap);
    localStorage.removeItem(PENDING);
    setStep('scoring'); setReady(true);
  }

  function mirrorNow(s, n) {
    const id = ejRef.current && ejRef.current.id;
    if (!id) return;
    try { localStorage.setItem(lsKey(id), JSON.stringify({ scores: s, notes: n, t: Date.now() })); } catch (_) {}
  }

  function setValue(eid, cid, value) {
    const key = `${eid}|${cid}`;
    const cur = scoresRef.current[key] || {};
    const next = { ...scoresRef.current, [key]: { value, note: cur.note || '' } };
    scoresRef.current = next; setScores(next); mirrorNow(next, notesRef.current); queue('s:' + key);
  }
  function setScoreNote(eid, cid, note) {
    const key = `${eid}|${cid}`;
    const cur = scoresRef.current[key] || {};
    const next = { ...scoresRef.current, [key]: { value: cur.value != null ? cur.value : null, note } };
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

  async function flush(key) {
    if (!ejRef.current) return;
    const ejId = ejRef.current.id;
    dirty.current.delete(key);
    try {
      if (key.startsWith('s:')) {
        const [eid, cid] = key.slice(2).split('|');
        const cell = scoresRef.current[`${eid}|${cid}`] || {};
        const payload = { event_judge_id: ejId, entry_id: eid, category_id: cid, raw_score: cell.value != null ? cell.value : null, note: cell.note || null, is_self_score: false };
        const { error: e } = await supabase.from('scores').upsert(payload, { onConflict: 'event_judge_id,entry_id,category_id' });
        if (e) throw e;
      } else if (key.startsWith('n:')) {
        const eid = key.slice(2);
        const payload = { event_judge_id: ejId, entry_id: eid, note: notesRef.current[eid] || null };
        const { error: e } = await supabase.from('entry_notes').upsert(payload, { onConflict: 'event_judge_id,entry_id' });
        if (e) throw e;
      }
      retries.current[key] = 0;
    } catch (e) {
      const n = (retries.current[key] || 0) + 1;
      retries.current[key] = n;
      if (n <= 5) { dirty.current.add(key); setTimeout(() => flush(key), Math.min(1000 * Math.pow(2, n), 15000)); }
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
    if (code !== EVENT_CODE) { setError('Code not recognized. Check with the organizer.'); return; }
    localStorage.setItem(PENDING, EVENT_CODE);
    if (session) bootstrap(session); else setStep('signin');
  }

  async function submitName() {
    setError('');
    const nm = nameInput.trim();
    if (!nm) { setError('Enter a name so your scores are labeled.'); return; }
    if (!session) { setStep('signin'); return; }
    setBusy(true);
    const ev = eventRow || (await supabase.from('events').select('*').ilike('event_code', EVENT_CODE).maybeSingle()).data;
    if (!ev) { setBusy(false); setError('Event not found. Refresh.'); return; }
    // enroll_me creates/updates the judge from auth.uid() + display name, so no
    // direct judges write is needed here anymore.
    await enroll(ev, nm);
    setBusy(false);
  }

  async function submitAll() {
    if (!ejRef.current) return;
    setBusy(true);
    const pending = Array.from(dirty.current);
    await Promise.all(pending.map((k) => flush(k)));
    const { error: e } = await supabase.from('event_judges').update({ submitted_at: new Date().toISOString() }).eq('id', ejRef.current.id);
    setBusy(false);
    if (e) { setError('Submit failed — your scores are saved. Try submitting again.'); return; }
    setStep('submitted');
  }

  if (!ready) return (<div className="wrap"><div className="center muted-note">Loading…</div></div>);

  return (
    <div className="wrap">
      <div className="hero"><img src="https://2026-mothership-meltdown-melt.vercel.app/mothership.jpeg" alt="" /><div className="mask" /></div>

      {step === 'code' && (<>
        <div className="eyebrow">Blind Judging</div>
        <h1>Enter event code</h1>
        <p className="sub">Your organizer gave you a code to unlock scoring.</p>
        <label>Event code</label>
        <input type="text" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submitCode()} placeholder="TEST26" autoCapitalize="characters" />
        <button className="btn primary" onClick={submitCode}>Continue</button>
        {error && <div className="err">{error}</div>}
      </>)}

      {step === 'signin' && (<>
        <div className="eyebrow">TEST26</div>
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
        <div className="eyebrow">TEST26</div>
        <h1>What should we call you?</h1>
        <p className="sub">This labels your scores. It isn't shown to other judges.</p>
        <label>Judge name</label>
        <input type="text" value={nameInput} onChange={(e) => setNameInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submitName()} placeholder="Your name" />
        <button className="btn primary" onClick={submitName} disabled={busy}>{busy ? 'Starting…' : 'Start scoring'}</button>
        {error && <div className="err">{error}</div>}
      </>)}

      {step === 'scoring' && (<>
        <div className="eyebrow">TEST26 · Test Track</div>
        <h1>Score the entries</h1>
        <p className="sub">Blind — entry numbers only. Scores save as you go.</p>
        {entries.map((en) => (
          <div className="card" key={en.id}>
            <div className="entry-num">ENTRY #{en.entry_number}</div>
            {categories.map((c) => {
              const key = `${en.id}|${c.id}`;
              const cell = scores[key];
              const touched = cell && cell.value != null;
              const val = touched ? cell.value : 5;
              return (
                <div className="cat" key={c.id}>
                  <div className="cat-head">
                    <span className="cat-name">{c.name}</span>
                    <span className={'cat-val' + (touched ? '' : ' untouched')}>{touched ? val : '—'}<span style={{ color: 'var(--faint)', fontSize: '12px' }}>/{c.max_points}</span></span>
                  </div>
                  <input type="range" min="0" max={c.max_points} step="1" value={val} onChange={(e) => setValue(en.id, c.id, Number(e.target.value))} />
                  <div className="note-label">Note (optional)</div>
                  <textarea value={(cell && cell.note) || ''} onChange={(e) => setScoreNote(en.id, c.id, e.target.value)} />
                </div>
              );
            })}
            <div className="note-label" style={{ marginTop: '16px' }}>Overall note for this entry</div>
            <textarea value={notes[en.id] || ''} onChange={(e) => setEntryNote(en.id, e.target.value)} />
          </div>
        ))}
        <button className="btn primary" onClick={submitAll} disabled={busy}>{busy ? 'Submitting…' : 'Submit my scores'}</button>
        {error && <div className="err">{error}</div>}
        <p className="muted-note" style={{ marginTop: '12px' }}>You can return and change scores until you submit.</p>
      </>)}

      {step === 'submitted' && (
        <div className="center">
          <div className="big-check">✓</div>
          <h1>Scores submitted</h1>
          <p className="muted-note">Thanks, {nameInput || 'judge'}. Your scores are locked in for TEST26.</p>
        </div>
      )}
    </div>
  );
}
