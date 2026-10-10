import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { InterviewPrompt, InterviewTurnResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Alert, ErrorPanel, Loading, useAsync } from '../components/ui';
import { ExamTopBar, FullscreenGate, ProctorSidebar } from '../components/ProctorChrome';
import { useProctoring } from '../integrity/useProctoring';
import { capture } from '../recording/session';

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => RecognitionLike;

function getRecognition(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

type Turn = { who: 'interviewer' | 'you'; text: string };

export function InterviewPage() {
  const { attemptId = '' } = useParams();
  const a = useAsync(() => api.attempt(attemptId), [attemptId]);
  if (a.loading) {
    return (
      <div className="container">
        <Loading label="Loading your session" />
      </div>
    );
  }
  if (a.error || !a.data) {
    return (
      <div className="container">
        <ErrorPanel error={a.error} onRetry={a.reload} what="this session" />
      </div>
    );
  }
  if (!capture.camera) {
    return (
      <main id="main" className="container narrow">
        <h1>Check in again to continue</h1>
        <p>The camera and screen connection was closed. Your answers so far are saved. Complete the quick check-in to continue.</p>
        <Link className="btn" to="/lobby/4">
          Go to check-in
        </Link>
      </main>
    );
  }
  return <InterviewRunner attemptId={attemptId} initial={a.data.current_prompt ?? null} />;
}

function InterviewRunner({ attemptId, initial }: { attemptId: string; initial: InterviewPrompt | null }) {
  const nav = useNavigate();
  const { me } = useAuth();
  const progress = useAsync(() => api.progress());
  const p = useProctoring(attemptId, () => 'interview');
  const [prompt, setPrompt] = useState<InterviewPrompt | null>(initial);
  const [turns, setTurns] = useState<Turn[]>(initial ? [{ who: 'interviewer', text: initial.text }] : []);
  const [answer, setAnswer] = useState('');
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState<string | null>(null);
  const [summary, setSummary] = useState<InterviewTurnResponse['summary']>(null);
  const [readAloud, setReadAloud] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const recRef = useRef<RecognitionLike | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const Recognition = getRecognition();

  useEffect(() => {
    if (!p.fsLocked) heading.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.index]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    if (readAloud && prompt && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(prompt.text));
    }
    return () => {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    };
  }, [readAloud, prompt]);

  const toggleListen = () => {
    if (!Recognition) return;
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const r = new Recognition();
    r.lang = navigator.language || 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let finalText = '';
      let tmp = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res[0].transcript;
        if (res.isFinal) finalText += t;
        else tmp += t;
      }
      if (finalText) setAnswer((a) => (a ? `${a} ${finalText.trim()}` : finalText.trim()));
      setInterim(tmp);
    };
    r.onerror = () => {
      setListening(false);
      setError('Speech to text stopped. You can keep typing your answer.');
    };
    r.onend = () => {
      setListening(false);
      setInterim('');
    };
    recRef.current = r;
    r.start();
    setListening(true);
  };

  const send = async () => {
    if (!answer.trim() || sending) return;
    recRef.current?.stop();
    setSending(true);
    setError(null);
    try {
      const res = await api.interviewTurn(attemptId, answer.trim());
      setTurns((t) => {
        const next: Turn[] = [...t, { who: 'you', text: answer.trim() }];
        if (res.acknowledgement) next.push({ who: 'interviewer', text: res.acknowledgement });
        if (res.prompt) next.push({ who: 'interviewer', text: res.prompt.text });
        return next;
      });
      setAnswer('');
      setAck(res.acknowledgement ?? null);
      if (res.done || res.summary) {
        setSummary(res.summary ?? { criteria: [], outcome: 'in_review', ai_disclosure: true });
        setPrompt(null);
      } else {
        setPrompt(res.prompt ?? null);
      }
    } catch {
      setError('Your answer was not sent. It is still in the box. Try again.');
    } finally {
      setSending(false);
    }
  };

  const leave = async () => {
    setFinishing(true);
    try {
      await p.finish();
      await api.finish(attemptId);
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      capture.release();
      nav(`/result/${attemptId}`, { replace: true });
    } catch {
      setError('We could not finish the session. Your answers are saved. Try again.');
      setFinishing(false);
    }
  };

  return (
    <div className="exam">
      <a className="skip-link" href="#exam-main">
        Skip to the conversation
      </a>
      <ExamTopBar alias={me?.alias ?? 'candidate'} level={4} levels={progress.data?.levels ?? []} p={p} />
      <div className="exam-body">
        <nav className="exam-nav" aria-label="Session">
          <h2 style={{ fontSize: '1rem' }}>Prompts</h2>
          <ol className="qnav">
            {Array.from({ length: prompt?.total ?? (summary ? turns.filter((t) => t.who === 'you').length : 5) }).map((_, i) => (
              <li key={i}>
                <span className="chip" aria-current={prompt && prompt.index === i + 1 ? 'step' : undefined}>
                  Prompt {i + 1}
                  <span className="sr-only">
                    {prompt && prompt.index === i + 1 ? ' (current)' : prompt && prompt.index > i + 1 ? ' (answered)' : summary ? ' (answered)' : ''}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </nav>
        <main id="exam-main" className="exam-main">
          <h1 tabIndex={-1} ref={heading} style={{ fontSize: '1.25rem' }}>
            {summary ? 'Level 4 conversation finished' : `Level 4: prompt ${prompt?.index ?? 1} of ${prompt?.total ?? 5}`}
          </h1>
          {error ? <Alert kind="error">{error}</Alert> : null}
          {prompt?.scripted ? <p className="chip">Scripted follow-up</p> : <p className="chip">AI-assisted interviewer</p>}

          <div className="grid-2">
            <div className="panel" aria-label="Interviewer">
              <p className="small muted" style={{ margin: 0 }}>
                Interviewer
              </p>
              <p style={{ fontSize: '1.125rem', margin: 'var(--space-2) 0 0' }}>{prompt ? prompt.text : 'Thank you. That was the last prompt.'}</p>
            </div>
          </div>

          <section aria-label="Conversation transcript" className="stack">
            <h2 style={{ fontSize: '1rem' }}>Transcript and captions</h2>
            <div role="log" aria-live="polite" className="captions">
              {turns.map((t, i) => (
                <div key={i} className={`bubble ${t.who}`}>
                  <strong>{t.who === 'you' ? 'You' : 'Interviewer'}:</strong> {t.text}
                </div>
              ))}
              {interim ? <p className="muted small">Hearing: {interim}</p> : null}
            </div>
          </section>

          {summary ? (
            <section className="panel" aria-label="Session summary">
              <h2>Summary</h2>
              <p>
                {summary.outcome === 'in_review'
                  ? 'Evaluated. A person will review this session.'
                  : summary.outcome === 'passed'
                    ? 'Evaluated. This level is passed.'
                    : 'Evaluated. This level is not passed this time. You can try again with new prompts.'}
              </p>
              {summary.ai_disclosure ? <p className="chip">AI-assisted evaluation. You can appeal any result.</p> : null}
              {summary.criteria.length > 0 ? (
                <ul>
                  {summary.criteria.map((c) => (
                    <li key={c.criterion}>
                      <strong>{c.criterion}</strong>
                      {c.rationale ? `: ${c.rationale}` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
              <button type="button" className="btn" disabled={finishing} onClick={() => void leave()}>
                {finishing ? 'Sending your recording' : 'Finish session'}
              </button>
            </section>
          ) : (
            <section aria-label="Reply area" style={{ marginTop: 'var(--space-4)' }}>
              {ack ? (
                <p className="muted small" role="status">
                  {ack}
                </p>
              ) : null}
              <div className="field">
                <label htmlFor="ans">Your answer</label>
                <span className="hint">
                  {Recognition
                    ? 'Speak with the microphone button, or type. You can edit the text before you send it.'
                    : 'Speech to text is not available in this browser. Type your answer.'}
                </span>
                <textarea id="ans" value={answer} onChange={(e) => setAnswer(e.target.value)} disabled={sending} />
              </div>
              <div className="row">
                {Recognition ? (
                  <button type="button" className="btn secondary" aria-pressed={listening} onClick={toggleListen}>
                    {listening ? 'Stop listening' : 'Speak your answer'}
                  </button>
                ) : null}
                <button type="button" className="btn" disabled={!answer.trim() || sending} onClick={() => void send()}>
                  {sending ? 'Sending' : 'Send answer'}
                </button>
                <label className="check-row small">
                  <input type="checkbox" checked={readAloud} onChange={(e) => setReadAloud(e.target.checked)} />
                  <span>Read prompts aloud</span>
                </label>
              </div>
              <p className="small muted">There is no time limit. You can answer when you are ready.</p>
            </section>
          )}
        </main>
        <ProctorSidebar p={p} />
      </div>
      <FullscreenGate p={p} />
    </div>
  );
}
