import React from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { AppProvider } from "./context/AppContext";
import { AuthProvider, useAuth } from "./context/AuthContext";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Workspace from "./pages/Workspace";
import SavedRoles from "./pages/SavedRoles";
import Admin from "./pages/Admin";
import Help from "./pages/Help";

/**
 * Nothing below /login renders until the server has said who is signed in.
 *
 * This guard is for the person using the site, not for security — the API
 * refuses unauthenticated requests on its own, which is what actually protects
 * the data. Hiding a page whose data the server would hand over anyway is
 * decoration; this only avoids showing an empty workspace that cannot work.
 */
const RequireAuth: React.FC<{ children: React.ReactNode; adminOnly?: boolean }> = ({
  children,
  adminOnly = false,
}) => {
  const { user, ready } = useAuth();

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink-50">
        <Loader2 size={22} className="animate-spin text-honda-red" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  // Signed in but no password chosen yet — this happens when somebody closes
  // the browser between entering the code and choosing one. Send them back to
  // finish rather than leaving an account nobody can sign into normally.
  if (user.must_set_password) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== "admin") return <Navigate to="/" replace />;

  return <>{children}</>;
};

const guarded = (el: React.ReactNode, adminOnly = false) => (
  <RequireAuth adminOnly={adminOnly}>
    <Layout>{el}</Layout>
  </RequireAuth>
);

const App: React.FC = () => (
  <AuthProvider>
    <AppProvider>
      <HashRouter>
        <Routes>
          {/* One page, three addresses. /login lets it decide which form to
              open; /signup and /signin force one, so a link can be sent to
              somebody who has never been here ("set your password") without
              relying on what their browser happens to remember. */}
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Login />} />
          <Route path="/signin" element={<Login />} />
          {/* The whole ranking flow lives on one page */}
          <Route
            path="/"
            element={
              <RequireAuth>
                <Workspace />
              </RequireAuth>
            }
          />
          <Route path="/history" element={guarded(<SavedRoles />)} />
          <Route path="/admin" element={guarded(<Admin />, true)} />
          <Route path="/help" element={guarded(<Help />)} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AppProvider>
  </AuthProvider>
);

export default App;
