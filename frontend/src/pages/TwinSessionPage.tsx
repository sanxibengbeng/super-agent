/**
 * TwinSessionPage
 * Page wrapper for the full-page twin session interface.
 */

import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { TwinSessionPanel } from '@/components/TwinSessionPanel';

export function TwinSessionPage() {
  const { id: projectId, twinSessionId } = useParams<{ id: string; twinSessionId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  if (!projectId || !twinSessionId) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        Invalid session
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-950">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
        <button
          onClick={() => navigate(`/projects/${projectId}`)}
          className="p-1.5 hover:bg-gray-800 rounded-lg transition-colors"
        >
          <ArrowLeft size={18} className="text-gray-400" />
        </button>
        <h1 className="text-sm font-semibold text-white">{t('twinSession.title')}</h1>
      </div>
      <div className="flex-1 overflow-hidden">
        <TwinSessionPanel
          projectId={projectId}
          twinSessionId={twinSessionId}
          isFullPage
        />
      </div>
    </div>
  );
}
