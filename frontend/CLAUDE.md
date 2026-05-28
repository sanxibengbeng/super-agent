# Frontend — CLAUDE.md

> React 19 SPA with Vite, Tailwind CSS 4, XY Flow (workflow canvas), React Router 7.

## Commands

```bash
npm run dev                    # Vite dev server (port 5173)
npm run build                  # tsc -b && vite build → dist/
npm run preview                # Preview production build locally
npm run lint                   # ESLint
npm run format                 # Prettier write
npm run format:check           # Prettier CI check
npm run test                   # vitest --run
npm run test:watch             # vitest (watch mode)
npm run test:ui                # Vitest UI
```

## Architecture

```
src/
├── App.tsx                    # BrowserRouter + all route definitions
├── pages/                     # Route-level page components (30+)
├── components/
│   ├── chat/                  # Shared chat UI (messages, tool blocks, session history)
│   ├── canvas/                # XY Flow workflow editor (nodes, edges, toolbar)
│   └── *.tsx                  # Feature components (AgentCard, Sidebar, etc.)
├── services/
│   ├── api/                   # REST client + typed service calls
│   ├── AuthContext.tsx        # Auth state provider
│   ├── ChatContext.tsx        # Chat session/message state
│   ├── ThemeContext.tsx       # Dark/light mode
│   ├── use*.ts                # Data-fetching hooks (agents, workflows, tasks, etc.)
│   └── *Service.ts            # Domain service modules
├── hooks/                     # Utility hooks (avatarUrl, favorites, workspaceEvents)
├── i18n/                      # TranslationContext + translations (en/zh)
└── types/                     # TypeScript type definitions
```

## Path Aliases

Defined in `vite.config.ts`:
```
@/          → src/
@components → src/components/
@pages      → src/pages/
@services   → src/services/
@types      → src/types/
@i18n       → src/i18n/
```

## Key Patterns

### State Management
React Context + custom hooks — no Redux/Zustand:
- `AuthProvider` — JWT/Cognito auth state, org switching
- `ChatContext` — active session, messages, streaming state, memory
- `ThemeProvider` — persisted dark/light preference
- `TranslationProvider` — i18n (en/zh)

### Chat Component Reuse (Critical)
ALL chat-like UIs MUST use `components/chat/` and `ChatContext`. This includes scope copilot, workflow copilot, project twin sessions, chat rooms. Never create standalone chat implementations.

Key components:
- `ChatMessage.tsx` — renders a single message with content blocks
- `TextContentBlock.tsx` — markdown text rendering
- `ToolUseBlock.tsx` / `ToolResultBlock.tsx` — tool call display
- `SessionHistoryPanel.tsx` — session list sidebar

### API Layer
`services/api/` contains the base HTTP client. Domain hooks (`useAgents`, `useWorkflows`, etc.) call typed service functions and manage loading/error state.

### Workflow Canvas
`components/canvas/` wraps XY Flow:
- `Canvas.tsx` + `CanvasContext.tsx` — canvas state
- `nodes/` — custom node renderers per workflow node type
- `edges/` — custom edge renderers
- `NodeEditorPanel.tsx` — node property editor sidebar

### Vite Proxy
Dev server proxies `/api`, `/v1`, `/ws` to `localhost:3000` (backend).

## Styling

Tailwind CSS 4 via `@tailwindcss/vite` plugin. No separate config file — configuration is in the CSS file with `@theme` directives. Dark mode uses class strategy.

## Testing

Vitest + jsdom. Test setup in `src/test/setup.ts`.

- Test files live alongside components (`*.test.tsx`)
- `msw` for API mocking (handlers in `src/test/mocks/`)
- React Testing Library for rendering
- Custom `render()` in `src/test/utils.tsx` wraps with MemoryRouter + providers (import as `render` from `@/test/utils`)
- Property-based tests: `*.property.test.ts` using `fast-check`

## Lib Utilities

- `lib/workflow-plan/` — workflow plan generation, patching, format conversion
- `lib/canvas/` — canvas layout algorithms, node/edge helpers

## Gotchas

- No `index.html` proxy — the SPA fallback is handled by the dev server / nginx in Docker.
- `VITE_` prefix required for env vars exposed to the client.
- i18n uses 'en' and 'cn' language codes — always add both in `i18n/translations.ts`.
- XY Flow nodes must be memoized to avoid unnecessary re-renders.
- `SessionStreamManager` handles SSE streaming with polling fallback for non-streaming sessions.
- Auth auto-detects mode (Cognito vs local) from `GET /api/auth/config`.
