import type * as T from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly reference: string;
  readonly code?: string;
  readonly messageDetail?: string;
  constructor(status: number, reference: string, code?: string, messageDetail?: string) {
    super(`HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.reference = reference;
    this.code = code;
    this.messageDetail = messageDetail;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => fetch(input, init);
/** Test seam: unit tests inject a fake fetch. Never used to ship mock data. */
export function setFetch(f: FetchLike | null): void {
  fetchImpl = f ?? ((input, init) => fetch(input, init));
}

const BASE = '/api';

async function request<R>(method: string, path: string, body?: unknown, raw?: BodyInit): Promise<R> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (raw !== undefined) {
    payload = raw;
    headers['Content-Type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetchImpl(BASE + path, {
    method,
    headers,
    body: payload,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const ref = res.headers.get('x-request-id') ?? '';
    let code: string | undefined;
    let messageDetail: string | undefined;
    try {
      const text = await res.text();
      if (text) {
        const data = JSON.parse(text);
        code = data?.error?.code;
        messageDetail = data?.error?.message;
      }
    } catch {
      // not json or text already consumed
    }
    throw new ApiError(res.status, ref, code, messageDetail);
  }
  if (res.status === 204) return undefined as R;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as R;
}

const enc = encodeURIComponent;

export const api = {
  // auth
  register: (b: { email: string; password: string; display_name?: string }) => request<T.Me>('POST', '/auth/register', b),
  login: (b: { email: string; password: string }) => request<T.Me>('POST', '/auth/login', b),
  logout: () => request<void>('POST', '/auth/logout'),
  me: () => request<T.Me>('GET', '/me'),
  setTrack: (track: T.Track) => request<T.Me>('PUT', '/me/track', { track }),

  // prechecks
  precheckReport: (b: T.PrecheckReportBody) => request<T.PrecheckReportResponse>('POST', '/precheck/report', b),

  // attempts
  progress: () => request<T.Progress>('GET', '/me/progress'),
  createAttempt: (level: T.Level) => request<T.AttemptCreated>('POST', '/attempts', { level }),
  attempt: (id: string) => request<T.Attempt>('GET', `/attempts/${enc(id)}`),
  consent: (id: string, b: { version: string; scopes: string[] }) => request<void>('POST', `/attempts/${enc(id)}/consent`, b),
  start: (id: string) => request<T.Attempt>('POST', `/attempts/${enc(id)}/start`, {}),
  submitItem: (id: string, b: { item_id: string; answer: string | string[] | T.DecisionAnswer; explanation?: string }) =>
    request<{ accepted: boolean }>('POST', `/attempts/${enc(id)}/submit-item`, b),
  run: (id: string, b: { task_id: string; code: string }) => request<T.RunResult>('POST', `/attempts/${enc(id)}/run`, b),
  finish: (id: string) => request<T.AttemptResult>('POST', `/attempts/${enc(id)}/finish`, {}),
  events: (id: string, events: T.IntegrityEvent[]) =>
    request<{ flagged?: boolean } | undefined>('POST', `/attempts/${enc(id)}/events`, events),
  chunk: (id: string, stream: 'camera' | 'screen' | 'justification', seq: number, data: Blob) =>
    request<void>('POST', `/attempts/${enc(id)}/chunks/${stream}/${seq}`, undefined, data),
  finalizeRecording: (id: string) => request<void>('POST', `/attempts/${enc(id)}/recording/finalize`, {}),
  interviewTurn: (id: string, answer_text: string) =>
    request<T.InterviewTurnResponse>('POST', `/interview/${enc(id)}/turn`, { answer_text }),

  // learner
  profile: () => request<T.Profile>('GET', '/me/profile'),
  evidence: async (): Promise<T.EvidenceOverview> => {
    let items: T.EvidenceItem[] = [];
    let grants: T.Grant[] = [];
    try {
      const res = await request<any>('GET', '/me/evidence');
      if (Array.isArray(res?.items)) items = res.items;
      else if (Array.isArray(res?.evidence_items)) items = res.evidence_items;
      if (Array.isArray(res?.grants)) grants = res.grants;
    } catch {
      // ignore
    }
    if (!grants.length) {
      try {
        const gRes = await request<{ grants: T.Grant[] }>('GET', '/me/grants');
        if (Array.isArray(gRes?.grants)) grants = gRes.grants;
      } catch {
        // ignore
      }
    }
    return { evidence_items: items, grants };
  },
  createGrant: (b: T.GrantRequest) =>
    request<T.Grant>('POST', '/me/grants', {
      recipient_id: b.recipient_id,
      competencies: b.competencies,
      expires_at: b.expires_at,
      consent_text_version: '1.0',
    }),
  revokeGrant: async (grant_id: string) => {
    try {
      await request<void>('DELETE', `/me/grants/${enc(grant_id)}`);
    } catch (err: any) {
      if (err?.status === 404) {
        await request<void>('DELETE', '/me/grants', { grant_id });
        return;
      }
      throw err;
    }
  },
  appeals: () => request<{ appeals: T.Appeal[] }>('GET', '/me/appeals'),
  createAppeal: (b: { event_id?: string; text: string }) =>
    request<T.Appeal>('POST', '/me/appeals', { event_id: b.event_id ?? '', reason: b.text }),

  // reviewer
  reviewQueue: () => request<{ cases: T.QueueCase[] }>('GET', '/review/queue'),
  reviewCase: (id: string) => request<T.ReviewCase>('GET', `/review/cases/${enc(id)}`),
  decide: (id: string, b: { outcome: T.DecisionOutcome; reason: string }) =>
    request<T.DecisionRecorded>('POST', `/review/cases/${enc(id)}/decision`, b),
  recordingUrl: (attemptId: string, stream: 'camera' | 'screen' | 'justification') =>
    `${BASE}/review/attempts/${enc(attemptId)}/recording/${stream}`,

  // recruiter
  roles: () => request<{ roles: T.RoleRequirement[] }>('GET', '/hr/roles'),
  createRole: (b: T.RoleDraft) => request<T.RoleRequirement>('POST', '/hr/roles', b),
  roleResults: (id: string) => request<T.RoleResults>('GET', `/hr/roles/${enc(id)}/results`),
  sharedEvidence: (alias: string, competency: string) =>
    request<T.SharedEvidence>('GET', `/hr/evidence/${enc(alias)}/${enc(competency)}`),
  verifyReceipt: (receipt_hash: string, candidate_ref: string, competency_id: string) =>
    request<T.ReceiptResult>('POST', '/hr/receipts/verify', { receipt_hash, candidate_ref, competency_id }),

  // auditor
  verifyLedger: async (): Promise<T.LedgerVerify> => {
    const r = await request<any>('GET', '/audit/ledger/verify');
    return {
      verified: r.verified !== undefined ? Boolean(r.verified) : Boolean(r.ok),
      entries: r.entries ?? r.entries_checked ?? 0,
      head_hash: r.head_hash ?? '',
      head_sequence: r.head_sequence ?? r.entries_checked ?? 0,
      first_failing_sequence: r.first_failing_sequence ?? r.first_failure ?? null,
      message: r.message ?? '',
      canonicalisation: r.canonicalisation ?? '',
    };
  },
};

// Raw helpers for the speed test (binary bodies, timing is measured by the caller).
export async function fetchPrecheckPayload(size: number, f: FetchLike = fetchImpl): Promise<number> {
  const res = await f(`${BASE}/precheck/payload?size=${size}`, { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, '');
  const buf = await res.arrayBuffer();
  return buf.byteLength;
}
export async function postPrecheckEcho(body: Blob | ArrayBuffer, f: FetchLike = fetchImpl): Promise<void> {
  const res = await f(`${BASE}/precheck/echo`, {
    method: 'POST',
    body: body as BodyInit,
    headers: { 'Content-Type': 'application/octet-stream' },
    credentials: 'same-origin',
  });
  if (!res.ok) throw new ApiError(res.status, '');
  await res.arrayBuffer();
}
