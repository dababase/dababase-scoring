import { useState, useEffect, useCallback, Fragment } from 'react';
import { supabase } from './supabaseClient';

// Operator dashboard at /admin. Every read goes through SECURITY DEFINER RPCs
// that check the signed-in, verified email against the `admins` table — the
// judge-facing RLS (own rows only) is untouched.

export const ADMIN_RETURN_KEY = 'admin_return_after_signin';
const LAST_EVENT_KEY = 'admin_last_event_code';
const REFRESH_MS = 15000;

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function ago(ts, now) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((now - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function median(xs) {
  const v = xs.filter((x) => x != null).map(Number).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export default function Admin() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(null);
  const [email, setEmail] = useState('');
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Admin — Judge Scoring';
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session); setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { setSession(s); setReady(true); });
    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!session) { setIsAdmin(null); return; }
    try { localStorage.removeItem(ADMIN_RETURN_KEY); } catch (_) {}
    supabase.rpc('is_admin').then(({ data, error: e }) => setIsAdmin(!e && data === true));
  }, [session && session.user && session.user.id]);

  const redirectTo = window.location.origin + '/admin';
  function markReturn() { try { localStorage.setItem(ADMIN_RETURN_KEY, String(Date.now())); } catch (_) {} }

  async function signInGoogle() {
    setError(''); markReturn();
    const { error: e } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
    if (e) setError('Google sign-in failed. Try the email link.');
  }
  async function sendMagic() {
    setError(''); setInfo('');
    const addr = email.trim();
    if (!addr) { setError('Enter your email first.'); return; }
    setBusy(true); markReturn();
    const { error: e } = await supabase.auth.signInWithOtp({ email: addr, options: { emailRedirectTo: redirectTo } });
    setBusy(false);
    if (e) setError('Could not send the link. Check the address.');
    else setInfo('Check your email for a sign-in link. Open it in this same browser.');
  }
  async function signOut() { await supabase.auth.signOut(); setIsAdmin(null); }

  if (!ready) return <div className="wrap admin-wrap"><div className="center muted-note">Loading…</div></div>;

  if (!session) {
    return (
      <div className="wrap">
        <div className="eyebrow">Operator</div>
        <h1>Admin sign-in</h1>
        <p className="sub">Live judge progress and results. Admin emails only.</p>
        <button className="btn primary" onClick={signInGoogle}>Continue with Google</button>
        <div className="divider">or</div>
        <label>Email sign-in link</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendMagic()} placeholder="you@email.com" />
        <button className="btn outline" onClick={sendMagic} disabled={busy}>{busy ? 'Sending…' : 'Email me a link'}</button>
        {info && <div className="ok">{info}</div>}
        {error && <div className="err">{error}</div>}
      </div>
    );
  }

  if (isAdmin === null) return <div className="wrap admin-wrap"><div className="center muted-note">Checking access…</div></div>;

  if (!isAdmin) {
    return (
      <div className="wrap">
        <div className="eyebrow">Operator</div>
        <h1>No admin access</h1>
        <p className="sub">{session.user.email || 'This guest session'} isn't on the admin list. Sign out and use an admin email, or ask Nick to add you.</p>
        <button className="btn outline" onClick={signOut}>Sign out</button>
      </div>
    );
  }

  return <Dashboard userEmail={session.user.email} onSignOut={signOut} />;
}

function Dashboard({ userEmail, onSignOut }) {
  const [events, setEvents] = useState([]);
  const [code, setCode] = useState(() => {
    const q = new URLSearchParams(window.location.search).get('event');
    if (q) return q;
    try { return localStorage.getItem(LAST_EVENT_KEY) || ''; } catch (_) { return ''; }
  });
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get('tab') || 'progress');
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.rpc('admin_events').then(({ data, error: e }) => {
      if (e) { setError('Could not load events: ' + e.message); return; }
      setEvents(data || []);
      // Only events in admin_event_scope come back; a stale code from the URL or
      // localStorage that isn't one of them falls back to the first allowed one.
      if (data && data.length && !data.some((ev) => ev.event_code.toLowerCase() === (code || '').toLowerCase())) {
        setCode(data[0].event_code);
      }
    });
  }, []);

  useEffect(() => {
    if (!code) return;
    try { localStorage.setItem(LAST_EVENT_KEY, code); } catch (_) {}
    const p = new URLSearchParams(window.location.search);
    p.set('event', code); p.set('tab', tab);
    window.history.replaceState(null, '', '/admin?' + p.toString());
  }, [code, tab]);

  const ev = events.find((e) => e.event_code.toLowerCase() === (code || '').toLowerCase());

  return (
    <div className="wrap admin-wrap">
      <div className="admin-top">
        <div className="eyebrow">Operator · {userEmail}</div>
        <button className="btn ghost admin-signout" onClick={onSignOut}>Sign out</button>
      </div>
      <h1>{ev ? `${ev.name} · ${ev.track_name || ''}` : 'Admin'}</h1>
      <div className="admin-picker">
        <label htmlFor="admin-event">Track</label>
        <select id="admin-event" value={ev ? ev.event_code : ''} onChange={(e) => setCode(e.target.value)}>
          {!ev && <option value="">Loading…</option>}
          {events.map((e) => (
            <option key={e.event_id} value={e.event_code}>{e.track_name || e.event_code} ({e.submitted_count}/{e.judge_count} submitted)</option>
          ))}
        </select>
        {ev && <span className="admin-status">Status: {ev.status}</span>}
      </div>
      {error && <div className="err">{error}</div>}

      <div className="sort-toggle admin-tabs">
        {[['progress', 'Progress'], ['results', 'Results'], ['reveal', 'Reveal']].map(([k, label]) => (
          <button key={k} className={'sort-opt' + (tab === k ? ' active' : '')} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {ev && tab === 'progress' && <Progress code={ev.event_code} key={'p' + ev.event_code} />}
      {ev && tab === 'results' && <Results code={ev.event_code} key={'r' + ev.event_code} />}
      {ev && tab === 'reveal' && <Reveal code={ev.event_code} key={'v' + ev.event_code} />}
    </div>
  );
}

function useLive(fn, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loadedAt, setLoadedAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async () => {
    const { data: d, error: e } = await fn();
    if (e) setError(e.message); else { setError(''); setData(d || []); setLoadedAt(Date.now()); }
  }, deps);
  useEffect(() => {
    load();
    const iv = setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 5000);
    const onVis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(iv); clearInterval(tick); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);
  return { data, error, loadedAt, now, reload: load };
}

function Progress({ code }) {
  const { data, error, loadedAt, now, reload } = useLive(() => supabase.rpc('admin_judge_progress', { p_event_code: code }), [code]);
  const [hideTest, setHideTest] = useState(false);

  async function toggleTest(row) {
    const { error: e } = await supabase.rpc('admin_set_judge_excluded', { p_event_judge_id: row.event_judge_id, p_excluded: !row.excluded, p_reason: 'test' });
    if (e) alert('Could not update: ' + e.message); else reload();
  }

  if (!data) return <div className="muted-note">{error || 'Loading…'}</div>;

  const status = (r) => (r.submitted_at ? 'submitted' : r.cells_scored > 0 ? 'progress' : 'idle');
  const order = { progress: 0, idle: 1, submitted: 2 };
  const rows = data
    .filter((r) => !(hideTest && r.excluded))
    .sort((a, b) => order[status(a)] - order[status(b)] || (b.entries_complete - a.entries_complete) || String(a.display_name).localeCompare(String(b.display_name)));
  const real = data.filter((r) => !r.excluded);
  const counts = { submitted: 0, progress: 0, idle: 0 };
  real.forEach((r) => { counts[status(r)]++; });

  return (
    <>
      <div className="admin-stats">
        <div><b>{real.length}</b><span>enrolled</span></div>
        <div><b>{counts.submitted}</b><span>submitted</span></div>
        <div><b>{counts.progress}</b><span>in progress</span></div>
        <div><b>{counts.idle}</b><span>not started</span></div>
      </div>
      <div className="admin-meta">
        <span>Auto-refreshes every 15s · updated {ago(loadedAt, now)}</span>
        <label className="admin-check"><input type="checkbox" checked={hideTest} onChange={(e) => setHideTest(e.target.checked)} /> Hide test judges</label>
        <button className="admin-link" onClick={reload}>Refresh now</button>
      </div>
      {error && <div className="err">Refresh failed: {error}</div>}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr><th>Judge</th><th>Entries scored</th><th>Submitted</th><th>Last saved</th><th>Test</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = r.entries_total ? Math.round((100 * r.entries_complete) / r.entries_total) : 0;
              return (
                <tr key={r.event_judge_id} className={r.excluded ? 'admin-row-test' : ''}>
                  <td>
                    <div className="admin-name">{r.display_name || '(no name)'}</div>
                    {r.email && <div className="admin-sub">{r.email}</div>}
                  </td>
                  <td>
                    <div className="admin-progress"><div style={{ width: pct + '%' }} /></div>
                    <div className="admin-sub">{r.entries_complete}/{r.entries_total} entries · {r.cells_scored}/{r.cells_total} scores</div>
                  </td>
                  <td>{r.submitted_at ? <span className="admin-yes">Yes · {fmtTime(r.submitted_at)}</span> : <span className="admin-no">No</span>}</td>
                  <td>{r.last_saved_at ? <>{ago(r.last_saved_at, now)}<div className="admin-sub">{fmtTime(r.last_saved_at)}</div></> : '—'}</td>
                  <td><input type="checkbox" checked={r.excluded} onChange={() => toggleTest(r)} aria-label={`Mark ${r.display_name} as test`} /></td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={5} className="muted-note">No judges enrolled yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted-note">"Test" judges are left out of the results leaderboard. Their scores are never changed or deleted.</p>
    </>
  );
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function downloadCsv(filename, rows) {
  const text = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Rows arrive ordered by rank points (lowest wins), then average score.
// Shared ranks (1, 2, 2, 4) only when BOTH are equal — the average is the
// tie-breaker. Compared at fixed decimals so float noise can't split a tie.
function rankRows(rows) {
  let prev = null; let prevRank = 0; let n = 0;
  const out = rows.map((r) => {
    if (r.rank_points == null) return { ...r, rank: null };
    n++;
    const s = Number(r.rank_points).toFixed(2) + '|' + Number(r.score).toFixed(3);
    const rank = s === prev ? prevRank : n;
    prev = s; prevRank = rank;
    return { ...r, rank };
  });
  const counts = {};
  out.forEach((r) => { if (r.rank != null) counts[r.rank] = (counts[r.rank] || 0) + 1; });
  return out.map((r) => ({ ...r, tied: r.rank != null && counts[r.rank] > 1 }));
}

function Results({ code }) {
  const { data, error, loadedAt, now, reload } = useLive(async () => {
    const [res, raw] = await Promise.all([
      supabase.rpc('admin_results', { p_event_code: code }),
      supabase.rpc('admin_score_rows', { p_event_code: code }),
    ]);
    if (res.error || raw.error) return { data: null, error: res.error || raw.error };
    return { data: { results: res.data || [], raw: raw.data || [] }, error: null };
  }, [code]);
  const [reveal, setReveal] = useState(null);
  const [showReveal, setShowReveal] = useState(false);
  const [open, setOpen] = useState(null);
  const [compare, setCompare] = useState(false);

  useEffect(() => {
    if (!showReveal || reveal) return;
    supabase.rpc('admin_reveal', { p_event_code: code }).then(({ data: d }) => {
      const m = {}; (d || []).forEach((r) => { m[r.entry_id] = r; }); setReveal(m);
    });
  }, [showReveal, code]);

  if (!data || !data.results) return <div className="muted-note">{error || 'Loading…'}</div>;

  const { results, raw } = data;
  const tracks = [...new Set(results.map((r) => r.track_name))];
  const medSd = median(results.map((r) => r.stddev));
  const maxJudges = Math.max(0, ...results.map((r) => Number(r.judge_count)));

  // Category columns in display order, per track.
  const catsByTrack = {};
  raw.forEach((r) => {
    const m = (catsByTrack[r.track_name] = catsByTrack[r.track_name] || {});
    m[r.category] = r.category_order;
  });
  const catList = (t) => Object.entries(catsByTrack[t] || {}).sort((a, b) => a[1] - b[1]).map(([name]) => name);

  // Per-category average across the same judges admin_results counts.
  const counted = raw.filter((r) => r.submitted_at && !r.excluded);
  const catAvg = {};
  counted.forEach((r) => {
    const k = `${r.track_name}|${r.entry_number}|${r.category}`;
    const a = (catAvg[k] = catAvg[k] || { sum: 0, n: 0 });
    a.sum += Number(r.raw_score); a.n++;
  });
  const catVal = (t, n, c) => { const a = catAvg[`${t}|${n}|${c}`]; return a ? a.sum / a.n : null; };

  // Judges with scores who are NOT counted: not submitted (and not marked test).
  const totalCells = {};
  tracks.forEach((t) => { totalCells[t] = results.filter((r) => r.track_name === t).length * catList(t).length; });
  const byJudge = {};
  raw.forEach((r) => {
    const j = (byJudge[r.event_judge_id] = byJudge[r.event_judge_id] || { judge: r.judge, email: r.email, submitted: !!r.submitted_at, excluded: r.excluded, track: r.track_name, n: 0 });
    j.n++;
  });
  const incomplete = Object.values(byJudge).filter((j) => !j.excluded && (!j.submitted || j.n < (totalCells[j.track] || 0)))
    .sort((a, b) => b.n - a.n);

  // A judge gave entries the same average AND the same Experience score, so
  // neither tie-breaker separates them; they split places. Flag for Nick.
  const stillTied = {};
  results.forEach((r) => (r.judge_scores || []).forEach((j) => {
    if (j.tie !== 'still_tied') return;
    const k = `${r.track_name}|${j.ej}|${j.avg}|${j.exp}`;
    (stillTied[k] = stillTied[k] || { track: r.track_name, judge: j.judge, avg: j.avg, exp: j.exp, pts: j.pts, entries: [] }).entries.push(r.entry_number);
  }));
  const stillTiedList = Object.values(stillTied).sort((a, b) => String(a.judge).localeCompare(String(b.judge)) || Number(a.pts) - Number(b.pts));

  function exportRaw() {
    const rows = [['judge', 'email', 'submitted', 'test', 'track', 'entry', 'category', 'score']];
    raw.forEach((r) => rows.push([r.judge, r.email, r.submitted_at ? 'yes' : 'no', r.excluded ? 'yes' : 'no', r.track_name, r.entry_number, r.category, r.raw_score]));
    downloadCsv(`${code}-raw-scores.csv`, rows);
  }
  // One row per counted judge per entry: the category scores, that judge's
  // average (what they're ranked on) and the rank points it earned. Summing
  // rank_points by entry reproduces the Rank pts column exactly.
  function exportWorkings() {
    const rows = [];
    tracks.forEach((t) => {
      const cats = catList(t);
      rows.push(['track', 'judge', 'entry', ...cats, 'judge_avg', 'rank_points']);
      const cell = {};
      counted.filter((r) => r.track_name === t).forEach((r) => {
        const k = `${r.event_judge_id}|${r.entry_number}`;
        (cell[k] = cell[k] || { judge: r.judge, ej: r.event_judge_id, entry: r.entry_number, s: {} }).s[r.category] = Number(r.raw_score);
      });
      const pts = {};
      results.filter((r) => r.track_name === t).forEach((r) => (r.judge_scores || []).forEach((j) => { pts[`${j.ej}|${r.entry_number}`] = j.pts; }));
      Object.values(cell).sort((a, b) => String(a.judge).localeCompare(String(b.judge)) || a.entry - b.entry).forEach((c) => {
        const vals = cats.map((k) => c.s[k]);
        const got = vals.filter((v) => v != null);
        const avg = got.length ? got.reduce((x, y) => x + y, 0) / got.length : null;
        const p = pts[`${c.ej}|${c.entry}`];
        rows.push([t, c.judge, c.entry, ...vals, avg == null ? '' : avg.toFixed(3), p == null ? '' : p]);
      });
    });
    downloadCsv(`${code}-workings.csv`, rows);
  }

  function exportResults() {
    const rows = [];
    tracks.forEach((t) => {
      const cats = catList(t);
      rows.push(['track', 'rank', 'tied', 'entry', ...(showReveal ? ['strain', 'brand'] : []), 'rank_points', 'judges_ranked', 'avg_score', ...cats, 'judges', 'min_judge', 'max_judge', 'spread']);
      rankRows(results.filter((r) => r.track_name === t)).forEach((r) => {
        const rv = reveal && reveal[r.entry_id];
        rows.push([t, r.rank, r.tied ? 'yes' : '', r.entry_number, ...(showReveal ? [rv && rv.strain, rv && rv.brand] : []),
          r.rank_points, r.ranked_judges, r.score, ...cats.map((c) => { const v = catVal(t, r.entry_number, c); return v == null ? '' : v.toFixed(3); }),
          r.judge_count, r.min_judge, r.max_judge, r.stddev]);
      });
    });
    downloadCsv(`${code}-results.csv`, rows);
  }

  return (
    <>
      <div className="admin-meta">
        <span>Submitted, non-test judges only · {maxJudges} judges counted · updated {ago(loadedAt, now)}</span>
        <label className="admin-check"><input type="checkbox" checked={showReveal} onChange={(e) => setShowReveal(e.target.checked)} /> Show strain</label>
        <label className="admin-check"><input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Compare with / without rank scoring</label>
        <button className="admin-link" onClick={reload}>Refresh now</button>
      </div>
      <div className="admin-meta">
        <button className="admin-link" onClick={exportResults}>Download results (CSV)</button>
        <button className="admin-link" onClick={exportWorkings}>Download workings (CSV)</button>
        <button className="admin-link" onClick={exportRaw}>Download every score (CSV)</button>
      </div>
      {incomplete.length > 0 && (
        <div className="admin-callout">
          <b>{incomplete.length} judge{incomplete.length === 1 ? '' : 's'} incomplete or not submitted — left out of rank points</b>
          <ul>
            {incomplete.map((j, i) => (
              <li key={i}>{j.judge || '(no name)'}: {j.n}/{totalCells[j.track] || '?'} scores{j.submitted ? ', submitted' : ', not submitted'}</li>
            ))}
          </ul>
          <span className="admin-sub">Their scores are in "Download every score" (submitted = no). Mark a judge Test on Progress to drop them from this list.</span>
        </div>
      )}
      {stillTiedList.length > 0 && (
        <div className="admin-callout">
          <b>{stillTiedList.length} tie{stillTiedList.length === 1 ? '' : 's'} inside a judge's ranking that Experience couldn't break — check with the organizer</b>
          <ul>
            {stillTiedList.map((g, i) => (
              <li key={i}>{tracks.length > 1 ? `${g.track} · ` : ''}{g.judge}: entries {g.entries.sort((a, b) => a - b).map((n) => '#' + n).join(', ')} all averaged {g.avg} with Experience {g.exp ?? '—'} → {Number(g.pts)} pts each</li>
            ))}
          </ul>
        </div>
      )}
      <p className="muted-note">Overall placing uses rank points: each judge ranks every entry by their own average across categories (highest = 1 point, lowest = {results.filter((r) => r.track_name === tracks[0]).length} points; if a judge gives entries the same average, their Experience score decides, and only if that matches too do they split the places), points are added up, and the lowest total wins. Only judges who scored every entry rank. Equal points are broken by Avg, the plain average across judges; only if both match do entries share a rank (marked =). Category columns are the plain average of counted judges' scores in that category. Spread is the standard deviation of judge averages; highlighted when more than 1.5× the event's median.</p>
      {error && <div className="err">Refresh failed: {error}</div>}
      {compare && tracks.map((t) => {
        const withRank = rankRows(results.filter((r) => r.track_name === t));
        // Without rank scoring: plain average across judges, highest first.
        const byAvg = [...withRank].filter((r) => r.score != null).sort((a, b) => Number(b.score) - Number(a.score));
        const avgRank = {};
        let prev = null; let prevRank = 0;
        byAvg.forEach((r, i) => {
          const s = Number(r.score).toFixed(3);
          const rk = s === prev ? prevRank : i + 1;
          avgRank[r.entry_id] = rk; prev = s; prevRank = rk;
        });
        return (
          <Fragment key={'c' + t}>
            <h2 className="admin-h2">{tracks.length > 1 ? `${t}: ` : ''}With vs without rank scoring</h2>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead><tr><th>With rank scoring</th><th>Rank pts</th><th>Without (avg only)</th><th>Avg</th><th>Moved</th></tr></thead>
                <tbody>
                  {withRank.filter((r) => r.rank != null).map((r) => {
                    const a = avgRank[r.entry_id];
                    const diff = a != null ? a - r.rank : null; // positive = rank scoring moved it up
                    const rv = showReveal && reveal && reveal[r.entry_id];
                    return (
                      <tr key={r.entry_id}>
                        <td><b>{r.tied ? '=' : ''}{r.rank}</b> · Entry #{r.entry_number}{rv && rv.strain ? <div className="admin-sub">{rv.strain}</div> : null}</td>
                        <td>{Number(r.rank_points)}</td>
                        <td>{a ?? '—'}</td>
                        <td>{Number(r.score).toFixed(2)}</td>
                        <td className={diff ? 'admin-warn' : ''}>{diff == null || diff === 0 ? '—' : diff > 0 ? `▲ ${diff}` : `▼ ${-diff}`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted-note">"Moved" is how many places rank scoring moved the entry compared with ranking by plain average (▲ up, ▼ down).</p>
          </Fragment>
        );
      })}
      {tracks.map((t) => {
        const cats = catList(t);
        const rows = rankRows(results.filter((r) => r.track_name === t));
        const cols = 7 + cats.length + (showReveal ? 1 : 0);
        const maxRanked = Math.max(0, ...rows.map((r) => Number(r.ranked_judges)));
        return (
          <Fragment key={t}>
            {tracks.length > 1 && <h2 className="admin-h2">{t}</h2>}
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr><th>#</th><th>Entry</th>{showReveal && <th>Strain</th>}<th>Rank pts</th><th>Avg</th>{cats.map((c) => <th key={c}>{c}</th>)}<th>Judges</th><th>Range</th><th>Spread</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const scored = r.score != null;
                    const ranked = r.rank_points != null;
                    const hot = medSd != null && r.stddev != null && Number(r.stddev) > 1.5 * medSd;
                    const rv = reveal && reveal[r.entry_id];
                    const isOpen = open === r.entry_id;
                    return (
                      <Fragment key={r.entry_id}>
                        <tr className="admin-click" onClick={() => setOpen(isOpen ? null : r.entry_id)}>
                          <td className="admin-rank">{ranked ? (r.tied ? `=${r.rank}` : r.rank) : '—'}</td>
                          <td>Entry #{r.entry_number}</td>
                          {showReveal && <td>{rv && (rv.strain || rv.brand) ? <>{rv.strain || '—'}<div className="admin-sub">{rv.brand}</div></> : <span className="admin-sub">not mapped</span>}</td>}
                          <td className="admin-score">{ranked ? Number(r.rank_points).toString() : '—'}{ranked && Number(r.ranked_judges) < maxRanked && <div className="admin-sub admin-warn">{r.ranked_judges} judges</div>}</td>
                          <td>{scored ? Number(r.score).toFixed(2) : '—'}</td>
                          {cats.map((c) => { const v = catVal(t, r.entry_number, c); return <td key={c}>{v == null ? '—' : v.toFixed(1)}</td>; })}
                          <td className={Number(r.judge_count) < maxJudges ? 'admin-warn' : ''}>{r.judge_count}</td>
                          <td>{scored ? `${r.min_judge}–${r.max_judge}` : '—'}</td>
                          <td className={hot ? 'admin-warn' : ''}>{r.stddev != null ? r.stddev : '—'}</td>
                        </tr>
                        {isOpen && (
                          <tr className="admin-detail">
                            <td colSpan={cols}>
                              {r.judge_scores.length ? r.judge_scores.map((j, i) => (
                                <span key={i} className="admin-chip">{j.judge}: <b>{j.avg}</b>{j.pts != null && <> · {Number(j.pts)} pt{Number(j.pts) === 1 ? '' : 's'}</>}{j.tie === 'experience' && <> · <i>tie broken by Experience ({j.exp})</i></>}{j.tie === 'still_tied' && <> · <b className="admin-warn">still tied (Experience {j.exp})</b></>}</span>
                              )) : <span className="admin-sub">No submitted scores yet.</span>}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Fragment>
        );
      })}
      <p className="muted-note">Tap a row to see each judge's average and rank points for that entry.</p>
    </>
  );
}

// Accepts CSV or tab-separated rows: entry_number, strain, brand, submitter_name
// (header row optional). Pasted straight from a spreadsheet works.
// Commas inside double quotes stay part of the value ("Farms, LLC").
function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseMapping(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const cells = line.includes('\t')
      ? line.split('\t').map((c) => c.trim().replace(/^"|"$/g, ''))
      : splitCsvLine(line).map((c) => c.trim());
    const n = parseInt(cells[0], 10);
    if (Number.isNaN(n)) continue; // header or junk
    rows.push({ entry_number: n, strain: cells[1] || '', brand: cells[2] || '', submitter_name: cells[3] || '' });
  }
  return rows;
}

function Reveal({ code }) {
  const [rows, setRows] = useState(null);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.rpc('admin_reveal', { p_event_code: code });
    if (e) setError(e.message); else setRows(data || []);
  }, [code]);
  useEffect(() => { load(); }, [load]);

  const parsed = parseMapping(text);

  async function save() {
    setMsg(''); setError('');
    if (!parsed.length) { setError('Nothing to save — paste rows starting with an entry number.'); return; }
    setBusy(true);
    const { data, error: e } = await supabase.rpc('admin_set_reveal', { p_event_code: code, p_rows: parsed });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setMsg(`Saved ${data} entries.`); setText(''); load();
  }

  if (!rows) return <div className="muted-note">{error || 'Loading…'}</div>;
  const mapped = rows.filter((r) => r.strain || r.brand).length;

  return (
    <>
      <p className="muted-note">Entry number → strain mapping from the organizer. Operator-only: judges never see this. {mapped}/{rows.length} entries mapped.</p>
      <label htmlFor="reveal-paste">Paste mapping (entry #, strain, brand, submitter)</label>
      <textarea id="reveal-paste" className="admin-paste" value={text} onChange={(e) => setText(e.target.value)} placeholder={'1, Strain name, Brand, Submitter\n2, …'} />
      <button className="btn primary" onClick={save} disabled={busy || !parsed.length}>{busy ? 'Saving…' : `Save ${parsed.length || ''} rows`}</button>
      {msg && <div className="ok">{msg}</div>}
      {error && <div className="err">{error}</div>}
      <div className="admin-table-wrap" style={{ marginTop: 20 }}>
        <table className="admin-table">
          <thead><tr>{new Set(rows.map((r) => r.track_name)).size > 1 && <th>Track</th>}<th>Entry</th><th>Strain</th><th>Brand</th><th>Submitter</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.entry_id}>
                {new Set(rows.map((x) => x.track_name)).size > 1 && <td>{r.track_name}</td>}
                <td>#{r.entry_number}</td><td>{r.strain || '—'}</td><td>{r.brand || '—'}</td><td>{r.submitter_name || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
