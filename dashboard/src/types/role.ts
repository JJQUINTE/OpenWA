// Role types for RBAC
export type UserRole = 'admin' | 'operator' | 'viewer';

export interface RoleContextType {
  role: UserRole | null;
  setRole: (role: UserRole | null) => void;
  isAdmin: boolean;
  isOperator: boolean;
  isViewer: boolean;
  canWrite: boolean;
  /** Engine the gateway runs, as POST /auth/validate reported it; null until it has answered. */
  engineType: string | null;
  setEngineType: (engineType: string | null) => void;
}
