import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Attempt, DecisionAnswer, ExamItem, LevelProgress, RunResult } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Alert, ConfirmDialog, ErrorPanel, Loading, useAsync } from '../components/ui';
import { CodeEditor } from '../components/CodeEditor';
import { ExamTopBar, FullscreenGate, ProctorSidebar } from '../components/ProctorChrome';
import { useProctoring } from '../integrity/useProctoring';
import { capture } from '../recording/session';

type Answer = string | string[] | DecisionAnswer;

// Per-level time limit in seconds (ADR-0004). L4 is the interview page's own timer.
const LEVEL_DURATION_S: Record<number, number> = { 1: 8 * 60, 2: 15 * 60, 3: 25 * 60, 4: 20 * 60 };

export function ExamPage() {
  const { attemptId = '' } = useParams();
  const a = useAsync(() => api.attempt(attemptId), [attemptId]);
  const hasStreams = !!capture.camera;
  if (a.loading) {
    return (
      <div className="container">
        <Loading label="Loading your level" />
      </div>
    );
  }
  if (a.error || !a.data) {
    return (
      <div className="container">
        <ErrorPanel error={a.error} onRetry={a.reload} what="this level" />
      </div>
    );
  }
  if (!hasStreams) {
    return (
      <main id="main" className="container narrow">
        <h1>Check in again to continue</h1>
        <p>
          The camera and screen connection was closed, for example by reloading the page. Your answers are saved.
          Complete the quick check-in to continue where you stopped.
        </p>
        <Link className="btn" to={`/lobby/${a.data.level}`}>
          Go to check-in
        </Link>
      </main>
    );
  }
  return <ExamRunner attempt={a.data} />;
}

function ExamRunner({ attempt }: { attempt: Attempt }) {
  const nav = useNavigate();
  const { me } = useAuth();
  const progress = useAsync(() => api.progress());
  const items = attempt.items;
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Answer>>(() =>
    Object.fromEntries(
      items.map((i) => [
        i.item_id,
        i.saved_answer ?? (
          (i.kind === 'multi_choice' || (i as any).kind === 'multi')
            ? []
            : (i.kind === 'code' || (i as any).kind === 'python' || (i as any).kind === 'sql')
              ? (i.starter_code ?? (i as any).broken_code ?? '')
              : i.kind === 'decision'
                ? ({ action: '', evidence: [] } satisfies DecisionAnswer)
                : ''
        ),
      ]),
    ),
  );
  const [explanations, setExplanations] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((i) => [i.item_id, i.saved_explanation ?? ''])),
  );
  const [saved, setSaved] = useState<Record<string, boolean>>(() => Object.fromEntries(items.map((i) => [i.item_id, !!i.answered])));
  const [marked, setMarked] = useState<Record<string, boolean>>({});
  const [runs, setRuns] = useState<Record<string, RunResult | 'running' | 'error'>>({});
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [justifying, setJustifying] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const current = items[idx];
  const currentId = useRef<string | null>(current?.item_id ?? null);
  currentId.current = current?.item_id ?? null;
  const p = useProctoring(attempt.attempt_id, () => currentId.current);
  const mainHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // do not steal focus from the full screen prompt (A11Y-3)
    if (!p.fsLocked) mainHeading.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Timed level (ADR-0004: overrides the PRD's no-timer accessibility default by Founder
  // decision). Deadline is anchored client-side on first mount and survives a page reload
  // via sessionStorage, keyed per attempt so switching levels/attempts doesn't inherit it.
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  const autoSubmitted = useRef(false);
  useEffect(() => {
    const key = `crucible-deadline-${attempt.attempt_id}`;
    let deadline = Number(sessionStorage.getItem(key));
    if (!deadline) {
      deadline = Date.now() + LEVEL_DURATION_S[attempt.level] * 1000;
      sessionStorage.setItem(key, String(deadline));
    }
    const tick = () => setRemainingSec(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [attempt.attempt_id, attempt.level]);

  const levels: LevelProgress[] = progress.data?.levels ?? [];

  const saveCurrent = async (): Promise<boolean> => {
    if (!current) return true;
    const ans = answers[current.item_id];
    const empty = Array.isArray(ans)
      ? ans.length === 0
      : typeof ans === 'object' && ans !== null
        ? !(ans as DecisionAnswer).action
        : (ans ?? '').trim() === '';
    if (empty) return true;
    try {
      await api.submitItem(attempt.attempt_id, {
        item_id: current.item_id,
        answer: ans,
        explanation: current.requires_explanation ? explanations[current.item_id] : undefined,
      });
      setSaved((s) => ({ ...s, [current.item_id]: true }));
      setMsg({ kind: 'success', text: 'Answer saved.' });
      return true;
    } catch {
      setMsg({ kind: 'error', text: 'Your answer was not sent. It is still in the box. Try again.' });
      return false;
    }
  };

  const go = async (to: number) => {
    if (await saveCurrent()) setIdx(Math.max(0, Math.min(items.length - 1, to)));
  };

  const run = async (item: ExamItem) => {
    const tid = item.task_id || item.item_id;
    if (!tid) return;
    setRuns((r) => ({ ...r, [item.item_id]: 'running' }));
    try {
      const res = await api.run(attempt.attempt_id, { task_id: tid, code: String(answers[item.item_id] ?? '') });
      setRuns((r) => ({ ...r, [item.item_id]: res }));
    } catch {
      setRuns((r) => ({ ...r, [item.item_id]: 'error' }));
    }
  };

  const finish = async () => {
    setFinishing(true);
    setConfirmFinish(false);
    if (!(await saveCurrent())) {
      setFinishing(false);
      return;
    }
    try {
      await p.finish();
      await api.finish(attempt.attempt_id);
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      capture.release();
      nav(`/result/${attempt.attempt_id}`, { replace: true });
    } catch {
      setMsg({ kind: 'error', text: 'We could not finish the level. Your answers are saved. Try again.' });
      setFinishing(false);
    }
  };

  useEffect(() => {
    if (remainingSec === 0 && !autoSubmitted.current && !finishing) {
      autoSubmitted.current = true;
      void finish();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remainingSec]);

  const unanswered = items.filter((i) => !saved[i.item_id]).length;
  const runState = current ? runs[current.item_id] : undefined;

  const stateOf = useMemo(
    () => (i: ExamItem, n: number) => {
      const parts: string[] = [];
      if (n === idx) parts.push('current');
      parts.push(saved[i.item_id] ? 'answered' : 'not answered');
      if (marked[i.item_id]) parts.push('marked for review');
      return parts.join(', ');
    },
    [idx, saved, marked],
  );

  return (
    <div className="exam">
      <a className="skip-link" href="#exam-main">
        Skip to question
      </a>
      <ExamTopBar alias={me?.alias ?? 'candidate'} level={attempt.level} levels={levels} p={p} remainingSec={remainingSec} />
      <div className="exam-body">
        <nav className="exam-nav" aria-label="Questions">
          <h2 style={{ fontSize: '1rem' }}>Questions</h2>
          <ol className="qnav">
            {items.map((i, n) => (
              <li key={i.item_id}>
                <button
                  type="button"
                  aria-current={n === idx ? 'true' : undefined}
                  onClick={() => void go(n)}
                  aria-label={`Question ${n + 1}, ${stateOf(i, n)}`}
                >
                  <span>Question {n + 1}</span>
                  <span aria-hidden="true">
                    {saved[i.item_id] ? '✓' : '○'}
                    {marked[i.item_id] ? ' ⚑' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <main id="exam-main" className="exam-main">
          {items.length === 0 ? (
            <Alert kind="info">There are no questions in this level yet.</Alert>
          ) : current ? (
            <section aria-labelledby="q-title">
              <h1 id="q-title" tabIndex={-1} ref={mainHeading} style={{ fontSize: '1.25rem' }}>
                Level {attempt.level}, question {idx + 1} of {items.length}
                {current.label ? `: ${current.label}` : ''}
              </h1>
              {msg ? (
                <div role={msg.kind === 'error' ? 'alert' : 'status'} className={`alert ${msg.kind}`}>
                  {msg.text}
                </div>
              ) : null}
              <div className="panel" style={{ whiteSpace: 'pre-wrap' }}>
                {current.prompt}
              </div>

              {current.code ? (
                <pre
                  className="panel mono"
                  style={{
                    background: '#0f172a',
                    color: '#f8fafc',
                    padding: '1rem',
                    borderRadius: '0.5rem',
                    overflowX: 'auto',
                    border: '1px solid #334155',
                    fontSize: '0.9rem',
                    lineHeight: '1.4'
                  }}
                >
                  <code>{current.code}</code>
                </pre>
              ) : null}

              {(current.kind === 'single_choice' || (current.kind as string) === 'single' ||
                current.kind === 'multi_choice' || (current.kind as string) === 'multi') && current.options ? (
                <fieldset>
                  <legend>
                    {current.kind === 'multi_choice' || (current.kind as string) === 'multi'
                      ? 'Select all that apply'
                      : 'Select one answer'}
                  </legend>
                  <ul className="options">
                    {current.options.map((o) => {
                      const ans = answers[current.item_id];
                      const multi = current.kind === 'multi_choice' || (current.kind as string) === 'multi';
                      const checked = multi ? (ans as string[]).includes(o.id) : ans === o.id;
                      return (
                        <li key={o.id}>
                          <label className="option">
                            <input
                              type={multi ? 'checkbox' : 'radio'}
                              name={`q-${current.item_id}`}
                              checked={checked}
                              onChange={() =>
                                setAnswers((s) => {
                                  if (!multi) return { ...s, [current.item_id]: o.id };
                                  const cur = (s[current.item_id] as string[]) || [];
                                  return { ...s, [current.item_id]: checked ? cur.filter((x) => x !== o.id) : [...cur, o.id] };
                                })
                              }
                            />
                            <span>{o.text}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              ) : null}

              {current.kind === 'decision' && current.action_options && current.evidence_options ? (
                <div className="stack">
                  {current.scenario ? (
                    <div className="panel" aria-label="Scenario">
                      <p style={{ margin: 0 }}>{current.scenario}</p>
                    </div>
                  ) : null}
                  <fieldset>
                    <legend>Choose the action the company should take</legend>
                    <ul className="options">
                      {current.action_options.map((o) => {
                        const ans = (answers[current.item_id] as DecisionAnswer) ?? { action: '', evidence: [] };
                        return (
                          <li key={o.id}>
                            <label className="option">
                              <input
                                type="radio"
                                name={`decision-action-${current.item_id}`}
                                checked={ans.action === o.id}
                                onChange={() =>
                                  setAnswers((s) => ({
                                    ...s,
                                    [current.item_id]: { ...(s[current.item_id] as DecisionAnswer), action: o.id },
                                  }))
                                }
                              />
                              <span>{o.text}</span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>
                  <fieldset>
                    <legend>Select every piece of evidence that supports your choice</legend>
                    <ul className="options">
                      {current.evidence_options.map((o) => {
                        const ans = (answers[current.item_id] as DecisionAnswer) ?? { action: '', evidence: [] };
                        const checked = ans.evidence.includes(o.id);
                        return (
                          <li key={o.id}>
                            <label className="option">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() =>
                                  setAnswers((s) => {
                                    const prev = (s[current.item_id] as DecisionAnswer) ?? { action: '', evidence: [] };
                                    const evidence = checked ? prev.evidence.filter((x) => x !== o.id) : [...prev.evidence, o.id];
                                    return { ...s, [current.item_id]: { ...prev, evidence } };
                                  })
                                }
                              />
                              <span>{o.text}</span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>
                </div>
              ) : null}

              {current.kind === 'short_answer' || (current.kind as string) === 'short' || current.kind === 'probe' ? (
                <div className="field">
                  <label htmlFor="short">Your answer</label>
                  <textarea
                    id="short"
                    rows={4}
                    placeholder="Type your answer here..."
                    value={String(answers[current.item_id] ?? '')}
                    onChange={(e) => setAnswers((s) => ({ ...s, [current.item_id]: e.target.value }))}
                  />
                </div>
              ) : null}

              {current.kind === 'code' || (current.kind as string) === 'python' || (current.kind as string) === 'sql' ? (
                <>
                  <CodeEditor
                    id={`code-${current.item_id}`}
                    label={`${current.language === 'sql' ? 'SQL' : 'Python'} editor`}
                    language={current.language ?? 'python'}
                    value={String(answers[current.item_id] ?? '')}
                    onChange={(v) => setAnswers((s) => ({ ...s, [current.item_id]: v }))}
                  />
                  <div className="row" style={{ margin: 'var(--space-3) 0' }}>
                    <button type="button" className="btn secondary" onClick={() => void run(current)} disabled={runState === 'running'}>
                      Run tests
                    </button>
                    <span role="status" className="small muted">
                      {runState === 'running' ? 'Checking your answer. This can take up to a minute.' : ''}
                    </span>
                  </div>
                  <RunPanel result={runState} />
                  {current.requires_explanation ? (
                    <div className="field">
                      <label htmlFor="explain">Explain what was wrong and how you fixed it</label>
                      <span className="hint">Write in your own words. This is read against a rubric and is recorded.</span>
                      <textarea
                        id="explain"
                        value={explanations[current.item_id] ?? ''}
                        onChange={(e) => setExplanations((s) => ({ ...s, [current.item_id]: e.target.value }))}
                      />
                    </div>
                  ) : null}
                </>
              ) : null}

              <div className="row" style={{ marginTop: 'var(--space-4)' }}>
                <button type="button" className="btn quiet" disabled={idx === 0} onClick={() => void go(idx - 1)}>
                  Previous
                </button>
                <button type="button" className="btn secondary" onClick={() => void saveCurrent()}>
                  Save answer
                </button>
                <button
                  type="button"
                  className="btn quiet"
                  aria-pressed={!!marked[current.item_id]}
                  onClick={() => setMarked((m) => ({ ...m, [current.item_id]: !m[current.item_id] }))}
                >
                  {marked[current.item_id] ? 'Unmark for review' : 'Mark for review'}
                </button>
                {idx < items.length - 1 ? (
                  <button type="button" className="btn" onClick={() => void go(idx + 1)}>
                    Save and next
                  </button>
                ) : (
                  <button type="button" className="btn" disabled={finishing} onClick={() => setConfirmFinish(true)}>
                    Finish level
                  </button>
                )}
              </div>
            </section>
          ) : null}
        </main>

        <ProctorSidebar p={p} />
      </div>

      <FullscreenGate p={p} />
      {confirmFinish ? (
        <ConfirmDialog
          title="Finish this level?"
          confirmLabel="Finish level"
          cancelLabel="Keep working"
          onCancel={() => setConfirmFinish(false)}
          onConfirm={() => {
            setConfirmFinish(false);
            setJustifying(true);
          }}
        >
          <p>
            {unanswered > 0
              ? `${unanswered} of ${items.length} questions have no saved answer. You cannot change answers after you finish.`
              : 'All questions have a saved answer. You cannot change answers after you finish.'}
          </p>
        </ConfirmDialog>
      ) : null}
      {justifying ? (
        <JustificationStep
          attemptId={attempt.attempt_id}
          onDone={() => void finish()}
        />
      ) : null}
      {finishing ? (
        <div className="lock-screen" role="status">
          <div className="lock-card">Sending your recording and answers. Please keep this page open.</div>
        </div>
      ) : null}
    </div>
  );
}

const STATUS_TEXT: Record<RunResult['status'], string> = {
  passed: 'All checks passed.',
  failed_tests: 'Some checks did not pass.',
  error: 'Your code raised an error.',
  blocked: 'Your code used something that is not allowed here.',
  timeout: 'Your code took too long to run.',
  runner_unavailable: 'The checker is not available right now. Your work is saved. Try again.',
};

const JUSTIFY_MAX_S = 90;

/** End-of-level voice justification: records a short clip of the learner explaining their
 * approach, uploaded as one chunk under the "justification" stream. Reuses the already-granted
 * camera+mic stream (capture.camera) - no new permission prompt. Never blocks submission: a
 * recording failure or "Skip" both fall through to finish(). */
function JustificationStep({ attemptId, onDone }: { attemptId: string; onDone: () => void }) {
  const [state, setState] = useState<'idle' | 'recording' | 'uploading' | 'error'>('idle');
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<number | null>(null);

  const stopTimer = () => {
    if (timerRef.current != null) window.clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const start = () => {
    const stream = capture.camera;
    if (!stream || typeof MediaRecorder === 'undefined') {
      setState('error');
      return;
    }
    chunksRef.current = [];
    const mime = ['video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    rec.onstop = () => void upload();
    recorderRef.current = rec;
    rec.start();
    setState('recording');
    setSeconds(0);
    timerRef.current = window.setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= JUSTIFY_MAX_S) stop();
        return s + 1;
      });
    }, 1000);
  };

  const stop = () => {
    stopTimer();
    try {
      recorderRef.current?.stop();
    } catch {
      /* already stopped */
    }
  };

  const upload = async () => {
    setState('uploading');
    try {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' });
      if (blob.size > 0) await api.chunk(attemptId, 'justification', 0, blob);
    } catch {
      /* best-effort: a failed upload never blocks the level from finishing */
    }
    onDone();
  };

  useEffect(() => () => stopTimer(), []);

  return (
    <div className="dialog-backdrop" role="alertdialog" aria-labelledby="justify-h">
      <div className="dialog">
        <h2 id="justify-h">Explain your approach</h2>
        <p className="muted small">
          Record up to {JUSTIFY_MAX_S} seconds: in your own words, explain and defend your solution. This is optional
          and does not change your result.
        </p>
        {state === 'error' ? <Alert kind="warning">Recording is not available. You can still finish the level.</Alert> : null}
        {state === 'recording' ? (
          <p role="status">
            <span className="rec-dot" aria-hidden="true" /> Recording — {seconds}s / {JUSTIFY_MAX_S}s
          </p>
        ) : null}
        {state === 'uploading' ? <p role="status">Saving your recording…</p> : null}
        <div className="row" style={{ marginTop: 'var(--space-4)' }}>
          {state === 'idle' ? (
            <button type="button" className="btn" onClick={start}>
              Start recording
            </button>
          ) : null}
          {state === 'recording' ? (
            <button type="button" className="btn" onClick={stop}>
              Stop and submit
            </button>
          ) : null}
          <button type="button" className="btn quiet" disabled={state === 'uploading'} onClick={() => onDone()}>
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}

function RunPanel({ result }: { result: RunResult | 'running' | 'error' | undefined }) {
  if (!result || result === 'running') return null;
  if (result === 'error') return <Alert kind="error">The check did not run. Your code is still in the box. Try again.</Alert>;
  const passedCount = result.tests.filter((t) => t.passed).length;
  return (
    <section className="panel" aria-label="Test results">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ fontSize: '1rem', margin: 0 }}>{STATUS_TEXT[result.status]}</h2>
        {result.tests.length > 0 ? (
          <span className={`chip ${result.status === 'passed' ? 'success' : 'error'}`}>
            {passedCount} / {result.tests.length} passed
          </span>
        ) : null}
      </div>
      {result.tests.length > 0 ? (
        <ol className="test-case-grid" aria-label="Test cases">
          {result.tests.map((t, i) => (
            <li key={t.id} className="test-case" data-passed={t.passed}>
              <span className="test-case-badge" aria-hidden="true">
                {t.passed ? '✓' : '×'}
              </span>
              <span className="test-case-body">
                <span className="test-case-title">
                  Case {i + 1} <span className="sr-only">: {t.id}</span>
                  <span className="muted small"> — {t.passed ? 'Passed' : 'Not passed'}</span>
                </span>
                {t.message_safe ? <span className="test-case-msg">{t.message_safe}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {result.diff && result.diff.lines.length > 0 ? (
        <div>
          <h3>{result.diff.kind === 'rows' ? 'Row differences' : 'Line differences'}</h3>
          <div className="diff" role="group" aria-label="Difference between your output and the expected output">
            {result.diff.lines.map((l, i) => (
              <div key={i} className={l.kind}>
                <span aria-hidden="true">{l.kind === 'added' ? '+ ' : l.kind === 'removed' ? '- ' : '  '}</span>
                <span className="sr-only">{l.kind === 'added' ? 'Extra: ' : l.kind === 'removed' ? 'Missing: ' : 'Same: '}</span>
                {l.text}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {result.stdout_trunc ? (
        <div>
          <h3>Output</h3>
          <pre className="mono small" style={{ whiteSpace: 'pre-wrap' }}>
            {result.stdout_trunc}
          </pre>
        </div>
      ) : null}
    </section>
  );
}
