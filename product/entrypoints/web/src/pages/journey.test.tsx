import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { capture } from '../recording/session';
import { learner, renderApp, status, type Handler } from '../test/helpers';
import { installBrowserFakes, setFullscreen } from '../test/media';
import type { Attempt, Progress } from '../api/types';

// Critical journey (integration level, jsdom + fake HTTP): sign-in session -> My path -> check-in
// wizard (consent, network, camera/mic, screen, full screen, rules) -> exam -> finish -> result.
// It is NOT a real-browser end-to-end test; see the build-log for the status of those.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const progress: Progress = {
  track: 'python',
  all_passed: false,
  levels: [
    { level: 1, status: 'not_started', attempts: 0 },
    { level: 2, status: 'locked', attempts: 0 },
    { level: 3, status: 'locked', attempts: 0 },
    { level: 4, status: 'locked', attempts: 0 },
  ],
};

function routes(over: Record<string, Handler> = {}) {
  let finished = false;
  const att = (): Attempt => ({
    attempt_id: 'att1',
    level: 1,
    status: finished ? 'finished' : 'in_progress',
    items: [
      { item_id: 'i1', kind: 'single_choice', prompt: 'What does len([1, 2, 3]) return?', options: [{ id: 'a', text: '2' }, { id: 'b', text: '3' }] },
    ],
    result: finished ? { outcome: 'passed', level: 1, next_level: 2, items: [{ label: 'Question 1', outcome: 'pass', method: 'deterministic_test', event_id: 'ev1' }] } : null,
  });
  return {
    'GET /me/progress': () => progress,
    'POST /attempts': () => ({ attempt_id: 'att1', consent_required: true }),
    'POST /attempts/att1/consent': () => undefined,
    'GET /precheck/payload': async (_b: unknown, url: URL) => {
      await delay(20);
      return new Response(new ArrayBuffer(Number(url.searchParams.get('size') ?? 1)), { status: 200 });
    },
    'POST /precheck/echo': async () => {
      await delay(20);
      return undefined;
    },
    'POST /precheck/report': () => ({ ok: true }),
    'POST /attempts/att1/start': () => att(),
    'GET /attempts/att1': () => att(),
    'POST /attempts/att1/submit-item': () => ({ accepted: true }),
    'POST /attempts/att1/events': () => undefined,
    'POST /attempts/att1/recording/finalize': () => undefined,
    'POST /attempts/att1/finish': () => {
      finished = true;
      return att().result;
    },
    ...over,
  } as never;
}

beforeEach(() => {
  capture.release();
});
afterEach(() => {
  capture.release();
  setFullscreen(false);
  vi.restoreAllMocks();
});

describe('learner critical journey (REQ: level attempt with consent, pre-checks, proctored exam)', () => {
  it('should_complete_level_1_from_path_to_passed_result', async () => {
    const fakes = installBrowserFakes();
    const { api } = renderApp('/path', learner, routes());

    await userEvent.click(await screen.findByRole('link', { name: /Start\s*Level 1/ }));

    // 1 confirm
    expect(await screen.findByRole('heading', { level: 1, name: /Level 1: Conceptual/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // 2 consent comes before ANY capture
    expect(await screen.findByRole('heading', { level: 1, name: 'Your consent' })).toBeInTheDocument();
    expect(fakes.getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Agree and continue' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /I understand and I agree/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Agree and continue' }));
    expect(api.calls.find((c) => c.key === 'POST /attempts/att1/consent')?.body).toMatchObject({
      version: '2026-10-v1',
      scopes: ['camera', 'microphone', 'screen', 'events'],
    });

    // 3 network with live gauge
    expect(await screen.findByRole('heading', { level: 1, name: 'Check your connection' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Start test' }));
    expect(await screen.findByText('Your connection is good for this exam.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // 4 camera + mic
    await userEvent.click(await screen.findByRole('button', { name: 'Allow camera and microphone' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // 5 screen
    await userEvent.click(await screen.findByRole('button', { name: 'Share entire screen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // 6 full screen
    await userEvent.click(await screen.findByRole('button', { name: 'Enter full screen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // 7 rules + start, all checks ready
    expect(await screen.findByRole('heading', { level: 1, name: 'Rules, then start' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start Level 1' }));
    expect(api.count('POST /precheck/report')).toBe(1);
    expect(api.calls.find((c) => c.key === 'POST /precheck/report')?.body).toMatchObject({ screen_surface: 'monitor', fullscreen: true });

    // exam
    expect(await screen.findByRole('heading', { level: 1, name: /Level 1, question 1 of 1/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: '3' }));
    await userEvent.click(screen.getByRole('button', { name: 'Finish level' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Finish level' }));

    // result
    expect(await screen.findByText('You passed this level. Your progress is saved.', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue to Level 2' })).toHaveAttribute('href', '/lobby/2');
    expect(screen.getByRole('link', { name: /Appeal this result/ })).toBeInTheDocument();
    expect(api.count('POST /attempts/att1/submit-item')).toBe(1);
    expect(api.count('POST /attempts/att1/finish')).toBe(1);
    expect(capture.camera).toBeNull(); // streams released after finishing
  }, 20000);

  it('should_block_start_until_the_entire_screen_is_shared', async () => {
    installBrowserFakes({ surface: 'window' });
    renderApp('/lobby/1', learner, routes());
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /I understand/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Agree and continue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start test' }));
    await screen.findByText('Your connection is good for this exam.');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Allow camera and microphone' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Share entire screen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/share your entire screen, not a window or a tab/);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  }, 20000);

  it('should_not_start_recording_or_ask_for_media_when_consent_is_declined', async () => {
    const fakes = installBrowserFakes();
    renderApp('/lobby/1', learner, routes());
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const decline = await screen.findByRole('link', { name: 'Decline and go back' });
    expect(decline).toHaveAttribute('href', '/path');
    expect(fakes.getUserMedia).not.toHaveBeenCalled();
    expect(fakes.getDisplayMedia).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/penalt|cheat|suspicious/i);
  });

  it('should_hold_the_user_at_the_network_step_when_the_connection_is_too_slow', async () => {
    installBrowserFakes();
    renderApp(
      '/lobby/1',
      learner,
      routes({
        'GET /precheck/payload': async (_b: unknown, url: URL) => {
          await delay(Number(url.searchParams.get('size')) > 1 ? 4000 : 5); // 2 MB in 4 s = 4 Mbps ok; push slower below
          return new Response(new ArrayBuffer(Number(url.searchParams.get('size') ?? 1)));
        },
        'POST /precheck/echo': async () => {
          await delay(9000); // 1 MB in 9 s ~ 0.9 Mbps < 1
          return undefined;
        },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /I understand/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Agree and continue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start test' }));
    expect(await screen.findByText(/Your connection needs at least 2 Mbps down, 1 Mbps up/, {}, { timeout: 16000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(status(200).ok).toBe(true);
  }, 30000);
});
