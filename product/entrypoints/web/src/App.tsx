import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, Guard, useAuth } from './auth/AuthContext';
import { homeFor } from './auth/access';
import { Layout } from './components/Layout';
import { AuthPage } from './pages/Auth';
import { PathPage } from './pages/Path';
import { LobbyPage } from './pages/Lobby';
import { ExamPage } from './pages/Exam';
import { InterviewPage } from './pages/Interview';
import { AppealsPage, ProfilePage, ResultPage, SharingPage } from './pages/Learner';
import { ReviewCasePage, ReviewQueuePage } from './pages/Reviewer';
import { EvidencePage, RoleResultsPage, RoleSetupPage, RolesPage } from './pages/Recruiter';
import { AuditPage } from './pages/Auditor';
import { Loading } from './components/ui';

function Home() {
  const { status, role } = useAuth();
  if (status === 'loading') {
    return (
      <div className="container">
        <Loading label="Checking your session" />
      </div>
    );
  }
  return <Navigate to={homeFor(role)} replace />;
}

function NotFound() {
  const { role } = useAuth();
  return (
    <main id="main" className="container narrow">
      <h1>Page not found</h1>
      <p>This page does not exist or you do not have access to it.</p>
      <Link className="btn" to={homeFor(role)}>
        Go to your home page
      </Link>
    </main>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />

      {/* Full-screen, focused proctored-exam surfaces: no LMS chrome, no institutional nav */}
      <Route path="/lobby/:level" element={<Guard><LobbyPage /></Guard>} />
      <Route path="/exam/:attemptId" element={<Guard><ExamPage /></Guard>} />
      <Route path="/interview/:attemptId" element={<Guard><InterviewPage /></Guard>} />

      <Route element={<Guard><Layout /></Guard>}>
        <Route path="/path" element={<PathPage />} />
        <Route path="/result/:attemptId" element={<ResultPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/sharing" element={<SharingPage />} />
        <Route path="/appeals" element={<AppealsPage />} />
        <Route path="/review" element={<ReviewQueuePage />} />
        <Route path="/review/:caseId" element={<ReviewCasePage />} />
        <Route path="/hr" element={<RolesPage />} />
        <Route path="/hr/roles/new" element={<RoleSetupPage />} />
        <Route path="/hr/roles/:roleId" element={<RoleResultsPage />} />
        <Route path="/hr/evidence/:alias/:competency" element={<EvidencePage />} />
        <Route path="/audit" element={<AuditPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
