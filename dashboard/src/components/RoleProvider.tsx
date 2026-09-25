import { useState, useCallback, type ReactNode } from 'react';
import type { UserRole, RoleContextType } from '../types/role';
import { RoleContext } from '../hooks/useRole';

export function RoleProvider({ children }: { children: ReactNode }) {
  // Per tab, next to the API key it was validated for: a role outliving its key (or shared with
  // another tab signed in with a different key) would gate the UI for the wrong actor.
  const [role, setRoleState] = useState<UserRole | null>(() => {
    // Older builds kept the role in localStorage, shared by every tab. A tab that already holds its
    // key but no role of its own adopts that copy, so its first reload after an upgrade does not drop
    // the role until /auth/validate answers. The copy is left in place for the other tabs signed in
    // before the upgrade; every sign-in since stores a role with its key, so no newer tab adopts it.
    const legacy = localStorage.getItem('openwa_user_role');
    if (legacy && !sessionStorage.getItem('openwa_user_role') && sessionStorage.getItem('openwa_api_key')) {
      sessionStorage.setItem('openwa_user_role', legacy);
    }
    const saved = sessionStorage.getItem('openwa_user_role');
    return (saved as UserRole) || null;
  });

  const setRole = useCallback((newRole: UserRole | null) => {
    setRoleState(newRole);
    if (newRole) {
      sessionStorage.setItem('openwa_user_role', newRole);
    } else {
      sessionStorage.removeItem('openwa_user_role');
    }
  }, []);

  // Kept beside the role because GET /infra/engines/current is admin-only: the validate response is
  // the one place every role learns which engine it is talking to.
  const [engineType, setEngineTypeState] = useState<string | null>(() => sessionStorage.getItem('openwa_engine_type'));

  const setEngineType = useCallback((newEngineType: string | null) => {
    setEngineTypeState(newEngineType);
    if (newEngineType) {
      sessionStorage.setItem('openwa_engine_type', newEngineType);
    } else {
      sessionStorage.removeItem('openwa_engine_type');
    }
  }, []);

  const value: RoleContextType = {
    role,
    setRole,
    isAdmin: role === 'admin',
    isOperator: role === 'operator',
    isViewer: role === 'viewer',
    canWrite: role === 'admin' || role === 'operator',
    engineType,
    setEngineType,
  };

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}
