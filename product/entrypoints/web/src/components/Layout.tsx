import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import type { Role } from '../api/types';

const NAV: Record<Role, Array<{ to: string; label: string; icon: string }>> = {
  learner: [
    { to: '/path', label: 'My path', icon: 'route' },
    { to: '/profile', label: 'Profile', icon: 'account_circle' },
    { to: '/sharing', label: 'Sharing', icon: 'share' },
    { to: '/appeals', label: 'Appeals', icon: 'gavel' },
  ],
  reviewer: [{ to: '/review', label: 'Review queue', icon: 'rate_review' }],
  recruiter: [{ to: '/hr', label: 'Roles', icon: 'work' }],
  auditor: [{ to: '/audit', label: 'Ledger check', icon: 'verified_user' }],
};

const ROLE_DISPLAY: Record<Role, { title: string; subtitle: string }> = {
  learner: { title: 'LEARNER VIEW', subtitle: 'Workforce Fellow' },
  recruiter: { title: 'RECRUITER VIEW', subtitle: 'Institutional Recruiter' },
  auditor: { title: 'AUDITOR VIEW', subtitle: 'Cryptographic Auditor' },
  reviewer: { title: 'REVIEWER VIEW', subtitle: 'Assessment Reviewer' },
};

export function Layout() {
  const { role, me, logout } = useAuth();
  const location = useLocation();
  const items = role ? NAV[role] : [];
  const roleMeta = role ? ROLE_DISPLAY[role] : { title: 'PORTAL VIEW', subtitle: 'Member' };

  // Calculate user initials
  const displayName = me?.display_name || (me?.alias ? `cnd_${me.alias.slice(0, 6)}` : 'Elena Vance');
  const initials = displayName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  // Dynamic breadcrumb
  const getBreadcrumb = () => {
    const p = location.pathname;
    if (p.startsWith('/hr')) return 'Recruiter Portal';
    if (p.startsWith('/audit')) return 'Auditor & Admitter Portal';
    if (p.startsWith('/review')) return 'Reviewer Console';
    if (p.startsWith('/lobby')) return 'Verified Sandbox Exam Lobby';
    if (p.startsWith('/exam')) return 'Live Exam Session';
    if (p.startsWith('/profile')) return 'Learner Profile';
    if (p.startsWith('/sharing')) return 'Credential Sharing';
    if (p.startsWith('/appeals')) return 'Appeals Center';
    return 'Verified Sandbox Benchmark Tests';
  };

  return (
    <div className="lms-layout">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      {/* Left Sidebar (Matches Pathway LMS in Image 1) */}
      <aside className="lms-sidebar" aria-label="Sidebar Navigation">
        <div className="lms-sidebar-brand">
          <a href="/" className="lms-brand-logo" title="Pathway LMS Home">
            <div className="lms-brand-icon">
              <span className="material-symbols-outlined text-xl">school</span>
            </div>
            <span className="lms-brand-title">Pathway LMS</span>
          </a>
          <a href="/" className="btn quiet" style={{ padding: 6, minHeight: 'auto', border: 'none' }} title="LMS Home">
            <span className="material-symbols-outlined text-sm">home</span>
          </a>
        </div>

        {/* Dynamic Role Badge */}
        <div className="lms-role-badge">
          <span className="lms-role-dot" aria-hidden="true" />
          <span>• {roleMeta.title}</span>
        </div>

        {/* Role Navigation Links */}
        <div className="lms-nav-section">
          <nav aria-label="Main">
            <ul className="lms-nav-list nav">
              {items.map((i) => (
                <li key={i.to} className="lms-nav-item">
                  <NavLink to={i.to} end={i.to === '/hr'}>
                    <span className="material-symbols-outlined text-lg" aria-hidden="true">
                      {i.icon}
                    </span>
                    <span>{i.label}</span>
                    {i.to === '/path' && <span className="lms-nav-pill-badge">Crucible</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>

          {/* Institutional Role Portals Section */}
          <div className="lms-portals-heading">Institutional Portals</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <a href="/hr" className="lms-portals-link" title="Recruiter Portal">
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="material-symbols-outlined text-base">work</span>
                <span>Recruiter Portal</span>
              </span>
              <span className="text-xs text-slate-400">↗</span>
            </a>
            <a href="/audit" className="lms-portals-link" title="Admitter / Auditor">
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="material-symbols-outlined text-base">shield</span>
                <span>Admitter / Auditor</span>
              </span>
              <span className="text-xs text-slate-400">↗</span>
            </a>
            <a href="/review" className="lms-portals-link" title="Reviewer Console">
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="material-symbols-outlined text-base">rate_review</span>
                <span>Reviewer Console</span>
              </span>
              <span className="text-xs text-slate-400">↗</span>
            </a>
            <a href="/path" className="lms-portals-link" title="Learner Sandbox">
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="material-symbols-outlined text-base">terminal</span>
                <span>Learner Sandbox</span>
              </span>
              <span className="text-xs text-slate-400">↗</span>
            </a>
          </div>
        </div>

        {/* Milestone Progress Card (Bottom of Sidebar in Image 1) */}
        <div className="lms-sidebar-milestone">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#334155' }}>Q1 Target</span>
            <span style={{ fontSize: '0.8125rem', fontWeight: 800, color: 'var(--color-primary)' }}>84%</span>
          </div>
          <div className="lms-milestone-bar">
            <div className="lms-milestone-fill" />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6875rem', color: '#64748b' }}>
            <span>3 milestones left</span>
            <span style={{ fontWeight: 600, color: 'var(--color-primary)' }}>Details →</span>
          </div>
        </div>
      </aside>

      {/* Main App Content Area */}
      <div className="lms-content-wrapper">
        {/* Top Header Bar (Matches Image 1) */}
        <header className="lms-header app-header">
          <div className="lms-breadcrumbs">
            <a href="/" style={{ color: '#64748b', textDecoration: 'none' }}>
              LMS
            </a>
            <span>›</span>
            <span className="active">{getBreadcrumb()}</span>
          </div>

          <div className="lms-header-actions">
            <div className="lms-search-box">
              <span className="material-symbols-outlined text-sm">search</span>
              <span>Search courses & labs...</span>
              <span style={{ padding: '1px 5px', borderRadius: 4, background: '#e2e8f0', fontSize: '10px' }}>⌘K</span>
            </div>

            <div className="lms-status-chip">
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981' }} />
              <span>Sandbox Engine: Connected</span>
            </div>

            <div className="lms-user-profile">
              <div className="lms-avatar">{initials}</div>
              <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
                <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: '#0f172a' }}>{displayName}</span>
                <span style={{ fontSize: '0.6875rem', color: '#64748b' }}>{roleMeta.subtitle}</span>
              </div>
            </div>

            <button type="button" className="btn quiet" style={{ minHeight: 34, padding: '4px 12px' }} onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>

        {/* Page Body */}
        <main id="main" className="lms-main container">
          <Outlet />
        </main>

        <footer className="footer">
          Crucible is experimental. Results are evidence for people to review, not an automated decision.
        </footer>
      </div>
    </div>
  );
}
