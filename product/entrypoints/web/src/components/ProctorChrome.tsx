import { useEffect, useRef } from 'react';
import type { Level, LevelProgress } from '../api/types';
import { FLAGGED_MESSAGE } from '../integrity/policy';
import type { Proctoring } from '../integrity/useProctoring';

function fmtRemaining(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function ExamTopBar({
  alias,
  level,
  levels,
  p,
  remainingSec,
}: {
  alias: string;
  level: Level;
  levels: LevelProgress[];
  p: Proctoring;
  remainingSec?: number | null;
}) {
  const conn = !p.online ? 'Offline. Your answers are kept.' : p.upload.stalled ? 'Reconnecting. Recording will catch up.' : 'Connected';
  return (
    <header className="exam-top">
      <div className="row">
        <span className="brand">Crucible</span>
        <span className="muted small">
          Candidate <span className="mono">{alias}</span>
        </span>
        {remainingSec != null ? (
          <span className={`chip ${remainingSec <= 120 ? 'warning' : ''}`} role="timer" aria-live="polite">
            <span aria-hidden="true">⏱</span> {fmtRemaining(remainingSec)} left
          </span>
        ) : null}
      </div>
      <nav aria-label="Level progress">
        <ol className="level-steps">
          {[1, 2, 3, 4].map((n) => {
            const st = levels.find((l) => l.level === n)?.status ?? 'locked';
            const label = st === 'passed' ? 'passed' : n === level ? 'current' : st === 'locked' ? 'locked' : 'not started';
            return (
              <li key={n} aria-current={n === level ? 'step' : undefined} data-status={st}>
                L{n} <span className="sr-only">{label}</span>
                <span aria-hidden="true">{st === 'passed' ? ' ✓' : ''}</span>
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="row">
        <span className="chip" role="status">
          <span className="rec-dot" aria-hidden="true" style={{ opacity: p.recording ? 1 : 0.3 }} />
          {p.recording ? 'Recording camera, microphone and screen' : 'Recording not active'}
        </span>
        <span className={`chip ${p.online && !p.upload.stalled ? 'success' : 'warning'}`} role="status">
          <span aria-hidden="true">{p.online && !p.upload.stalled ? '●' : '○'}</span> {conn}
        </span>
      </div>
    </header>
  );
}

export function FullscreenGate({ p }: { p: Proctoring }) {
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (p.fsLocked) btn.current?.focus();
  }, [p.fsLocked]);
  if (!p.fsLocked) return null;
  return (
    <div className="lock-screen">
      <div className="lock-card" role="alertdialog" aria-modal="true" aria-labelledby="fs-title" aria-describedby="fs-desc">
        <h2 id="fs-title">Return to full screen</h2>
        <p id="fs-desc">
          The exam runs in full screen. Your work is saved. Select the button to continue where you left off.
        </p>
        <button ref={btn} type="button" className="btn" onClick={() => void p.returnToFullscreen()}>
          Return to full screen
        </button>
      </div>
    </div>
  );
}

export function ProctorSidebar({ p }: { p: Proctoring }) {
  return (
    <aside className="exam-context" aria-label="Session information">
      <h2 className="small" style={{ fontSize: '1rem' }}>
        Your camera
      </h2>
      <video ref={p.videoRef} className="self-view" autoPlay muted playsInline aria-label="Your camera preview" />
      {!p.cameraOk ? (
        <p className="small" role="alert">
          Your camera stopped sending video. Please check the camera and allow access again.
        </p>
      ) : null}
      <h2 style={{ fontSize: '1rem', marginTop: 'var(--space-4)' }}>Session notes</h2>
      <div role="status" aria-live="polite" aria-atomic="false">
        {p.flagged ? (
          <p className="chip warning" style={{ borderRadius: 'var(--radius)' }}>
            <span aria-hidden="true">{'⚑'}</span> {FLAGGED_MESSAGE}
          </p>
        ) : null}
        {p.notices.length === 0 && !p.flagged ? <p className="small muted">Nothing to note.</p> : null}
        <ul className="small" style={{ paddingLeft: 'var(--space-4)' }}>
          {p.notices.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </div>
      <p className="small muted">There is no time limit shown here. You can take the time you need.</p>
    </aside>
  );
}
