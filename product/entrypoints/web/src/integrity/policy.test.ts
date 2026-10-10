import { describe, it, expect } from 'vitest';
import { IntegrityTracker, FLAGGED_MESSAGE, noticeFor, ALL_EVENT_TYPES } from './policy';

const BANNED = /cheat|misconduct|suspicious|ai detected|violation|fraud|dishonest/i;

describe('integrity wording', () => {
  it('should_never_use_accusation_wording_in_any_notice', () => {
    for (const t of ALL_EVENT_TYPES) expect(noticeFor(t)).not.toMatch(BANNED);
    expect(FLAGGED_MESSAGE).not.toMatch(BANNED);
  });

  it('should_use_the_exact_flag_message', () => {
    expect(FLAGGED_MESSAGE.startsWith('This session is flagged for human review')).toBe(true);
  });

  it('should_have_a_notice_for_every_event_type', () => {
    expect(ALL_EVENT_TYPES).toHaveLength(13);
    for (const t of ALL_EVENT_TYPES) expect(noticeFor(t).length).toBeGreaterThan(10);
  });
});

describe('IntegrityTracker', () => {
  it('should_show_a_neutral_notice_on_the_first_occurrence_of_a_type_only', () => {
    const t = new IntegrityTracker({ threshold: 10 });
    const a = t.record('paste');
    expect(a.notice).toBe(noticeFor('paste'));
    const b = t.record('paste');
    expect(b.notice).toBeNull();
    const c = t.record('focus_loss');
    expect(c.notice).toBe(noticeFor('focus_loss'));
  });

  it('should_flag_for_human_review_when_threshold_is_reached_and_keep_going', () => {
    const t = new IntegrityTracker({ threshold: 3 });
    expect(t.record('paste').flagged).toBe(false);
    expect(t.record('paste').flagged).toBe(false);
    const r = t.record('copy');
    expect(r.flagged).toBe(true);
    expect(r.notice).toBe(FLAGGED_MESSAGE);
    expect(t.record('paste').notice).toBeNull(); // announced once
    expect(t.flagged).toBe(true);
  });

  it('should_not_count_network_drops_toward_the_threshold', () => {
    const t = new IntegrityTracker({ threshold: 2 });
    for (let i = 0; i < 10; i++) t.record('network_drop');
    expect(t.flagged).toBe(false);
  });

  it('should_adopt_a_server_flag', () => {
    const t = new IntegrityTracker({ threshold: 99 });
    expect(t.adoptServerFlag().notice).toBe(FLAGGED_MESSAGE);
    expect(t.flagged).toBe(true);
    expect(t.adoptServerFlag().notice).toBeNull();
  });

  it('should_expose_counts_for_the_status_panel', () => {
    const t = new IntegrityTracker({ threshold: 99 });
    t.record('paste');
    t.record('paste');
    expect(t.counts.paste).toBe(2);
  });
});
