---
name: smart-commit
description: Super Agent smart commit workflow - analyze changes, classify change types, run pre-commit checks (TypeScript, ESLint, tests), generate Conventional Commit messages, safely commit and push. Use this skill whenever the user mentions: commit, push, save changes, submit, check in code, git commit, create commit, make a commit, commit my changes, push to remote, or any variation of committing/pushing code. Also use when user asks to review staged changes before committing, or wants help with commit messages. This skill understands the Fastify backend + React SPA + Prisma monorepo architecture and generates semantically correct Conventional Commits.
---

# Smart Commit - Super Agent Workflow

## Purpose

Automate the complete commit workflow for Super Agent: analyze changes -> pre-checks -> generate commit message -> safe commit and push. Understands the monorepo structure (backend/frontend/infra) and ensures high-quality commits.

## Trigger Keywords

- commit, push, submit, check in, save changes
- git commit, create commit, make a commit
- push to remote, push changes

## Workflow

### Step 1: Analyze Current State

```bash
# View change status
git status

# View detailed diff
git diff
git diff --cached
git diff --stat

# View untracked files
git ls-files --others --exclude-standard

# View recent commits for message style
git log --oneline -10
```

**Understand changes**:
- Which files changed? (Backend routes? Frontend components? Prisma schema? Infra?)
- Change scope? (Single feature? Multiple systems? Bug fix?)
- Change intent? (New feature? Fix? Refactor? Docs?)

### Step 2: Change Classification

Classify changes by file path:

| Path | Type | Scope |
|------|------|-------|
| `backend/src/routes/` | API routes | routes |
| `backend/src/services/` | Business logic | services |
| `backend/src/repositories/` | Data access | repositories |
| `backend/src/schemas/` | Zod schemas | schemas |
| `backend/src/middleware/` | Middleware | middleware |
| `backend/src/authorization/` | Auth logic | auth |
| `backend/prisma/` | Database schema | prisma |
| `backend/skills/` | Built-in skills | skills |
| `frontend/src/pages/` | SPA pages | pages |
| `frontend/src/components/` | React components | components |
| `frontend/src/components/canvas/` | Workflow canvas | canvas |
| `frontend/src/components/chat/` | Chat UI | chat |
| `frontend/src/services/` | API services | api |
| `frontend/src/hooks/` | Custom hooks | hooks |
| `frontend/src/types/` | TypeScript types | types |
| `infra/` | AWS CDK infrastructure | infra |
| `agentcore/` | AgentCore | agentcore |
| `.claude/` | Claude config/skills | claude |
| `.github/` | CI/CD workflows | ci |
| `document/` | Documentation | docs |

### Step 3: Pre-commit Checks

Run critical checks before commit to ensure code quality:

#### 3.1 TypeScript Check (if backend/src or frontend/src changed)
```bash
# Backend
cd backend && npx tsc --noEmit 2>&1 | tail -20

# Frontend
cd frontend && npx tsc --noEmit 2>&1 | tail -20
```
- Type errors: **warn user**, list errors, ask whether to continue
- Pass: continue

#### 3.2 ESLint Check (if src/ files changed)
```bash
# Backend
cd backend && npm run lint 2>&1 | tail -30

# Frontend
cd frontend && npm run lint 2>&1 | tail -30
```
- Serious errors: **warn user**, list errors
- Warnings only: note but continue

#### 3.3 Test Check (if significant logic changed)
```bash
# Backend tests
cd backend && npm run test 2>&1 | tail -30

# Frontend tests
cd frontend && npm run test 2>&1 | tail -30
```
- Test failures: **warn user**, suggest fixing first

#### 3.4 Security Check
```bash
# Check for accidentally staged .env files
git diff --cached --name-only | grep -E '\.env$|\.env\.'

# Check for sensitive info in staged content
git diff --cached | grep -iE 'AKIA|password\s*[:=]|secret\s*[:=]|private.?key' | head -5
```
- Sensitive info found: **block commit**, prompt user to handle

#### 3.5 Large File Check
```bash
# Check for large files in staged changes (>5MB)
git diff --cached --stat | grep -E '\d+ insertions' | head -5
```

### Step 4: Generate Commit Message

**Format** (Conventional Commits):
```
<type>(<scope>): <subject>

<body>

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

**Type Selection**:
- `feat`: New feature, page, component, API endpoint
- `fix`: Bug fix
- `refactor`: Code refactor without changing functionality
- `style`: Style changes (CSS/Tailwind)
- `docs`: Documentation updates
- `chore`: Build config, dependency updates, maintenance
- `perf`: Performance optimization
- `test`: Test additions or modifications
- `ci`: CI/CD changes

**Scope Selection**:
- Single domain change: use that domain scope (e.g., `routes`, `canvas`, `prisma`)
- Cross-domain change: use primary impact domain, or comma-separate (e.g., `routes,services`)
- Global change: omit scope

**Subject Rules**:
- Under 50 characters
- Imperative mood: add/fix/refactor/update/remove/optimize
- Lowercase, no period

**Body Rules**:
- Explain "why" not "what"
- If changes span multiple modules, list key points
- 2-3 lines is sufficient

**Examples**:

```
feat(routes): add workflow execution history endpoint

Add GET /api/workflows/:id/executions to retrieve execution history
with pagination and status filtering.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

```
fix(canvas): resolve node connection validation error

Edge connections were failing when target node had no input handles.
Added null check in validateConnection utility.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

```
refactor(services): extract common agent execution logic

Move shared agent invocation code from chat and workflow services
to new agent-executor.service.ts for reuse.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

### Step 5: Execute Commit

```bash
# Stage specific files (prefer explicit over git add .)
git add <specific-files>

# Commit
git commit -m "$(cat <<'EOF'
<type>(<scope>): <subject>

<body>

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"

# Verify commit
git log -1 --stat
```

**Important**:
- Prefer `git add <specific-files>` over `git add .`
- Never stage `.env*` files
- If multiple logically independent changes, suggest splitting into multiple commits

### Step 6: Pre-push Check

```bash
# Check if remote has new commits
git fetch origin
git log HEAD..origin/$(git branch --show-current) --oneline 2>/dev/null
```

**If remote has new commits**:
1. Inform user: "Remote has new commits, need to pull first"
2. `git pull --rebase origin $(git branch --show-current)`
3. If conflicts, help user resolve
4. Continue push after resolution

### Step 7: Push

```bash
BRANCH=$(git branch --show-current)
git push origin "$BRANCH"
```

**Push Failure Handling**:
- Auth failure -> prompt to check credentials
- Remote rejected -> check if PR needed (don't force push)
- Network error -> suggest retry

### Step 8: Success Output

```
Committed and Pushed

Summary:
- Type: feat(routes)
- Branch: feature/execution-history
- Commit: a1b2c3d
- Files: 5 changed, 120 insertions(+), 30 deletions(-)

Pre-commit checks:
- TypeScript (backend): PASS
- TypeScript (frontend): SKIP (no changes)
- ESLint: PASS (2 warnings)
- Tests: PASS
- Security: PASS

Pushed to: origin/feature/execution-history
```

## Edge Cases

### No Changes
```
Working directory clean, nothing to commit.
Latest commit: <git log -1 --oneline>
```

### Pre-check Failures
- TypeScript errors: list errors, ask "Fix before committing?"
- Security issues: **block commit**, require handling first
- Test failures: warn and ask whether to proceed

### Suggest Splitting Mixed Changes
If detecting logically independent change groups (e.g., backend route changes AND unrelated frontend component fixes):
```
Detected two independent change groups:
1. Backend workflow execution endpoint (3 files)
2. Frontend chat component styling fix (2 files)

Recommend splitting into two commits:
- feat(routes): add workflow execution history endpoint
- fix(chat): correct message timestamp alignment

Split into separate commits? Or combine into one?
```

### Detached HEAD
Inform user and suggest creating a branch before committing.

## Anti-Patterns

- Don't use `git add .` or `git add -A` - stage files explicitly
- Don't generate vague commit messages ("update files", "fix bug")
- Don't skip pre-checks before committing
- Don't continue commit when security issues detected
- Don't force push to shared branches
- Don't combine unrelated changes into one commit (unless user requests)
