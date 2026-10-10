import type { IntegrityEvent, IntegrityEventType } from '../api/types';

export interface DetectorOptions {
  emit: (e: IntegrityEvent) => void;
  getItemId: () => string | null;
  cameraStream?: MediaStream | null;
  screenStream?: MediaStream | null;
  faceVideo?: () => HTMLVideoElement | null;
  /** exposed for tests */
  now?: () => number;
  doc?: Document;
  win?: Window;
}

interface FaceDetectorLike {
  detect(v: HTMLVideoElement): Promise<unknown[]>;
}

/** Attaches browser listeners that produce integrity events. Returns a cleanup function. */
export function attachDetectors(o: DetectorOptions): () => void {
  const doc = o.doc ?? document;
  const win = o.win ?? window;
  const now = o.now ?? (() => performance.now());
  const cleanups: Array<() => void> = [];

  const fire = (type: IntegrityEventType) =>
    o.emit({ type, t_ms: Math.round(now()), at: new Date().toISOString(), item_id: o.getItemId() });

  const on = <K extends string>(target: EventTarget, name: K, type: IntegrityEventType, cond?: () => boolean) => {
    const h = () => {
      if (!cond || cond()) fire(type);
    };
    target.addEventListener(name, h);
    cleanups.push(() => target.removeEventListener(name, h));
  };

  on(win, 'blur', 'focus_loss');
  on(doc, 'visibilitychange', 'tab_hidden', () => doc.visibilityState === 'hidden');
  on(doc, 'fullscreenchange', 'fullscreen_exit', () => !doc.fullscreenElement);
  on(doc, 'paste', 'paste');
  on(doc, 'copy', 'copy');
  on(doc, 'cut', 'copy');
  on(doc, 'contextmenu', 'context_menu');
  on(win, 'offline', 'network_drop');

  // developer tools heuristic: large gap between outer and inner window size outside fullscreen
  let devtoolsOpen = false;
  const dt = setInterval(() => {
    if (doc.fullscreenElement) return;
    const gap = win.outerWidth - win.innerWidth > 200 || win.outerHeight - win.innerHeight > 300;
    if (gap && !devtoolsOpen) fire('devtools_heuristic');
    devtoolsOpen = gap;
  }, 2000);
  cleanups.push(() => clearInterval(dt));

  // multiple displays
  const scr = win.screen as unknown as EventTarget & { isExtended?: boolean };
  if (scr && typeof scr.isExtended === 'boolean') {
    let extended = scr.isExtended;
    const h = () => {
      const now2 = scr.isExtended === true;
      if (now2 && !extended) fire('multi_display');
      extended = now2;
    };
    scr.addEventListener('change', h);
    cleanups.push(() => scr.removeEventListener('change', h));
  }

  // media tracks ending
  o.cameraStream?.getTracks().forEach((t) => {
    const h = () => fire('camera_lost');
    t.addEventListener('ended', h);
    cleanups.push(() => t.removeEventListener('ended', h));
  });
  o.screenStream?.getVideoTracks().forEach((t) => {
    const h = () => fire('screen_share_ended');
    t.addEventListener('ended', h);
    cleanups.push(() => t.removeEventListener('ended', h));
  });

  // face presence and count, only where FaceDetector exists. maxDetectedFaces is raised to 2
  // so the browser API can actually observe a second face; this never auto-penalizes, same
  // as every other integrity signal here - it only surfaces a neutral flag for human review.
  const FD = (win as unknown as { FaceDetector?: new (o?: object) => FaceDetectorLike }).FaceDetector;
  if (FD && o.faceVideo) {
    const detector = new FD({ fastMode: true, maxDetectedFaces: 2 });
    let absentMisses = 0;
    let absentReported = false;
    let multiHits = 0;
    let multiReported = false;
    const fi = setInterval(async () => {
      const v = o.faceVideo?.();
      if (!v || v.readyState < 2) return;
      try {
        const faces = await detector.detect(v);
        if (faces.length === 0) {
          absentMisses++;
          multiHits = 0;
          if (absentMisses >= 3 && !absentReported) {
            absentReported = true;
            fire('face_absent');
          }
        } else if (faces.length > 1) {
          multiHits++;
          absentMisses = 0;
          absentReported = false;
          if (multiHits >= 3 && !multiReported) {
            multiReported = true;
            fire('multiple_faces');
          }
        } else {
          absentMisses = 0;
          absentReported = false;
          multiHits = 0;
          multiReported = false;
        }
      } catch {
        /* detector unavailable at runtime: stay silent */
      }
    }, 2000);
    cleanups.push(() => clearInterval(fi));
  }

  return () => cleanups.forEach((c) => c());
}
