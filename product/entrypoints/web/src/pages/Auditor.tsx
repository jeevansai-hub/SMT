import { useState } from 'react';
import { api } from '../api/client';
import type { LedgerVerify } from '../api/types';
import { Alert, PageHeading, StatCards } from '../components/ui';

export function AuditPage() {
  const [state, setState] = useState<'idle' | 'running' | 'error'>('idle');
  const [res, setRes] = useState<LedgerVerify | null>(null);
  const [copied, setCopied] = useState(false);

  const verify = async () => {
    setState('running');
    setCopied(false);
    try {
      setRes(await api.verifyLedger());
      setState('idle');
    } catch {
      setState('error');
    }
  };

  const copy = async () => {
    if (!res) return;
    try {
      await navigator.clipboard.writeText(res.message);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div>
      <PageHeading>Ledger check</PageHeading>
      <p className="muted">
        Run a check that the record has not been altered. You see hash references only, never private submissions.
      </p>
      <button type="button" className="btn" onClick={() => void verify()} disabled={state === 'running'}>
        Verify ledger
      </button>
      <div role="status" aria-live="polite" style={{ marginTop: 'var(--space-4)' }}>
        {state === 'running' ? <p>Verifying the ledger. This can take a while for long ledgers.</p> : null}
        {state === 'error' ? (
          <Alert kind="warning">Verification could not run. This is not a result; try again.</Alert>
        ) : null}
        {res && state === 'idle' ? (
          res.verified ? (
            <div className="alert success">
              <span className="alert-icon" aria-hidden="true">
                {'✓'}
              </span>
              <div>
                <strong>Verified:</strong> entries 1 to {res.entries} form an unbroken chain.
              </div>
            </div>
          ) : (
            <div className="alert error">
              <span className="alert-icon" aria-hidden="true">
                {'×'}
              </span>
              <div>
                <strong>Not verified:</strong>{' '}
                {res.first_failing_sequence
                  ? `entry ${res.first_failing_sequence} does not match its expected hash. Entries ${res.first_failing_sequence} onward cannot be relied on.`
                  : 'the chain does not match its expected hashes.'}
              </div>
            </div>
          )
        ) : null}
      </div>
      {res && state === 'idle' ? (
        <StatCards
          items={[
            { label: 'Entries checked', value: res.entries },
            { label: 'Tamper detection', value: res.verified ? '100%' : 'FAILED', tone: res.verified ? 'success' : 'error', hint: 'M11: every alteration must be caught' },
            { label: 'First bad entry', value: res.first_failing_sequence ?? '—', tone: res.first_failing_sequence ? 'error' : 'success' },
          ]}
        />
      ) : null}
      {res ? (
        <section className="panel" aria-labelledby="head">
          <h2 id="head">Details</h2>
          <dl>
            {res.head_sequence ? (
              <>
                <dt>Head sequence</dt>
                <dd>{res.head_sequence}</dd>
              </>
            ) : null}
            {res.head_hash ? (
              <>
                <dt>Head hash</dt>
                <dd className="mono" style={{ wordBreak: 'break-all' }}>
                  {res.head_hash}
                </dd>
              </>
            ) : null}
            {res.message ? (
              <>
                <dt>Result</dt>
                <dd>{res.message}</dd>
              </>
            ) : null}
            {res.canonicalisation ? (
              <>
                <dt>Canonicalisation rule</dt>
                <dd className="mono">{res.canonicalisation}</dd>
              </>
            ) : null}
          </dl>
          <button type="button" className="btn secondary" onClick={() => void copy()}>
            Copy result
          </button>
          <span role="status" className="small">
            {copied ? ' Copied.' : ''}
          </span>
        </section>
      ) : null}
    </div>
  );
}
