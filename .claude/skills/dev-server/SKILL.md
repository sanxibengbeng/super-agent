---
name: dev-server
description: Manage Super Agent development environment - start/stop/restart backend (Fastify port 3000) and frontend (Vite port 5173) dev servers, check server status, view logs, troubleshoot port conflicts. Use this skill whenever the user mentions: start server, run dev, npm run dev, stop server, kill server, restart, server status, check ports, port conflict, dev environment, start backend, start frontend, server not working, EADDRINUSE, health check, or any variation of managing development servers. Also use when user reports connection errors or wants to verify servers are running.
---

# Dev Server - Super Agent Development Environment

## Purpose

Manage the Super Agent development environment including backend (Fastify on port 3000) and frontend (Vite on port 5173) dev servers. Handle common issues like port conflicts, process management, and log viewing.

## Trigger Keywords

- "start server", "run dev", "npm run dev"
- "stop server", "kill server"
- "restart server", "restart dev"
- "server status", "check servers"
- "check ports", "port conflict"

## Server Configuration

| Service | Port | Command | Directory |
|---------|------|---------|-----------|
| Backend | 3000 | `npm run dev` | `backend/` |
| Frontend | 5173 | `npm run dev` | `frontend/` |
| PostgreSQL | 5432 | Docker/native | - |
| Redis | 6379 | Docker/native | - |

## Workflows

### Start Development Environment

```bash
# Check if ports are available
lsof -i :3000 2>/dev/null | head -5
lsof -i :5173 2>/dev/null | head -5

# Start backend (in background)
cd backend && npm run dev &

# Start frontend (in background)
cd frontend && npm run dev &

# Verify servers started
sleep 3
curl -s http://localhost:3000/api/health | head -1
curl -s http://localhost:5173 | head -1
```

### Check Server Status

```bash
# Check running processes
ps aux | grep -E "(tsx|vite)" | grep -v grep

# Check port bindings
lsof -i :3000 2>/dev/null | head -3
lsof -i :5173 2>/dev/null | head -3

# Health check
curl -s http://localhost:3000/api/health
```

### Stop Servers

```bash
# Find and kill backend process
pkill -f "tsx watch src/index.ts" || true

# Find and kill frontend process  
pkill -f "vite" || true

# Verify stopped
sleep 1
lsof -i :3000 2>/dev/null || echo "Port 3000 free"
lsof -i :5173 2>/dev/null || echo "Port 5173 free"
```

### Restart Servers

```bash
# Stop existing
pkill -f "tsx watch src/index.ts" || true
pkill -f "vite" || true
sleep 2

# Start fresh
cd backend && npm run dev &
cd frontend && npm run dev &
sleep 3

# Verify
curl -s http://localhost:3000/api/health
```

### Handle Port Conflicts

```bash
# Identify process on port
lsof -i :3000 -t | xargs ps -p 2>/dev/null

# Kill specific port process
lsof -i :3000 -t | xargs kill -9 2>/dev/null || true

# Verify port freed
sleep 1
lsof -i :3000 2>/dev/null || echo "Port 3000 now available"
```

### View Logs

For background processes, use:
```bash
# Check recent backend logs (if using pm2 or similar)
tail -50 ~/.pm2/logs/backend-out.log 2>/dev/null || echo "No pm2 logs"

# Or run in foreground to see live logs
cd backend && npm run dev
```

### Database Connection Check

```bash
# Check PostgreSQL
pg_isready -h localhost -p 5432 2>/dev/null || echo "PostgreSQL not ready"

# Check Redis
redis-cli ping 2>/dev/null || echo "Redis not ready"

# Check via Docker
docker ps | grep -E "(postgres|redis)"
```

## Common Issues

### Port Already in Use
```
Error: listen EADDRINUSE: address already in use :::3000
```
Solution: Find and kill the process using that port.

### Database Connection Failed
```
Error: Can't reach database server
```
Solution: Ensure PostgreSQL is running and DATABASE_URL is correct in `backend/.env`.

### Missing Environment Variables
```
Error: COGNITO_USER_POOL_ID is required
```
Solution: Copy `backend/.env.example` to `backend/.env` and fill in values.

### Prisma Client Not Generated
```
Error: @prisma/client did not initialize
```
Solution: Run `cd backend && npm run prisma:generate`.

## Quick Reference

| Action | Command |
|--------|---------|
| Start all | `cd backend && npm run dev & cd frontend && npm run dev &` |
| Stop all | `pkill -f tsx; pkill -f vite` |
| Backend only | `cd backend && npm run dev` |
| Frontend only | `cd frontend && npm run dev` |
| Check health | `curl localhost:3000/api/health` |
| Free port 3000 | `lsof -i :3000 -t \| xargs kill -9` |
| Generate Prisma | `cd backend && npm run prisma:generate` |
| Run migrations | `cd backend && npm run prisma:migrate` |
