import { useState } from 'react';
import { ChevronRight, ChevronDown, Brain } from 'lucide-react';
import type { ThinkingContentBlock } from '@/services/chatStreamService';
import { TextContentBlock } from './TextContentBlock';

interface ThinkingBlockProps {
  block: ThinkingContentBlock;
}

export function ThinkingBlock({ block }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!block.thinking) return null;

  return (
    <div
      className="border border-purple-500/20 rounded-lg my-1 bg-purple-900/10 overflow-hidden"
      data-testid="thinking-block"
    >
      <button
        type="button"
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-purple-500/10 rounded-lg transition-colors"
        onClick={() => setIsExpanded(prev => !prev)}
        aria-expanded={isExpanded}
      >
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-purple-400 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-purple-400 flex-shrink-0" />
        )}
        <Brain className="w-4 h-4 text-purple-400 flex-shrink-0" />
        <span className="text-sm font-medium text-purple-400">Thinking</span>
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 text-sm text-gray-400">
          <TextContentBlock block={{ type: 'text', text: block.thinking }} />
        </div>
      )}
    </div>
  );
}
