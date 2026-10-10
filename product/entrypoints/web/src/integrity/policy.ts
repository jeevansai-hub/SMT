import type { IntegrityEventType } from '../api/types';

export const ALL_EVENT_TYPES: IntegrityEventType[] = [
  'focus_loss',
  'tab_hidden',
  'fullscreen_exit',
  'paste',
  'copy',
  'context_menu',
  'devtools_heuristic',
  'multi_display',
  'camera_lost',
  'screen_share_ended',
  'network_drop',
  'face_absent',
  'multiple_faces',
];

/** Neutral, factual, action-oriented. Never accusatory (build-brief section 4; ux-flows G-5/4.7). */
const NOTICES: Record<IntegrityEventType, string> = {
  focus_loss: 'This window lost focus. Please keep the exam window in front.',
  tab_hidden: 'The exam tab was hidden. Please keep the exam tab visible.',
  fullscreen_exit: 'Full screen was closed. Select "Return to full screen" to continue.',
  paste: 'A paste action was recorded. Pasting is allowed, and it is noted for the reviewer.',
  copy: 'A copy action was recorded. It is noted for the reviewer.',
  context_menu: 'The context menu was opened. This is noted for the reviewer.',
  devtools_heuristic: 'The window size changed in a way that can mean developer tools are open. Please close them.',
  multi_display: 'More than one display was detected. Please use a single display.',
  camera_lost: 'Your camera stopped sending video. Please check the camera and allow access again.',
  screen_share_ended: 'Screen sharing stopped. Please share your entire screen again to continue.',
  network_drop: 'Your connection dropped. Your answers are kept and will send when you are back online.',
  face_absent: 'We could not see you in the camera. Please stay in view of the camera.',
  multiple_faces: 'More than one face was seen in the camera. Please make sure you are alone for this level.',
};

export function noticeFor(t: IntegrityEventType): string {
  return NOTICES[t];
}

export const FLAGGED_MESSAGE =
  'This session is flagged for human review. You can keep going. A person looks at the full context before any decision.';

const WEIGHTS: Record<IntegrityEventType, number> = {
  focus_loss: 1,
  tab_hidden: 1,
  fullscreen_exit: 1,
  paste: 1,
  copy: 1,
  context_menu: 1,
  devtools_heuristic: 1,
  multi_display: 1,
  camera_lost: 1,
  screen_share_ended: 1,
  network_drop: 0, // connection trouble is not a learner action
  face_absent: 1,
  multiple_faces: 2,
};

export interface RecordResult {
  notice: string | null;
  flagged: boolean;
}

export class IntegrityTracker {
  counts: Partial<Record<IntegrityEventType, number>> = {};
  flagged = false;
  private total = 0;
  private readonly threshold: number;

  constructor(o: { threshold?: number } = {}) {
    this.threshold = o.threshold ?? 5;
  }

  record(t: IntegrityEventType): RecordResult {
    const first = !this.counts[t];
    this.counts[t] = (this.counts[t] ?? 0) + 1;
    this.total += WEIGHTS[t];
    if (!this.flagged && this.total >= this.threshold) {
      this.flagged = true;
      return { notice: FLAGGED_MESSAGE, flagged: true };
    }
    return { notice: first ? NOTICES[t] : null, flagged: this.flagged };
  }

  adoptServerFlag(): RecordResult {
    if (this.flagged) return { notice: null, flagged: true };
    this.flagged = true;
    return { notice: FLAGGED_MESSAGE, flagged: true };
  }
}
