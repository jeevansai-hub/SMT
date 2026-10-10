import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { DecisionOutcome, IntegrityEventType, QueueCase, ReviewCase } from '../api/types';
import {
  Alert,
  ConfirmDialog,
  Empty,
  ErrorPanel,
  ExperimentalBanner,
  Field,
  Loading,
  PageHeading,
  StatCards,
  UnderstandingChip,
  fmtDate,
  useAsync,
} from '../components/ui';

const REASON_TEXT: Record<QueueCase['reason'], string> = {
  low_confidence: 'Low confidence',
  appeal: 'Appeal',
  conflict: 'Automated test and AI-assisted judgement disagree',
  integrity_risk: 'Session flagged for human review',
};
const CONF = { low: 'Low', medium: 'Medium', high: 'High' } as const;
const EVENT_TEXT: Record<IntegrityEventType, string> = {
  focus_loss: 'Window focus left',
  tab_hidden: 'Tab hidden',
  fullscreen_exit: 'Full screen exited',
  paste: 'Paste',
  copy: 'Copy',
  context_menu: 'Context menu opened',
  devtools_heuristic: 'Window size heuristic (developer tools)',
  multi_display: 'Multiple displays',
  camera_lost: 'Camera stopped',
  screen_share_ended: 'Screen share ended',
  network_drop: 'Network drop',
  face_absent: 'Face not in view',
  multiple_faces: 'More than one face in view',
};

export function ReviewQueuePage() {
  const q = useAsync(() => api.reviewQueue());
  const [filter, setFilter] = useState<'all' | QueueCase['reason']>('all');
  const cases = (q.data?.cases ?? []).filter((c) => filter === 'all' || c.reason === filter);
  return (
    <div>
      <PageHeading>Review queue</PageHeading>
      <p className="muted">Cases are ordered by uncertainty, highest first. Identity is shown as an alias only.</p>
      {q.loading ? <Loading label="Loading the queue" /> : null}
      {q.error ? <ErrorPanel error={q.error} onRetry={q.reload} what="the queue" /> : null}
      {q.data ? (
        q.data.cases.length === 0 ? (
          <Empty>No cases need review.</Empty>
        ) : (
          <>
            <StatCards
              items={[
                { label: 'Cases in queue', value: q.data.cases.length },
                { label: 'Low confidence', value: q.data.cases.filter((c) => c.confidence === 'low').length, tone: 'warning' },
                { label: 'Integrity-flagged', value: q.data.cases.filter((c) => c.reason === 'integrity_risk').length },
              ]}
            />
            <Field id="filter" label="Show">
              {(p) => (
                <select {...p} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
                  <option value="all">All reasons</option>
                  {(Object.keys(REASON_TEXT) as QueueCase['reason'][]).map((r) => (
                    <option key={r} value={r}>
                      {REASON_TEXT[r]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <div className="table-wrap">
              <table>
                <caption>Cases waiting for a decision</caption>
                <thead>
                  <tr>
                    <th scope="col">Alias</th>
                    <th scope="col">Criterion</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Confidence</th>
                    <th scope="col">Queued</th>
                    <th scope="col">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cases.map((c) => (
                    <tr key={c.case_id}>
                      <th scope="row" className="mono">
                        {c.alias}
                      </th>
                      <td>{c.criterion}</td>
                      <td>{REASON_TEXT[c.reason]}</td>
                      <td>{CONF[c.confidence]}</td>
                      <td>{fmtDate(c.created_at)}</td>
                      <td>
                        <Link className="btn secondary" to={`/review/${encodeURIComponent(c.case_id)}`}>
                          Open case<span className="sr-only"> for {c.alias}</span>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      ) : null}
    </div>
  );
}

const STREAM_LABEL: Record<ReviewCase['streams'][number], string> = {
  camera: 'Camera and microphone',
  screen: 'Screen',
  justification: 'Voice justification',
};

function Recording({ c }: { c: ReviewCase }) {
  if (c.streams.length === 0) return <p>No recording is available for this attempt.</p>;
  return (
    <div className="grid-2">
      {c.streams.map((s) => (
        <figure key={s} style={{ margin: 0 }}>
          <video
            controls
            preload="none"
            src={api.recordingUrl(c.attempt_id, s)}
            style={{ width: '100%', background: '#000' }}
            aria-label={`${STREAM_LABEL[s]} recording`}
          />
          <figcaption className="small muted">
            {STREAM_LABEL[s]}
            {s !== 'justification' ? '. A transcript is shown below where available.' : '.'}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

export function ReviewCasePage() {
  const { caseId = '' } = useParams();
  const c = useAsync(() => api.reviewCase(caseId), [caseId]);
  const [outcome, setOutcome] = useState<DecisionOutcome | ''>('');
  const [reason, setReason] = useState('');
  const [errs, setErrs] = useState<{ outcome?: string; reason?: string }>({});
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recorded, setRecorded] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const validate = (e: FormEvent) => {
    e.preventDefault();
    const er: typeof errs = {};
    if (!outcome) er.outcome = 'Choose a decision.';
    if (reason.trim().length < 10) er.reason = 'Give a reason of at least 10 characters that rests on a rubric criterion.';
    setErrs(er);
    if (!er.outcome && !er.reason) setConfirm(true);
  };

  const record = async () => {
    setConfirm(false);
    if (!outcome) return;
    setBusy(true);
    setFailed(null);
    try {
      const r = await api.decide(caseId, { outcome, reason: reason.trim() });
      setRecorded(r.ledger_entry);
    } catch (e) {
      setFailed(
        e instanceof ApiError && e.status === 409
          ? 'This case was decided by another reviewer.'
          : 'Not recorded yet. Your decision is still in the form. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (c.loading)
    return (
      <div>
        <PageHeading>Review case</PageHeading>
        <Loading label="Loading case" />
      </div>
    );
  if (c.error || !c.data)
    return (
      <div>
        <PageHeading>Review case</PageHeading>
        <ErrorPanel error={c.error} onRetry={c.reload} what="this case" />
      </div>
    );
  const d = c.data;
  const missing = !d.original_work;
  const readOnly = d.status === 'decided' || recorded !== null || missing;

  const counts = Object.entries(d.integrity.counts).filter(([, n]) => (n ?? 0) > 0) as Array<[IntegrityEventType, number]>;

  return (
    <div>
      <PageHeading>{`Review case for ${d.alias}`}</PageHeading>
      <ExperimentalBanner />
      <p className="muted">
        Criterion: {d.criterion}. Reason in queue: {REASON_TEXT[d.reason]}. Confidence: {CONF[d.confidence]}.
      </p>
      {d.status === 'decided' ? <Alert kind="info">This case was decided by another reviewer.</Alert> : null}
      {missing ? <Alert kind="error">Original work is unavailable. You cannot decide this case.</Alert> : null}
      {d.reason === 'conflict' ? <Alert kind="warning">Automated test and AI-assisted judgement disagree. Both are shown.</Alert> : null}
      {d.probe_status === 'unconfirmed' ? (
        <Alert kind="info">
          Output verified, understanding unconfirmed. This is not a finding about the learner&apos;s conduct. Decide only on the rubric.
        </Alert>
      ) : null}

      <div className="grid-2">
        <section className="panel" aria-labelledby="orig">
          <h2 id="orig">Original work</h2>
          <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
            {d.original_work}
          </pre>
          {d.appeal_text ? (
            <>
              <h3>Learner appeal</h3>
              <p>{d.appeal_text}</p>
            </>
          ) : null}
        </section>
        <section className="panel" aria-labelledby="ai">
          <h2 id="ai">AI-assisted rationale and rubric</h2>
          <p>
            <strong>AI-assisted judgement</strong> (confidence: {CONF[d.confidence]})
          </p>
          <p>{d.ai_rationale ?? 'No rationale was produced.'}</p>
          <h3>Rubric (version {d.rubric_version})</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{d.rubric_text}</p>
          {d.probe_status ? (
            <p>
              <UnderstandingChip status={d.probe_status} />
            </p>
          ) : null}
          {d.flags.length > 0 ? (
            <ul>
              {d.flags.map((f) => (
                <li key={f}>Review flag: {f}. A flag does not change the result.</li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>

      <section className="panel" aria-labelledby="integ">
        <h2 id="integ">Integrity summary</h2>
        <p>
          Risk label: <span className="chip">{CONF[d.integrity.risk]}</span>. This summary is context for you. It never changes a result by
          itself.
        </p>
        {d.integrity.isolation_mode ? <p className="small muted">Runner isolation: {d.integrity.isolation_mode}</p> : null}
        {counts.length === 0 ? (
          <p>No integrity events were recorded.</p>
        ) : (
          <table>
            <caption className="sr-only">Integrity events by type</caption>
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Count</th>
              </tr>
            </thead>
            <tbody>
              {counts.map(([t, n]) => (
                <tr key={t}>
                  <th scope="row">{EVENT_TEXT[t]}</th>
                  <td>{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel" aria-labelledby="rec">
        <h2 id="rec">Recording</h2>
        <Recording c={d} />
        {d.transcript && d.transcript.length > 0 ? (
          <details open>
            <summary>Transcript</summary>
            <ul>
              {d.transcript.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      {d.prior_decisions && d.prior_decisions.length > 0 ? (
        <section className="panel">
          <h2>Prior decisions</h2>
          <ul>
            {d.prior_decisions.map((p, i) => (
              <li key={i}>
                {fmtDate(p.at)}: {p.outcome}. {p.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="dec">
        <h2 id="dec">Decision</h2>
        {recorded !== null ? (
          <>
            <Alert kind="success">Decision recorded in the ledger as entry {recorded}.</Alert>
            <Link className="btn" to="/review">
              Back to the queue
            </Link>
          </>
        ) : (
          <form onSubmit={validate} noValidate className="narrow">
            {failed ? <Alert kind="error">{failed}</Alert> : null}
            <fieldset disabled={readOnly} aria-describedby={errs.outcome ? 'outcome-err' : undefined}>
              <legend>Outcome</legend>
              {(
                [
                  ['uphold', 'Uphold result'],
                  ['change', 'Change result'],
                  ['more_info', 'Needs more information'],
                ] as const
              ).map(([v, l]) => (
                <label key={v} className="check-row">
                  <input type="radio" name="outcome" value={v} checked={outcome === v} onChange={() => setOutcome(v)} />
                  <span>{l}</span>
                </label>
              ))}
              {errs.outcome ? (
                <span id="outcome-err" style={{ color: 'var(--color-error)' }}>
                  {errs.outcome}
                </span>
              ) : null}
            </fieldset>
            <Field id="reason" label="Reason" hint="Which part of the rubric does this rest on?" error={errs.reason}>
              {(p) => <textarea {...p} disabled={readOnly} value={reason} onChange={(e) => setReason(e.target.value)} />}
            </Field>
            <button type="submit" className="btn" disabled={readOnly || busy}>
              Record decision
            </button>
          </form>
        )}
      </section>

      {confirm ? (
        <ConfirmDialog title="Record this decision?" confirmLabel="Record decision" onCancel={() => setConfirm(false)} onConfirm={() => void record()}>
          <p>The decision and your reason are written to the ledger and cannot be edited.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
