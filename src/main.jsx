import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import Admin, { ADMIN_RETURN_KEY } from './Admin.jsx'

// /admin is the operator dashboard. If Supabase's redirect allowlist doesn't
// include /admin, a sign-in started there lands back on the site root — the
// return flag (set right before redirecting, valid 15 min) routes it back.
function isAdminRoute() {
  if (window.location.pathname.startsWith('/admin')) return true;
  let flagged = false;
  try {
    const t = Number(localStorage.getItem(ADMIN_RETURN_KEY) || 0);
    flagged = t > 0 && Date.now() - t < 15 * 60 * 1000;
  } catch (_) {}
  const authReturn = /access_token=|[?&]code=|error_description=/.test(window.location.hash + window.location.search);
  if (flagged && authReturn) {
    window.history.replaceState(null, '', '/admin' + window.location.search + window.location.hash);
    return true;
  }
  return false;
}

createRoot(document.getElementById('root')).render(<StrictMode>{isAdminRoute() ? <Admin /> : <App />}</StrictMode>)
