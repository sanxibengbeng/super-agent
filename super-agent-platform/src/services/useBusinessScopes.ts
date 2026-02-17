import { useState, useCallback, useEffect } from 'react'
import { BusinessScopeService, BusinessScopeServiceError } from './businessScopeService'
import type { BusinessScope } from './businessScopeService'

export interface UseBusinessScopesState {
  businessScopes: BusinessScope[]
  isLoading: boolean
  error: string | null
}

export interface UseBusinessScopesReturn extends UseBusinessScopesState {
  refetch: () => Promise<void>
  getBusinessScopeById: (id: string) => Promise<BusinessScope | null>
  clearError: () => void
}

export function useBusinessScopes(): UseBusinessScopesReturn {
  const [state, setState] = useState<UseBusinessScopesState>({
    businessScopes: [],
    isLoading: true,
    error: null,
  })

  const fetchBusinessScopes = useCallback(async () => {
    setState(prev => ({ ...prev, isLoading: true, error: null }))
    try {
      const scopes = await BusinessScopeService.getBusinessScopes()
      setState({ businessScopes: scopes, isLoading: false, error: null })
    } catch (err) {
      const message = err instanceof BusinessScopeServiceError ? err.message : 'Failed to fetch business scopes'
      setState(prev => ({ ...prev, isLoading: false, error: message }))
    }
  }, [])

  useEffect(() => {
    void fetchBusinessScopes()
  }, [fetchBusinessScopes])

  const refetch = useCallback(async () => {
    await fetchBusinessScopes()
  }, [fetchBusinessScopes])

  const getBusinessScopeById = useCallback(async (id: string): Promise<BusinessScope | null> => {
    try {
      return await BusinessScopeService.getBusinessScopeById(id)
    } catch {
      return null
    }
  }, [])

  const clearError = useCallback(() => {
    setState(prev => ({ ...prev, error: null }))
  }, [])

  return {
    ...state,
    refetch,
    getBusinessScopeById,
    clearError,
  }
}
