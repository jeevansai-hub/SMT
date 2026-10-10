import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useState } from 'react';
import { AuthProvider } from '../auth/AuthContext';
import { ExamPage } from './Exam';
import { InterviewPage } from './Interview';
import { CodeEditor } from '../components/CodeEditor';
import { capture } from '../recording/session';
import { expectNoA11yViolations, learner, mockApi, status } from '../test/helpers';
import { fakeStream, fakeTrack, setFullscreen } from '../test/media';
import type { Attempt, Progress } from '../api/types';

const progress: Progress = {
  track: 'python',
  all_passed: false,
  levels: [1, 2, 3, 4].map((l) => ({ level: l as 1 | 2 | 3 | 4, status: l === 1 ? 'in_progress' : 'locked', attempts: 0 })),
};

const attempt: Attempt = {
  attempt_id: 'att1',
  level: 2,
  status: 'in_progress',
  items: [
    {
      item_id: 'i1',
      kind: 'single_choice',
      prompt: 'What does len([1, 2, 3]) return?',
      options: [
        { id: 'a', text: '2' },
        { id: 'b', text: '3' },
      ],
    },
    { item_id: 'i2', kind: 'code', language: 'python', task_id: 't2', prompt: 'Fix the loop', starter_code: 'for i in range(3)\n  print(i)', requires_explanation: true },
  ],
};

function mount(path: string, routes: Parameters<typeof mockApi>[0]) {
  const api = mockApi({ 'GET /me': () => learner, 'GET /me/progress': () => progress, 'GET /attempts/att1': () => attempt, ...routes });
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/exam/:attemptId" element={<ExamPage />} />
          <Route path="/interview/:attemptId" element={<InterviewPage />} />
          <Route path="/result/:id" element={<h1>Result page</h1>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { ...utils, api };
}

beforeEach(() => {
  capture.setStreams(fakeStream([fakeTrack('video'), fakeTrack('audio')]), fakeStream([fakeTrack('video', { displaySurface: 'monitor' })]));
  setFullscreen(true);
});
afterEach(() => {
  capture.release();
  setFullscreen(false);
});

describe('Exam shell', () => {
  it('should_show_alias_level_progress_recording_and_connection_with_no_timer', async () => {
    const { container } = mount('/exam/att1', {});
    expect(await screen.findByRole('heading', { level: 1, name: /Level 2, question 1 of 2/ })).toBeInTheDocument();
    expect(screen.getByText('cnd_0123456789abcdef')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Level progress' })).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Questions' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/time taken|countdown|time left|remaining time|\d+:\d{2}/i);
    await expectNoA11yViolations(container);
  });

  it('should_ask_to_return_to_full_screen_and_move_focus_to_the_prompt_when_full_screen_is_left', async () => {
    setFullscreen(false);
    mount('/exam/att1', {});
    const dlg = await screen.findByRole('alertdialog', { name: 'Return to full screen' });
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Return to full screen' })).toHaveFocus());
    expect(dlg).toHaveTextContent(/Your work is saved/);
    expect(dlg.textContent).not.toMatch(/cheat|misconduct|suspicious/i);
  });

  it('should_save_the_answer_and_move_to_the_next_question', async () => {
    const { api } = mount('/exam/att1', { 'POST /attempts/att1/submit-item': () => ({ accepted: true }) });
    await userEvent.click(await screen.findByRole('radio', { name: '3' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save and next' }));
    expect(await screen.findByRole('heading', { level: 1, name: /question 2 of 2/ })).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'POST /attempts/att1/submit-item')?.body).toEqual({ item_id: 'i1', answer: 'b' });
  });

  it('should_keep_the_answer_and_stay_put_when_saving_fails', async () => {
    mount('/exam/att1', { 'POST /attempts/att1/submit-item': () => status(500) });
    await userEvent.click(await screen.findByRole('radio', { name: '3' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save and next' }));
    expect(await screen.findByText('Your answer was not sent. It is still in the box. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: /question 1 of 2/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '3' })).toBeChecked();
  });

  it('should_mark_for_review_and_reflect_it_in_the_navigator_without_colour_alone', async () => {
    mount('/exam/att1', {});
    await userEvent.click(await screen.findByRole('button', { name: 'Mark for review' }));
    expect(screen.getByRole('button', { name: 'Unmark for review' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Question 1, current, not answered, marked for review/ })).toBeInTheDocument();
  });

  it('should_run_code_and_show_tests_with_row_diff_in_words_and_symbols', async () => {
    const { api } = mount('/exam/att1', {
      'POST /attempts/att1/submit-item': () => ({ accepted: true }),
      'POST /attempts/att1/run': () => ({
        status: 'failed_tests',
        tests: [
          { id: 'test 1', passed: true },
          { id: 'test 2', passed: false, message_safe: 'returned 41 rows, expected 38' },
        ],
        diff: { kind: 'rows', lines: [{ kind: 'same', text: '1, a' }, { kind: 'removed', text: '2, b' }, { kind: 'added', text: '9, z' }] },
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: /Question 2/ }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /plain text box/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Run tests' }));
    const res = await screen.findByRole('region', { name: 'Test results' });
    expect(res).toHaveTextContent('Some checks did not pass.');
    expect(res).toHaveTextContent('1 / 2 passed');
    expect(res).toHaveTextContent('Not passed');
    expect(res).toHaveTextContent('returned 41 rows, expected 38');
    expect(within(res).getByText('Missing:')).toBeInTheDocument();
    expect(within(res).getByText('Extra:')).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'POST /attempts/att1/run')?.body).toMatchObject({ task_id: 't2' });
  });

  it('should_show_a_retryable_message_when_the_checker_is_unreachable', async () => {
    mount('/exam/att1', { 'POST /attempts/att1/run': () => status(503) });
    await userEvent.click(await screen.findByRole('button', { name: /Question 2/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Run tests' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/did not run. Your code is still in the box/);
  });

  it('should_confirm_before_finishing_and_state_how_many_are_unanswered', async () => {
    mount('/exam/att1', {});
    await userEvent.click(await screen.findByRole('button', { name: /Question 2/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Finish level' }));
    const dlg = await screen.findByRole('dialog', { name: 'Finish this level?' });
    expect(dlg).toHaveTextContent('2 of 2 questions have no saved answer');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('CodeEditor accessibility (A11Y-16)', () => {
  function Host() {
    const [v, setV] = useState('print(1)');
    return <CodeEditor id="ed" label="Python editor" language="python" value={v} onChange={setV} />;
  }

  it('should_expose_a_labelled_multiline_editor_and_document_how_to_leave_it', async () => {
    const { container } = render(<Host />);
    expect(screen.getByRole('textbox', { name: 'Python editor' })).toHaveAttribute('aria-multiline', 'true');
    expect(screen.getByText(/Press Escape then Tab to leave the editor/)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('should_not_trap_tab_inside_the_editor', async () => {
    render(
      <div>
        <Host />
        <button type="button">After</button>
      </div>,
    );
    const ed = screen.getByRole('textbox', { name: 'Python editor' });
    ed.focus();
    await userEvent.tab();
    expect(ed).not.toHaveFocus();
  });

  it('should_switch_to_a_plain_textarea_that_keeps_the_text', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('checkbox', { name: /plain text box/ }));
    const ta = screen.getByRole('textbox', { name: 'Python editor' });
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta).toHaveValue('print(1)');
  });
});

describe('Level 4 live screening', () => {
  const l4: Attempt = {
    attempt_id: 'att1',
    level: 4,
    status: 'in_progress',
    items: [],
    current_prompt: { index: 1, total: 5, text: 'Explain how your solution works.' },
  };

  it('should_work_with_typed_answers_when_speech_to_text_is_not_available', async () => {
    const { container } = mount('/interview/att1', { 'GET /attempts/att1': () => l4 });
    expect(await screen.findByRole('heading', { level: 1, name: 'Level 4: prompt 1 of 5' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Speak your answer' })).not.toBeInTheDocument();
    expect(screen.getByText(/Speech to text is not available/)).toBeInTheDocument();
    expect(screen.getByRole('log')).toHaveTextContent('Interviewer: Explain how your solution works.');
    expect(document.body.textContent).not.toMatch(/time taken|countdown|remaining time/i);
    await expectNoA11yViolations(container);
  });

  it('should_take_turns_show_captions_and_end_with_an_ai_disclosed_summary', async () => {
    let n = 0;
    mount('/interview/att1', {
      'GET /attempts/att1': () => l4,
      'POST /interview/att1/turn': () => {
        n++;
        return n === 1
          ? { acknowledgement: 'Thanks, noted.', prompt: { index: 2, total: 5, text: 'What is the complexity?', scripted: true } }
          : { done: true, summary: { outcome: 'in_review', ai_disclosure: true, criteria: [{ criterion: 'Explain', rationale: 'Clear' }] } };
      },
    });
    await userEvent.type(await screen.findByLabelText('Your answer'), 'It loops once');
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(await screen.findByRole('heading', { name: 'Level 4: prompt 2 of 5' })).toBeInTheDocument();
    expect(screen.getByText('Scripted follow-up')).toBeInTheDocument();
    expect(screen.getByRole('log')).toHaveTextContent('You: It loops once');
    expect(screen.getByLabelText('Your answer')).toHaveValue('');
    await userEvent.type(screen.getByLabelText('Your answer'), 'Linear time');
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(await screen.findByText(/A person will review this session/)).toBeInTheDocument();
    expect(screen.getByText(/AI-assisted evaluation/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish session' })).toBeInTheDocument();
  });

  it('should_keep_the_typed_answer_when_sending_fails', async () => {
    mount('/interview/att1', { 'GET /attempts/att1': () => l4, 'POST /interview/att1/turn': () => status(500) });
    await userEvent.type(await screen.findByLabelText('Your answer'), 'My answer');
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(await screen.findByText('Your answer was not sent. It is still in the box. Try again.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your answer')).toHaveValue('My answer');
  });
});
