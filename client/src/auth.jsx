import { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.auth
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));

    const onUnauthorized = () => setUser(null);
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, []);

  const login = async (email, password) => {
    const u = await api.auth.login(email, password);
    setUser(u);
    return u;
  };

  const logout = async () => {
    try {
      await api.auth.logout();
    } finally {
      setUser(null);
    }
  };

  // What this user may do, straight from the server — the same answer the API
  // will give when the request actually arrives, so the menu and the buttons
  // can never offer something that would be refused.
  const level = (section) => user?.permissions?.[section] || 'none';
  const canView = (section) => level(section) !== 'none';
  const canEdit = (section) => level(section) === 'edit';

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, level, canView, canEdit }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
