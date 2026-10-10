import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fetchPrecheckPayload, postPrecheckEcho } from '../api/client';
import type { Level, Track } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Alert, Field, PageHeading } from '../components/ui';
import { capture } from '../recording/session';
import { DEFAULT_THRESHOLDS, evaluatePrecheck, isChromium, type Thresholds } from '../lib/precheck';
import { measureNetwork, type NetworkMeasurement, type SpeedProgress } from '../lib/speedtest';
import { LEVEL_INFO } from './Path';

const STEPS = ['Confirm', 'Consent', 'Network', 'Camera and mic', 'Screen', 'Full screen', 'Rules and start'] as const;
export const CONSENT_VERSION = '2026-10-v1';
const SCOPES = ['camera_microphone', 'screen', 'integrity_events'];

export function LobbyPage() {
  const { level: levelParam } = useParams();
  const level = Number(levelParam) as Level;
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);

  const [step, setStep] = useState(0);
  const queryTrack = typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('track') as Track | null) : null;
  const [track, setTrack] = useState<Track | ''>(queryTrack || me?.track || '');
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [consentRequired, setConsentRequired] = useState(true);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [net, setNet] = useState<NetworkMeasurement | null>(null);
  const [netProgress, setNetProgress] = useState<SpeedProgress | null>(null);
  const [netState, setNetState] = useState<'idle' | 'running' | 'error'>('idle');
  const [cam, setCam] = useState(false);
  const [mic, setMic] = useState(false);
  const [surface, setSurface] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [thresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const previewRef = useRef<HTMLVideoElement>(null);

  const valid = level >= 1 && level <= 4;
  const singleDisplay = (() => {
    const s = window.screen as Screen & { isExtended?: boolean };
    return typeof s.isExtended === 'boolean' ? !s.isExtended : null;
  })();
  const evalResult = evaluatePrecheck(
    {
      downMbps: net?.downMbps ?? null,
      upMbps: net?.upMbps ?? null,
      latencyMs: net?.latencyMs ?? null,
      camera: cam,
      mic,
      screenSurface: surface,
      fullscreen,
      singleDisplay,
      chromium: isChromium(navigator.userAgent),
    },
    thresholds,
  );

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  useEffect(() => {
    if (previewRef.current && capture.camera) previewRef.current.srcObject = capture.camera;
  });

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const fail = (m: string) => setError(m);

  const confirmIdentity = async () => {
    setBusy(true);
    setError(null);
    try {
      if (track && track !== me?.track) {
        await api.setTrack(track);
        await refresh();
      }
      const a = await api.createAttempt(level);
      setAttemptId(a.attempt_id);
      setConsentRequired(a.consent_required);
      setStep(a.consent_required ? 1 : 2);
    } catch {
      fail('We could not start this level. Your work is saved. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const giveConsent = async () => {
    if (!attemptId) return;
    setBusy(true);
    setError(null);
    try {
      await api.consent(attemptId, { version: CONSENT_VERSION, scopes: SCOPES });
      setStep(2);
    } catch {
      fail('Your consent was not saved. Nothing has been recorded. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const runNetwork = useCallback(async () => {
    setNetState('running');
    setNet(null);
    setError(null);
    try {
      const m = await measureNetwork({
        now: () => performance.now(),
        download: (size) => fetchPrecheckPayload(size),
        upload: (bytes) => postPrecheckEcho(new Blob([new Uint8Array(bytes)])),
        onProgress: setNetProgress,
      });
      setNet(m);
      setNetState('idle');
    } catch {
      setNetState('error');
    }
  }, []);

  const getCamera = async () => {
    setError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      capture.camera?.getTracks().forEach((t) => t.stop());
      capture.setStreams(s, capture.screen);
      setCam(s.getVideoTracks().some((t) => t.readyState === 'live'));
      setMic(s.getAudioTracks().some((t) => t.readyState === 'live'));
    } catch {
      setCam(false);
      setMic(false);
      fail('We could not use your camera and microphone. Allow access in the browser address bar, then try again.');
    }
  };

  const getScreen = async () => {
    setError(null);
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'monitor' } as MediaTrackConstraints, audio: false });
      capture.screen?.getTracks().forEach((t) => t.stop());
      capture.setStreams(capture.camera, s);
      const st = capture.screenSurface;
      setSurface(st);
      if (st !== 'monitor') {
        s.getTracks().forEach((t) => t.stop());
        capture.setStreams(capture.camera, null);
        fail('Please share your entire screen, not a window or a tab. Choose "Entire screen" in the picker.');
      }
    } catch {
      setSurface(null);
      fail('Screen sharing was not started. Select "Share screen" and choose your entire screen.');
    }
  };

  const goFullscreen = async () => {
    setError(null);
    try {
      await document.documentElement.requestFullscreen();
      setFullscreen(true);
    } catch {
      fail('Full screen was not allowed. Try again and allow full screen if the browser asks.');
    }
  };

  const start = async () => {
    if (!attemptId || !evalResult.allPassed) return;
    setBusy(true);
    setError(null);
    try {
      await api.precheckReport({
        down_mbps: net?.downMbps ?? 0,
        up_mbps: net?.upMbps ?? 0,
        latency_ms: net?.latencyMs ?? 0,
        camera: cam,
        mic,
        screen_surface: surface ?? 'unknown',
        fullscreen,
        single_display: singleDisplay,
        browser: navigator.userAgent.slice(0, 200),
      });
      await api.start(attemptId);
      nav(level === 4 ? `/interview/${attemptId}` : `/exam/${attemptId}`, { state: { level } });
    } catch {
      fail('We could not start the level. Your work is saved. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!valid) {
    return (
      <div className="container">
        <PageHeading>Level not found</PageHeading>
        <Link to="/path">Back to My path</Link>
      </div>
    );
  }

  const gaugePct = netProgress?.mbps !== undefined ? Math.min(100, (netProgress.mbps / 50) * 100) : netState === 'running' ? 15 : net ? Math.min(100, (net.downMbps / 50) * 100) : 0;

  return (
    <div className="container narrow" style={{ maxWidth: 760 }}>
      <p className="brand">Crucible</p>
      <ol className="wizard-steps" aria-label="Check-in steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined} data-done={i < step}>
            {s}
            <span className="sr-only">{i < step ? ' (done)' : i === step ? ' (current)' : ''}</span>
          </li>
        ))}
      </ol>
      <main id="main">
        <h1 tabIndex={-1} ref={heading}>
          {step === 0 && `Level ${level}: ${LEVEL_INFO[level].name}`}
          {step === 1 && 'Your consent'}
          {step === 2 && 'Check your connection'}
          {step === 3 && 'Check your camera and microphone'}
          {step === 4 && 'Share your entire screen'}
          {step === 5 && 'Enter full screen'}
          {step === 6 && 'Rules, then start'}
        </h1>
        {error ? <Alert kind="error">{error}</Alert> : null}

        {step === 0 && (
          <section aria-labelledby="who">
            <h2 id="who" className="sr-only">
              Confirm who you are and your track
            </h2>
            <p>{LEVEL_INFO[level].blurb}</p>
            <div className="panel">
              <p style={{ margin: 0 }}>
                You are signed in as <strong className="mono">{me?.alias ?? me?.display_name ?? 'learner'}</strong>.
              </p>
            </div>
            <Field id="track" label="Your track" hint="This is a preference. You can change it before you start.">
              {(p) => (
                <select {...p} value={track} onChange={(e) => setTrack(e.target.value as Track)}>
                  <option value="" disabled>
                    Choose a track
                  </option>
                  <option value="python">Python developer</option>
                  <option value="data_analyst">Data analyst</option>
                </select>
              )}
            </Field>
            <div className="row">
              <Link className="btn quiet" to="/path">
                Back to My path
              </Link>
              <button type="button" className="btn" disabled={!track || busy} onClick={() => void confirmIdentity()}>
                Continue
              </button>
            </div>
          </section>
        )}

        {step === 1 && consentRequired && (
          <section>
            <p>
              To run this level as a monitored exam we need your permission to record. Here is exactly what is captured
              and why.
            </p>
            <ul>
              <li>Your camera and microphone, so a reviewer can see that you are working on your own.</li>
              <li>Your entire screen, so a reviewer can see the work and anything else on your display.</li>
              <li>
                Events such as leaving the window, leaving full screen, copying and pasting. These are shown only to
                human reviewers and never change a result by themselves.
              </li>
            </ul>
            <p>
              Recordings are kept for a limited time and can be seen only by authorised reviewers. If you decline, you
              will not start this level and nothing will be recorded.
            </p>
            <div className="panel" style={{ marginTop: '1rem', marginBottom: '1rem', borderLeft: '4px solid #6366f1', background: 'rgba(99, 102, 241, 0.08)' }}>
              <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem', fontWeight: 600, color: '#f8fafc' }}>
                ⚠️ System Requirement: Switch ON all permissions
              </h3>
              <p style={{ margin: '0 0 0.75rem', fontSize: '0.9rem', color: '#cbd5e1' }}>
                This proctored assessment requires you to switch on and allow all system permissions in your browser:
              </p>
              <ul className="checklist" style={{ marginBottom: 0 }}>
                <li>
                  <span aria-hidden="true">📷</span>
                  <span><strong>Camera & Microphone:</strong> Switch ON access in browser address bar when requested.</span>
                </li>
                <li>
                  <span aria-hidden="true">🖥️</span>
                  <span><strong>Entire Screen Share:</strong> Switch ON full monitor sharing (select "Entire screen" in picker).</span>
                </li>
                <li>
                  <span aria-hidden="true">⛶</span>
                  <span><strong>Full Screen Mode:</strong> Keep exam maximized with active focus throughout the session.</span>
                </li>
              </ul>
            </div>
            <div className="check-row">
              <input id="agree" type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <label htmlFor="agree">I understand and I agree to be recorded, and will switch on all required device permissions.</label>
            </div>
            <div className="row">
              <Link className="btn quiet" to="/path">
                Decline and go back
              </Link>
              <button type="button" className="btn" disabled={!agreed || busy} onClick={() => void giveConsent()}>
                Agree and continue
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section>
            <p>We measure your download speed, upload speed and delay. This takes a few seconds.</p>
            <div className="gauge" role="status" aria-live="polite">
              <div className="gauge-bar" aria-hidden="true">
                <div className="gauge-fill" style={{ width: `${gaugePct}%` }} />
              </div>
              <p className="small">
                {netState === 'running'
                  ? `Testing: ${netProgress?.phase ?? 'starting'}${netProgress?.mbps !== undefined ? `, ${netProgress.mbps.toFixed(1)} Mbps` : ''}`
                  : net
                    ? `Download ${net.downMbps.toFixed(1)} Mbps, upload ${net.upMbps.toFixed(1)} Mbps, delay ${Math.round(net.latencyMs)} ms`
                    : netState === 'error'
                      ? 'The test could not run. Check your connection and try again.'
                      : 'Not tested yet.'}
              </p>
            </div>
            {net ? (
              evalResult.checks.find((c) => c.id === 'network')?.ok ? (
                <Alert kind="success">Your connection is good for this exam.</Alert>
              ) : (
                <Alert kind="warning">{evalResult.checks.find((c) => c.id === 'network')?.reason}</Alert>
              )
            ) : null}
            <div className="row">
              <button type="button" className="btn secondary" disabled={netState === 'running'} onClick={() => void runNetwork()}>
                {net || netState === 'error' ? 'Test again' : 'Start test'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!evalResult.checks.find((c) => c.id === 'network')?.ok}
                onClick={() => setStep(3)}
              >
                Continue
              </button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section>
            <p>Allow camera and microphone access. You should see yourself below.</p>
            <video ref={previewRef} className="preview" autoPlay muted playsInline aria-label="Your camera preview" />
            <ul className="checklist">
              <li>
                <span aria-hidden="true">{cam ? '✓' : '○'}</span> Camera: {cam ? 'working' : 'not checked'}
              </li>
              <li>
                <span aria-hidden="true">{mic ? '✓' : '○'}</span> Microphone: {mic ? 'working' : 'not checked'}
              </li>
            </ul>
            <div className="row">
              <button type="button" className="btn secondary" onClick={() => void getCamera()}>
                {cam ? 'Check again' : 'Allow camera and microphone'}
              </button>
              <button type="button" className="btn" disabled={!cam || !mic} onClick={() => setStep(4)}>
                Continue
              </button>
            </div>
          </section>
        )}

        {step === 4 && (
          <section>
            <p>
              Choose <strong>Entire screen</strong> in the browser picker. Sharing a window or a tab will not work.
            </p>
            <ul className="checklist">
              <li>
                <span aria-hidden="true">{surface === 'monitor' ? '✓' : '○'}</span> Entire screen:{' '}
                {surface === 'monitor' ? 'shared' : 'not shared'}
              </li>
              <li>
                <span aria-hidden="true">{singleDisplay === false ? '×' : '✓'}</span> Display:{' '}
                {singleDisplay === false
                  ? 'more than one display detected. Disconnect the extra display.'
                  : 'one display'}
              </li>
            </ul>
            <div className="row">
              <button type="button" className="btn secondary" onClick={() => void getScreen()}>
                {surface === 'monitor' ? 'Share again' : 'Share entire screen'}
              </button>
              <button type="button" className="btn" disabled={surface !== 'monitor' || singleDisplay === false} onClick={() => setStep(5)}>
                Continue
              </button>
            </div>
          </section>
        )}

        {step === 5 && (
          <section>
            <p>The exam runs in full screen. If you leave full screen, we pause the page until you return.</p>
            <p aria-live="polite">
              <span aria-hidden="true">{fullscreen ? '✓' : '○'}</span> Full screen: {fullscreen ? 'on' : 'off'}
            </p>
            <div className="row">
              <button type="button" className="btn secondary" onClick={() => void goFullscreen()}>
                Enter full screen
              </button>
              <button type="button" className="btn" disabled={!fullscreen} onClick={() => setStep(6)}>
                Continue
              </button>
            </div>
          </section>
        )}

        {step === 6 && (
          <section>
            <h2>Before you begin</h2>
            <ul>
              <li>Work on your own. Keep the exam window in front and stay in full screen.</li>
              <li>Your camera, microphone and screen are recorded for the whole level.</li>
              <li>There are no timers shown. Take the time you need, and answer in your own words.</li>
              <li>If something looks unusual, a person reviews the full context. Nothing is decided automatically.</li>
              {level === 4 ? <li>Level 4 is a spoken conversation. You can always type your answer instead.</li> : null}
            </ul>
            <h2>Checks</h2>
            <ul className="checklist">
              {evalResult.checks.map((c) => (
                <li key={c.id}>
                  <span aria-hidden="true">{c.ok ? '✓' : '×'}</span>
                  <span>
                    {c.label}: {c.ok ? 'ready' : c.reason}
                  </span>
                </li>
              ))}
            </ul>
            <div className="row">
              <button type="button" className="btn" disabled={!evalResult.allPassed || busy} onClick={() => void start()}>
                Start Level {level}
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
