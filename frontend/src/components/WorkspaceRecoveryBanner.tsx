import type { RecoverySummary } from '@/services/workspaceRecoveryApi';

interface WorkspaceRecoveryBannerProps {
  summary: RecoverySummary;
  onDismiss: () => void;
  onViewDetails?: () => void;
}

export function WorkspaceRecoveryBanner({ summary, onDismiss, onViewDetails }: WorkspaceRecoveryBannerProps) {
  const parts: string[] = [];
  if (summary.completed_count > 0) {
    parts.push(`${summary.completed_count} task${summary.completed_count > 1 ? 's' : ''} completed`);
  }
  if (summary.failed_count > 0) {
    parts.push(`${summary.failed_count} task${summary.failed_count > 1 ? 's' : ''} failed`);
  }

  if (parts.length === 0) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-blue-900/50 border-b border-blue-700 text-sm text-blue-200">
      <span className="flex-1">
        While you were away: {parts.join(', ')}
      </span>
      {onViewDetails && (
        <button
          onClick={onViewDetails}
          className="px-2 py-0.5 rounded text-blue-300 hover:text-white hover:bg-blue-800 transition-colors"
        >
          View
        </button>
      )}
      <button
        onClick={onDismiss}
        className="px-2 py-0.5 rounded text-blue-400 hover:text-white hover:bg-blue-800 transition-colors"
      >
        &times;
      </button>
    </div>
  );
}
