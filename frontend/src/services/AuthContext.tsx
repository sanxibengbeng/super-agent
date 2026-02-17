/**
 * Authentication Context (Cognito)
 *
 * Provides authentication state using Cognito Hosted UI tokens.
 * The id_token is sent as Bearer token to the backend for verification.
 */

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import {
  getIdToken,
  isAuthenticated as checkAuth,
  logout as cognitoLogout,
  parseIdToken,
  redirectToLogin,
} from './cognito';
import { restClient } from './api/restClient';
import { shouldUseRestApi } from './api/index';

export interface User {
  id: string;
  email: string;
  name: string;
  organizationId: string;
  organizationName: string;
  role: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: () => Promise<void>;
  logout: () => void;
  error: string | null;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Check for existing Cognito session on mount
  useEffect(() => {
    const loadUser = async () => {
      if (!shouldUseRestApi()) {
        setIsLoading(false);
        return;
      }

      const token = getIdToken();
      if (!token) {
        setIsLoading(false);
        return;
      }

      try {
        // Fetch full user profile from backend (which verifies the Cognito token)
        const userData = await restClient.get<User>('/api/auth/me');
        setUser(userData);
      } catch {
        // Token might be invalid — try parsing locally as fallback
        const claims = parseIdToken(token);
        if (claims) {
          setUser({
            id: claims.sub as string,
            email: (claims.email as string) || '',
            name: (claims.name as string) || (claims.email as string) || '',
            organizationId: (claims['custom:orgId'] as string) || '',
            organizationName: '',
            role: (claims['custom:role'] as string) || 'owner',
          });
        }
      } finally {
        setIsLoading(false);
      }
    };

    loadUser();
  }, []);

  const login = useCallback(async () => {
    setError(null);
    await redirectToLogin();
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setError(null);
    cognitoLogout();
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated: Boolean(user) || checkAuth(),
    login,
    logout,
    error,
    clearError,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export { AuthContext };
