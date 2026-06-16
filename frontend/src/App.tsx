import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { TranslationProvider } from '@/i18n'
import { AppShell, ErrorBoundary, ToastProvider, ProtectedRoute, SkillMarketplaceBrowser, SkillWorkshop } from '@/components'
import { Login } from '@/pages/Login'
import { AuthCallback } from '@/pages/AuthCallback'
import { InviteAccept } from '@/pages/InviteAccept'
import { AuthProvider } from '@/services/AuthContext'
import { ThemeProvider } from '@/services/ThemeContext'
import { useTranslation } from '@/i18n'

// Lazy-loaded pages
const Dashboard = lazy(() => import('@/pages/Dashboard').then(m => ({ default: m.Dashboard })))
const Chat = lazy(() => import('@/pages/Chat').then(m => ({ default: m.Chat })))
const WorkflowEditor = lazy(() => import('@/pages/WorkflowEditor').then(m => ({ default: m.WorkflowEditor })))
const Agents = lazy(() => import('@/pages/Agents').then(m => ({ default: m.Agents })))
const Tools = lazy(() => import('@/pages/Tools').then(m => ({ default: m.Tools })))
const AgentConfigurator = lazy(() => import('@/pages/AgentConfigurator').then(m => ({ default: m.AgentConfigurator })))
const TaskAuditLog = lazy(() => import('@/pages/TaskAuditLog').then(m => ({ default: m.TaskAuditLog })))
const TaskExecutionCenter = lazy(() => import('@/pages/TaskExecutionCenter').then(m => ({ default: m.TaskExecutionCenter })))
const MCPConfigurator = lazy(() => import('@/pages/MCPConfigurator').then(m => ({ default: m.MCPConfigurator })))
const KnowledgeManager = lazy(() => import('@/pages/KnowledgeManager').then(m => ({ default: m.KnowledgeManager })))
const InfrastructureConfigurator = lazy(() => import('@/pages/InfrastructureConfigurator').then(m => ({ default: m.InfrastructureConfigurator })))
const CreateBusinessScope = lazy(() => import('@/pages/CreateBusinessScope').then(m => ({ default: m.CreateBusinessScope })))
const Marketplace = lazy(() => import('@/pages/Marketplace').then(m => ({ default: m.Marketplace })))
const AppRunner = lazy(() => import('@/pages/AppRunner').then(m => ({ default: m.AppRunner })))
const ScopeCopilotPage = lazy(() => import('@/pages/ScopeCopilotPage').then(m => ({ default: m.ScopeCopilotPage })))
const StarredSessions = lazy(() => import('@/pages/StarredSessions').then(m => ({ default: m.StarredSessions })))
const ShowcasePage = lazy(() => import('@/pages/ShowcasePage').then(m => ({ default: m.ShowcasePage })))
const Settings = lazy(() => import('@/pages/Settings').then(m => ({ default: m.Settings })))
const ChatRoomPage = lazy(() => import('@/pages/ChatRoomPage').then(m => ({ default: m.ChatRoomPage })))
const DigitalTwinWizard = lazy(() => import('@/pages/DigitalTwinWizard').then(m => ({ default: m.DigitalTwinWizard })))
const Projects = lazy(() => import('@/pages/Projects').then(m => ({ default: m.Projects })))
const ProjectCopilot = lazy(() => import('@/pages/ProjectCopilot').then(m => ({ default: m.ProjectCopilot })))
const TwinSessionPage = lazy(() => import('@/pages/TwinSessionPage').then(m => ({ default: m.TwinSessionPage })))

const SuspenseFallback = () => (
  <div className="flex items-center justify-center h-screen bg-gray-950">
    <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" />
  </div>
)

function AppContent() {
  const { t } = useTranslation()
  return (
    <Suspense fallback={<SuspenseFallback />}>
    <Routes>
      {/* Full-page routes without AppShell */}
      <Route path="/create-business-scope" element={<CreateBusinessScope />} />
      <Route path="/agents/config/:agentId/workshop" element={<SkillWorkshop />} />
      <Route path="/create-digital-twin" element={<DigitalTwinWizard />} />
      
      {/* Routes with AppShell */}
      <Route path="/*" element={
        <AppShell>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/chat/room/:roomId" element={<ChatRoomPage />} />
            <Route path="/workflow" element={<WorkflowEditor />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/agents/config/:agentId" element={<AgentConfigurator />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:id" element={<ProjectCopilot />} />
            <Route path="/projects/:id/twin-session/:twinSessionId" element={<TwinSessionPage />} />
            <Route path="/tools" element={<Tools />} />
            <Route path="/tasks" element={<TaskAuditLog />} />
            <Route path="/task-monitoring" element={<TaskExecutionCenter />} />
            {/* Config routes - placeholder for admin menu navigation */}
            <Route path="/config/mcp" element={<MCPConfigurator />} />
            <Route path="/config/skills" element={<SkillMarketplaceBrowser />} />
            <Route path="/config/rest-api" element={<div className="p-6 text-white">{t('config.restApi')}</div>} />
            <Route path="/config/knowledge" element={<KnowledgeManager />} />
            <Route path="/config/framework" element={<InfrastructureConfigurator />} />
            <Route path="/apps" element={<Marketplace />} />
            <Route path="/apps/:id" element={<AppRunner />} />
            <Route path="/starred" element={<StarredSessions />} />
            <Route path="/showcase" element={<ShowcasePage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/create-business-scope/ai" element={<ScopeCopilotPage />} />
          </Routes>
        </AppShell>
      } />
    </Routes>
    </Suspense>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <BrowserRouter>
          <TranslationProvider>
            <ToastProvider>
              <AuthProvider>
                <Routes>
                  <Route path="/login" element={<Login />} />
                  <Route path="/auth/callback" element={<AuthCallback />} />
                  <Route path="/invite/:token" element={<InviteAccept />} />
                  <Route path="/*" element={
                    <ProtectedRoute>
                      <AppContent />
                    </ProtectedRoute>
                  } />
                </Routes>
              </AuthProvider>
            </ToastProvider>
          </TranslationProvider>
        </BrowserRouter>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
