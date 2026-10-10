// Frontend view of the HTTP contract in delivery/G4-delivery-plan/build-brief.md section 8.
// Route names are authoritative; response field names for routes the brief does not
// specify are the frontend's expectation and are listed as gaps in the build-log.

export type Role = 'learner' | 'reviewer' | 'auditor' | 'recruiter';
export type Track = 'python' | 'data_analyst';
export type Level = 1 | 2 | 3 | 4;
export type Method = 'deterministic_test' | 'probe' | 'ai_judged' | 'live_screening' | 'human_review';
export type Outcome = 'pass' | 'fail' | 'partial' | 'inconclusive';
export type Understanding = 'confirmed' | 'unconfirmed' | 'not_attempted';

export interface Me {
  user_id: string;
  role: Role;
  display_name?: string | null;
  alias?: string | null;
  track?: Track | null;
}

export type LevelStatus = 'locked' | 'not_started' | 'in_progress' | 'passed';
export interface LevelProgress {
  level: Level;
  status: LevelStatus;
  attempts: number;
  attempt_id?: string | null;
}
export interface Progress {
  track: Track | null;
  levels: LevelProgress[];
  all_passed: boolean;
}

export interface AttemptCreated {
  attempt_id: string;
  consent_required: boolean;
}

export interface ChoiceOption {
  id: string;
  text: string;
}
export type ItemKind = 'single_choice' | 'multi_choice' | 'short_answer' | 'code' | 'probe';
export interface ExamItem {
  item_id: string;
  kind: ItemKind;
  prompt: string;
  code?: string;
  label?: string; // e.g. "Base problem", "Adapted variant"
  options?: ChoiceOption[];
  language?: 'python' | 'sql';
  starter_code?: string;
  task_id?: string;
  requires_explanation?: boolean;
  answered?: boolean;
  saved_answer?: string | string[] | null;
  saved_explanation?: string | null;
}
export interface InterviewPrompt {
  index: number;
  total: number;
  text: string;
  scripted?: boolean;
}
export interface Attempt {
  attempt_id: string;
  level: Level;
  status: 'created' | 'consented' | 'in_progress' | 'finished' | 'in_review';
  items: ExamItem[];
  current_prompt?: InterviewPrompt | null;
  result?: AttemptResult | null;
}
export interface AttemptResult {
  outcome: 'passed' | 'not_passed' | 'in_review';
  level: Level;
  next_level?: Level | null;
  all_passed?: boolean;
  items_passed?: number;
  items_total?: number;
  score_percentage?: number;
  evidence_hash?: string;
  evidence_receipt?: string;
  items?: ResultItem[];
}
export interface ResultItem {
  event_id?: string;
  label: string;
  outcome: Outcome | 'pending_review';
  method: Method;
  reason?: string;
  ai_disclosure?: boolean;
  confidence?: 'low' | 'medium' | 'high';
}

export interface RunTest {
  id: string;
  passed: boolean;
  message_safe?: string;
}
export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}
export interface RunResult {
  status: 'passed' | 'failed_tests' | 'error' | 'blocked' | 'timeout' | 'runner_unavailable';
  tests: RunTest[];
  stdout_trunc?: string;
  isolation_mode?: 'container' | 'process-fallback';
  diff?: { kind: 'rows' | 'lines'; lines: DiffLine[] } | null;
}

export type IntegrityEventType =
  | 'focus_loss'
  | 'tab_hidden'
  | 'fullscreen_exit'
  | 'paste'
  | 'copy'
  | 'context_menu'
  | 'devtools_heuristic'
  | 'multi_display'
  | 'camera_lost'
  | 'screen_share_ended'
  | 'network_drop'
  | 'face_absent'
  | 'multiple_faces';

export interface IntegrityEvent {
  type: IntegrityEventType;
  t_ms: number; // monotonic (performance.now)
  at: string; // wall clock ISO
  item_id?: string | null;
}

export interface PrecheckReportBody {
  down_mbps: number;
  up_mbps: number;
  latency_ms: number;
  camera: boolean;
  mic: boolean;
  screen_surface: string;
  fullscreen: boolean;
  single_display: boolean | null;
  browser: string;
}

export interface EvidenceItem {
  event_id: string;
  criterion_id?: string;
  method: Method;
  outcome: Outcome;
  understanding_status?: Understanding;
  occurred_at: string;
  task_version: string;
  rubric_version: string;
  receipt_hash: string;
  ai_disclosure?: boolean;
  submission_excerpt?: string;
}
export type MethodCounts = Record<Method, number>;
export interface CompetencyProfile {
  competency_id: string;
  estimate: number | null;
  lower: number | null;
  upper: number | null;
  as_of: string | null;
  levels_passed: number[];
  method_counts: MethodCounts;
  understanding_status: Understanding;
  evidence_items: EvidenceItem[];
}
export interface Profile {
  competencies: CompetencyProfile[];
  all_levels_passed: boolean;
  levels_passed: number[];
  labels: { experimental: true; ai_used: boolean };
}

export interface Grant {
  grant_id: string;
  recipient_id: string;
  competencies: string[];
  include_raw_submission: boolean;
  expires_at: string;
  created_at?: string;
}
export interface EvidenceOverview {
  evidence_items: EvidenceItem[];
  grants: Grant[];
}
export interface GrantRequest {
  recipient_id: string;
  competencies: string[];
  include_raw_submission: boolean;
  expires_at: string;
  consent_text_version: string;
}

export type AppealStatus = 'received' | 'in_review' | 'decided';
export interface Appeal {
  appeal_id: string;
  event_id?: string | null;
  text: string;
  status: AppealStatus;
  created_at: string;
  decision?: { outcome: string; reason: string } | null;
}

export type Confidence = 'low' | 'medium' | 'high';
export interface QueueCase {
  case_id: string;
  alias: string;
  criterion: string;
  reason: 'low_confidence' | 'appeal' | 'conflict' | 'integrity_risk';
  confidence: Confidence;
  created_at: string;
}
export interface IntegritySummary {
  counts: Partial<Record<IntegrityEventType, number>>;
  risk: 'low' | 'medium' | 'high';
  isolation_mode?: string | null;
}
export interface ReviewCase {
  case_id: string;
  alias: string;
  attempt_id: string;
  status: 'open' | 'decided';
  criterion: string;
  reason: QueueCase['reason'];
  original_work: string;
  ai_rationale?: string | null;
  confidence: Confidence;
  rubric_text: string;
  rubric_version: string;
  probe_status?: Understanding;
  flags: string[];
  appeal_text?: string | null;
  transcript?: string[] | null;
  integrity: IntegritySummary;
  streams: Array<'camera' | 'screen'>;
  prior_decisions?: Array<{ outcome: string; reason: string; at: string }>;
}
export type DecisionOutcome = 'uphold' | 'change' | 'more_info';
export interface DecisionRecorded {
  ledger_entry: number;
}

export interface RoleCompetencyReq {
  competency_id: string;
  priority: 'required' | 'preferred';
  min_levels_passed?: number;
  min_estimate_lower?: number;
  max_evidence_age_days?: number;
  require_understanding_confirmed?: boolean;
  allowed_methods?: Method[];
}
export interface RoleRequirement {
  role_id: string;
  title: string;
  summary?: string;
  version: number;
  competencies: RoleCompetencyReq[];
  created_at: string;
}
export type RoleDraft = Omit<RoleRequirement, 'role_id' | 'version' | 'created_at'>;
export type CoverageState = 'met' | 'partly_met' | 'not_met' | 'no_shared_evidence';
export interface RoleResults {
  role_id: string;
  candidates: Array<{
    alias: string;
    competencies: Array<{
      competency_id: string;
      state: CoverageState;
      gap: boolean;
      reason?: string;
      last_evidence_at?: string | null;
    }>;
  }>;
}
export interface SharedEvidence {
  candidate_ref: string;
  competency_id: string;
  proficiency: { estimate: number; lower: number; upper: number; scale: '0-1'; as_of: string };
  levels_passed: number[];
  method_counts: MethodCounts;
  understanding_status: Understanding;
  evidence_items: EvidenceItem[];
  last_evidence_at: string;
  assessor_report_ref?: string;
  ledger_proof: { head_hash: string; head_sequence: number };
  labels: { experimental: true; ai_used: boolean };
}
export interface ReceiptResult {
  status: 'match' | 'mismatch' | 'unavailable';
  entry?: number;
}
export interface LedgerVerify {
  verified: boolean;
  entries: number;
  head_hash?: string;
  head_sequence?: number;
  first_failing_sequence?: number | null;
  message: string;
  canonicalisation: string;
}
export interface InterviewTurnResponse {
  prompt?: InterviewPrompt | null;
  acknowledgement?: string | null;
  done?: boolean;
  summary?: {
    criteria: Array<{ criterion: string; rationale?: string; confidence?: Confidence }>;
    outcome: 'passed' | 'not_passed' | 'in_review';
    ai_disclosure: boolean;
  } | null;
}
export interface PrecheckReportResponse {
  ok: boolean;
  thresholds?: { min_down_mbps: number; min_up_mbps: number; max_latency_ms: number };
}
