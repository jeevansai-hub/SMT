import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { CompetencyProfile, GrantRequest, Method, ResultItem } from '../api/types';
import {
  Alert,
  ConfirmDialog,
  Empty,
  ErrorPanel,
  EstimateBand,
  ExperimentalBanner,
  Field,
  Loading,
  MethodLabel,
  PageHeading,
  UnderstandingChip,
  competencyName,
  fmtDate,
  useAsync,
} from '../components/ui';
import { LEVEL_INFO } from './Path';
import { CONSENT_VERSION } from './Lobby';

const OUTCOME_TEXT: Record<ResultItem['outcome'], string> = {
  pass: 'Passed',
  partial: 'Partly passed',
  fail: 'Not passed',
  inconclusive: 'Inconclusive',
  pending_review: 'Pending review',
};
const CONF_TEXT = { low: 'Low', medium: 'Medium', high: 'High' } as const;

export function ResultPage() {
  const { attemptId = '' } = useParams();
  const a = useAsync(() => api.attempt(attemptId), [attemptId]);
  return (
    <div>
      <PageHeading>Level result</PageHeading>
      {a.loading ? <Loading label="Checking your answer. This can take up to a minute." /> : null}
      {a.error ? <ErrorPanel error={a.error} onRetry={a.reload} what="this result" /> : null}
      {a.data && !a.data.result ? (
        <Alert kind="info">Your result is not ready yet. You can leave this page and come back. Your work is saved.</Alert>
      ) : null}
      {a.data?.result ? (
        <>
          <div className="panel" role="status">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
              <div>
                <h2>
                  Level {a.data.result.level}: {LEVEL_INFO[a.data.result.level]?.name ?? 'Benchmark Test'}
                </h2>
                <p style={{ margin: 0, marginTop: '0.25rem' }}>
                  {a.data.result.outcome === 'passed'
                    ? 'You passed this level. Your progress is saved.'
                    : a.data.result.outcome === 'in_review'
                      ? 'We are not sure about part of this result. A person will check it. Your current result stays visible until then.'
                      : 'This level was not passed this time. You can try again with a fresh set. Your earlier attempts are kept.'}
                </p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span className={`chip ${a.data.result.outcome === 'passed' ? 'success' : 'warning'}`} style={{ fontSize: '0.9rem', fontWeight: 'bold' }}>
                  {a.data.result.outcome === 'passed' ? '✓ PASSED' : 'NOT PASSED'}
                </span>
                <div style={{ fontSize: '1.25rem', fontWeight: 'bold', marginTop: '0.35rem' }}>
                  Score: {a.data.result.items_passed ?? 0} / {a.data.result.items_total ?? a.data.result.items?.length ?? 0}
                  {a.data.result.score_percentage !== undefined ? ` (${a.data.result.score_percentage}%)` : ''}
                </div>
              </div>
            </div>

            {a.data.result.evidence_receipt || a.data.result.evidence_hash ? (
              <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'var(--panel-alt)', borderRadius: '0.375rem', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', fontWeight: 600 }}>
                  Cryptographic Evidence Proof
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: '0.85rem', wordBreak: 'break-all', marginTop: '0.25rem' }}>
                  {a.data.result.evidence_receipt ?? a.data.result.evidence_hash}
                </div>
              </div>
            ) : null}
          </div>
          {a.data.result.items && a.data.result.items.length > 0 ? (
            <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
              {a.data.result.items.map((it, i) => (
                <li key={it.event_id ?? i} className="panel">
                  <h3>{it.label}</h3>
                  <p className="row" style={{ margin: 0 }}>
                    <span className="chip">{OUTCOME_TEXT[it.outcome]}</span>
                    <MethodLabel method={it.method} />
                    {it.ai_disclosure ? <span className="chip warning">AI-assisted feedback</span> : null}
                    {it.confidence ? <span className="chip">Confidence: {CONF_TEXT[it.confidence]}</span> : null}
                  </p>
                  {it.reason ? <p>{it.reason}</p> : null}
                  {it.event_id ? (
                    <Link className="btn quiet" to={`/appeals?event=${encodeURIComponent(it.event_id)}`}>
                      Appeal this result<span className="sr-only">: {it.label}</span>
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="row">
            {a.data.result.outcome === 'passed' && a.data.result.all_passed ? (
              <Link className="btn" to="/profile">
                See your profile
              </Link>
            ) : null}
            {a.data.result.outcome === 'passed' && a.data.result.next_level ? (
              <Link className="btn" to={`/lobby/${a.data.result.next_level}`}>
                Continue to Level {a.data.result.next_level}
              </Link>
            ) : null}
            {a.data.result.outcome === 'not_passed' ? (
              <Link className="btn" to={`/lobby/${a.data.result.level}`}>
                Try again with a fresh set
              </Link>
            ) : null}
            <Link className="btn quiet" to="/path">
              Back to My path
            </Link>
          </div>
        </>
      ) : null}
    </div>
  );
}

const METHODS: Method[] = ['deterministic_test', 'probe', 'ai_judged', 'live_screening', 'human_review'];

function CompetencyCard({ c, ai }: { c: CompetencyProfile; ai: boolean }) {
  const auto = c.method_counts.deterministic_test + c.method_counts.probe;
  const live = c.method_counts.live_screening;
  return (
    <section className="panel" aria-labelledby={`c-${c.competency_id}`}>
      <h2 id={`c-${c.competency_id}`}>{competencyName(c.competency_id)}</h2>
      {c.estimate !== null && c.lower !== null && c.upper !== null && c.as_of ? (
        <EstimateBand label={competencyName(c.competency_id)} estimate={c.estimate} lower={c.lower} upper={c.upper} asOf={c.as_of} />
      ) : null}
      <p>
        Levels passed: {c.levels_passed.length > 0 ? c.levels_passed.join(', ') : 'none yet'}.{' '}
        <span className="muted small">Older evidence widens the range.</span>
      </p>
      <p>
        <UnderstandingChip status={c.understanding_status} />
      </p>
      <h3>How this was evidenced</h3>
      <table>
        <caption className="sr-only">Evidence by method for {competencyName(c.competency_id)}</caption>
        <thead>
          <tr>
            <th scope="col">Method</th>
            <th scope="col">Items</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Automated-test evidence (tests and probes)</th>
            <td>{auto}</td>
          </tr>
          <tr>
            <th scope="row">Live-screening evidence (Level 4)</th>
            <td>{live}</td>
          </tr>
          {METHODS.map((m) => (
            <tr key={m}>
              <th scope="row">
                <MethodLabel method={m} />
              </th>
              <td>{c.method_counts[m]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {ai ? <p className="chip warning">AI-assisted feedback is part of this evidence. You can appeal any item.</p> : null}
      {c.evidence_items.length > 0 ? (
        <details>
          <summary>Evidence items ({c.evidence_items.length})</summary>
          <ul>
            {c.evidence_items.map((e) => (
              <li key={e.event_id}>
                <MethodLabel method={e.method} /> {e.outcome}, {fmtDate(e.occurred_at)}, rubric {e.rubric_version}{' '}
                <Link to={`/appeals?event=${encodeURIComponent(e.event_id)}`}>Appeal</Link>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export function ProfilePage() {
  const p = useAsync(() => api.profile());
  const prof = p.data;
  return (
    <div>
      <PageHeading>Profile</PageHeading>
      <ExperimentalBanner />
      {p.loading ? <Loading /> : null}
      {p.error ? <ErrorPanel error={p.error} onRetry={p.reload} what="your profile" /> : null}
      {prof ? (
        prof.levels_passed.length === 0 && prof.competencies.every((c) => c.evidence_items.length === 0) ? (
          <Empty action={<Link className="btn" to="/path">Go to My path</Link>}>
            No evidence yet. Complete Level 1 to start your profile.
          </Empty>
        ) : !prof.all_levels_passed ? (
          <>
            <Alert kind="info">
              Your estimate updates after all four levels are passed. Levels passed so far:{' '}
              {prof.levels_passed.length > 0 ? prof.levels_passed.join(', ') : 'none'}.
            </Alert>
            <p>
              <Link to="/path">Back to My path</Link>
            </p>
          </>
        ) : (
          <>
            <p role="status">Only you can see this unless you share it. <Link to="/sharing">Manage sharing</Link></p>
            {prof.competencies.map((c) => (
              <CompetencyCard key={c.competency_id} c={c} ai={prof.labels.ai_used} />
            ))}
          </>
        )
      ) : null}
    </div>
  );
}

export function SharingPage() {
  const ev = useAsync(() => api.evidence());
  const [recipient, setRecipient] = useState('');
  const [comps, setComps] = useState<string[]>([]);
  const [raw, setRaw] = useState(false);
  const [expires, setExpires] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (!/^org_[a-z0-9_]{3,40}$/.test(recipient)) er.recipient = 'Enter the organisation code you were given, like org_acme.';
    if (comps.length === 0) er.comps = 'Choose at least one skill to share.';
    if (!expires) er.expires = 'Choose an expiry date.';
    else if (new Date(expires).getTime() <= Date.now()) er.expires = 'Choose a date in the future.';
    setErrors(er);
    if (Object.keys(er).length) return;
    const body: GrantRequest = {
      recipient_id: recipient,
      competencies: comps,
      include_raw_submission: raw,
      expires_at: new Date(`${expires}T23:59:59Z`).toISOString(),
      consent_text_version: CONSENT_VERSION,
    };
    setBusy(true);
    try {
      await api.createGrant(body);
      setMsg({ kind: 'success', text: 'Sharing is on. The organisation can now see what you chose.' });
      setRecipient('');
      setComps([]);
      setRaw(false);
      setExpires('');
      ev.reload();
    } catch {
      setMsg({ kind: 'error', text: 'Sharing was not saved. Nothing has been shared. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setRevoking(null);
    try {
      await api.revokeGrant(id);
      setMsg({ kind: 'success', text: "Access removed. It takes effect on the organisation's next request." });
      ev.reload();
    } catch {
      setMsg({ kind: 'error', text: 'We could not stop sharing. Try again.' });
    }
  };

  const preview =
    recipient && comps.length > 0
      ? `${recipient} will see your estimate range, evidence methods and understanding status for ${comps
          .map(competencyName)
          .join(' and ')}${raw ? ', and the text of your submission' : ''}${expires ? `, until ${fmtDate(expires)}` : ''}.`
      : null;

  return (
    <div>
      <PageHeading>Sharing</PageHeading>
      <p className="muted">You decide who can see your evidence. You can stop sharing at any time.</p>
      {msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : null}
      {ev.loading ? <Loading /> : null}
      {ev.error ? <ErrorPanel error={ev.error} onRetry={ev.reload} what="your sharing settings" /> : null}
      {ev.data ? (
        <>
          <h2>Who can see your evidence</h2>
          {ev.data.grants.length === 0 ? (
            <Empty>Nobody can see your evidence. Sharing is off until you choose to share.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Active grants</caption>
                <thead>
                  <tr>
                    <th scope="col">Organisation</th>
                    <th scope="col">Skills</th>
                    <th scope="col">Submission text</th>
                    <th scope="col">Expires</th>
                    <th scope="col">
                      <span className="sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ev.data.grants.map((g) => (
                    <tr key={g.grant_id}>
                      <th scope="row" className="mono">
                        {g.recipient_id}
                      </th>
                      <td>{g.competencies.map(competencyName).join(', ')}</td>
                      <td>{g.include_raw_submission ? 'Included' : 'Not included'}</td>
                      <td>{fmtDate(g.expires_at)}</td>
                      <td>
                        <button type="button" className="btn danger" onClick={() => setRevoking(g.grant_id)}>
                          Stop sharing<span className="sr-only"> with {g.recipient_id}</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      <h2 style={{ marginTop: 'var(--space-6)' }}>Share with an organisation</h2>
      <form onSubmit={submit} noValidate className="narrow">
        <Field id="recipient" label="Organisation code" hint="The recruiter gives you this code." error={errors.recipient}>
          {(p) => <input {...p} type="text" value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} autoComplete="off" />}
        </Field>
        <fieldset aria-describedby={errors.comps ? 'comps-err' : undefined}>
          <legend>Skills to share</legend>
          {['cmp_python', 'cmp_sql'].map((c) => (
            <label key={c} className="check-row">
              <input
                type="checkbox"
                checked={comps.includes(c)}
                onChange={(e) => setComps((s) => (e.target.checked ? [...s, c] : s.filter((x) => x !== c)))}
              />
              <span>{competencyName(c)}</span>
            </label>
          ))}
          {errors.comps ? (
            <span id="comps-err" className="error-text" style={{ color: 'var(--color-error)' }}>
              {errors.comps}
            </span>
          ) : null}
        </fieldset>
        <label className="check-row">
          <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />
          <span>Also share the text of my submissions. This is off unless you turn it on.</span>
        </label>
        <Field id="expires" label="Share until" hint="Required. Sharing stops on this date." error={errors.expires}>
          {(p) => <input {...p} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />}
        </Field>
        {preview ? (
          <div className="panel" role="status" aria-live="polite">
            <strong>Preview:</strong> {preview}
          </div>
        ) : null}
        <button type="submit" className="btn" disabled={busy}>
          Share
        </button>
      </form>

      {revoking ? (
        <ConfirmDialog
          title="Stop sharing?"
          confirmLabel="Stop sharing"
          danger
          onCancel={() => setRevoking(null)}
          onConfirm={() => void revoke(revoking)}
        >
          <p>The organisation will no longer be able to see this evidence.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

const APPEAL_STATUS = { received: 'Received', in_review: 'In review', decided: 'Decided' } as const;
const MAX_APPEAL = 1000;

export function AppealsPage() {
  const [params] = useSearchParams();
  const eventId = params.get('event') ?? undefined;
  const list = useAsync(() => api.appeals());
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (text.trim().length < 5) {
      setErr('Tell us what you think is wrong, in at least a few words.');
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await api.createAppeal({ event_id: eventId, text: text.trim() });
      setMsg({ kind: 'success', text: 'Appeal sent. A person will review it. Your current result stays visible until then.' });
      setText('');
      list.reload();
    } catch {
      setMsg({ kind: 'error', text: 'Your appeal was not sent. It is still in the box. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeading>Appeals</PageHeading>
      {msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : null}
      {eventId ? (
        <form onSubmit={submit} noValidate className="narrow">
          <h2>New appeal</h2>
          <Field
            id="appeal"
            label="What do you think is wrong?"
            hint={`Plain words are fine. Up to ${MAX_APPEAL} characters. The original result stays visible.`}
            error={err}
          >
            {(p) => <textarea {...p} maxLength={MAX_APPEAL} value={text} onChange={(e) => setText(e.target.value)} />}
          </Field>
          <p className="small muted">{text.length} of {MAX_APPEAL} characters used.</p>
          <button type="submit" className="btn" disabled={busy}>
            Send appeal
          </button>
        </form>
      ) : null}
      <h2 style={{ marginTop: 'var(--space-6)' }}>Your appeals</h2>
      {list.loading ? <Loading /> : null}
      {list.error ? <ErrorPanel error={list.error} onRetry={list.reload} what="your appeals" /> : null}
      {list.data ? (
        list.data.appeals.length === 0 ? (
          <Empty>You have no appeals.</Empty>
        ) : (
          <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
            {list.data.appeals.map((a) => (
              <li key={a.appeal_id} className="panel">
                <p className="row" style={{ margin: 0 }}>
                  <span className="chip">{APPEAL_STATUS[a.status]}</span>
                  <span className="small muted">Sent {fmtDate(a.created_at)}</span>
                </p>
                <p>{a.text}</p>
                {a.decision ? (
                  <p>
                    <strong>Decision:</strong> {a.decision.outcome}. <strong>Reason:</strong> {a.decision.reason}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
