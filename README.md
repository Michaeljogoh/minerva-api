# Browser Agents API

Browser Agents API is a NestJS backend that runs a browser automation agent for accounting workflows. A client sends a natural-language goal over Socket.IO; the server spins up a Steel cloud browser session, drives it with Stagehand, and reasons with OpenAI (custom tool-calling orchestrator). Results are Zod-validated structured outputs. Sensitive actions require human approval.

---

## Overview

One live workspace with three demos:

| Task | `taskType` | What it does |
|------|------------|--------------|
| Multi-site tax impact brief | `tax_code_delta` | Research IRS / state / commerce tax sources → structured client brief |
| Shopify + Stripe reconciliation | `commerce_reconciliation` | Connect or log in, pull orders/payouts → normalized exception table |
| Month-end close assistant | `month_end_exception` | Multi-portal close walkthrough → blockers, missing docs, checklist |

The agent plans before every tool call, never categorizes or posts without approval, may visit public websites needed for the goal, and runs in Steel-hosted Chromium via CDP (live viewer URL over Socket.IO).

**Required env (non-test):** `OPENAI_API_KEY`. **Production:** `STEEL_API_KEY`, `GATEWAY_API_KEY`, `FRONTEND_URL`. **Optional:** `PINECONE_*` (tax RAG embeddings reuse `OPENAI_API_KEY`).

---

## Architecture

```mermaid
flowchart TB
  subgraph client [Client]
    UI[Next.js UI or Socket.IO client]
  end

  subgraph api [NestJS API]
    GW[AgentGateway]
    TC[TaskRunCoordinator]
    BA[BrowserAgent - custom orchestrator + GPT-5]
    PA[PlannerAgent - optional]
    ST[StagehandToolsService]
    SEC[Security]
    REP[SessionService]
    RAG[RagService - tax_code_delta]
  end

  subgraph data [Data]
    PG[(PostgreSQL)]
  end

  STL[Steel live Chromium]
  IRS[IRS.gov]
  PC[(Pinecone optional)]

  UI <-->|Socket.IO| GW
  GW --> TC --> BA
  BA -.->|usePlanner| PA
  BA --> ST --> STL
  STL --> IRS
  BA -.-> RAG -.-> PC
  GW --> SEC
  GW --> REP --> PG
```

**Gateway** handles the Socket.IO contract and task lifecycle. **Agent** runs a custom TypeScript tool-calling loop on OpenAI GPT-5 with optional upfront planning. **Browser** manages Steel sessions (live viewer + Stagehand over CDP) and an ordered screenshot timeline. **Security** covers auth, URL policy, and rate limits. **PostgreSQL** stores durable session replay, screenshots, and task results. **Redis** is optional (off by default). **RAG** (OpenAI embeddings + Pinecone) is optional for `tax_code_delta` only.

```
src/
├── common/       Shared config, constants, schemas, types
├── modules/
│   ├── model/    Swappable ModelProvider (OpenAI default)
│   ├── agent/    Orchestrator, planner, Stagehand tools, approvals
│   ├── browser/  Steel sessions, live view, screenshot store
│   ├── gateway/  Socket.IO, event mapping, task coordinator
│   ├── security/ Auth, URL policy, rate limits
│   ├── redis/    Optional live-session mirror
│   ├── persistence/  TypeORM entities, replay + screenshot timeline
│   ├── rag/      Optional embeddings + Pinecone (tax research)
│   ├── eval/     Offline eval cases E1–E11
│   └── health/   Postgres (+ Redis if enabled)
```

---

## How it works

**Connect.** The client opens Socket.IO to the API origin (default `http://localhost:3001`). Set `GATEWAY_API_KEY` in production and pass it as `auth.token` or `x-api-key` on the handshake.

**Start a task.** The client emits `start_task` with a goal and optional `taskType` and `usePlanner`. The server creates a Steel session, connects Stagehand over CDP, and emits `browser_ready` with a live viewer URL the UI can embed.

**Run the agent.** GPT-5 (via the custom orchestrator) drives the browser through tools: `navigate`, `observe`, `act`, `extract`, `screenshot`, `ask_human`, `request_login`, `request_app_connection`, `composio_execute`, `retrieve_evidence` (tax RAG), and `done`. The model streams reasoning, actions, and observations over Socket.IO. Screenshots append to an ordered timeline after mutating steps.

**Human gates.** Submit, confirm, delete, payment, categorize, post, and clear actions all go through `ask_human`. The client receives `human_approval_required` and responds with `approve_action`. The client can also pause, resume, inject guidance, or stop the task at any time.

**Finish.** On `done`, the server validates `extractedData` against the active task schema, emits `task_complete`, persists the run (including screenshot timeline) to Postgres, and closes the Steel session after a short grace period.

The agent may visit public `http/https` sites needed for the goal. Internal/private hosts are blocked. Set `URL_POLICY_MODE=allowlist` and `URL_ALLOWLIST` only if you want a locked-down host list.

Authenticated apps: prefer Composio OAuth (`COMPOSIO_API_KEY`) for Shopify/Stripe/etc. If Composio is unset, the agent opens the login page and hands the live Steel session to the user.

---

## Socket.IO events

| Event | Direction | Purpose |
|-------|-----------|---------|
| `start_task` | C→S | `{ goal, taskType?, usePlanner? }` |
| `browser_ready` | S→C | `{ liveUrl, sessionId }` |
| `live_view` | S→C | `{ liveUrl, sessionId }` — refreshed inspector URL after navigation or client reconnect |
| `refresh_live_view` | C→S | Re-fetch the current tab’s debugger URL |
| `agent_reasoning` | S→C | Model thoughts before each action |
| `agent_action` | S→C | Tool name and arguments |
| `agent_observation` | S→C | Tool result and success flag |
| `screenshot` | S→C | Post-action page capture URL |
| `human_approval_required` | S→C | `{ approvalId, question, context }` |
| `approve_action` | C→S | `{ approvalId, approved, answer? }` |
| `pause_task` / `resume_task` | C→S | Pause or resume the run |
| `inject_guidance` | C→S | `{ message }` — steer mid-run |
| `stop_task` | C→S | Abort and tear down browser |
| `task_complete` | S→C | `{ summary, data }` — validated result |
| `task_stopped` | S→C | Run aborted |
| `agent_error` | S→C | Recoverable or fatal error |

Full payload shapes: [`docs/backend-prd.md`](./docs/backend-prd.md) §12.

---

## HTTP endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | — | API + Postgres (Redis only if enabled) |
| `GET` | `/sessions` | `x-api-key` if set | List recent replay sessions |
| `GET` | `/sessions/:id` | same | Full session replay |

---

## Quick start

```bash
cp .env.example .env          # OpenAI + Steel + DB keys
docker compose up -d postgres
npm install
npm run start:dev             # http://localhost:3001
```

```bash
curl http://localhost:3001/health
```

### Environment variables

Copy [`.env.example`](./.env.example) to `.env`.

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Agent + Stagehand + optional RAG embeddings (required) |
| `OPENAI_MODEL` | One model for agent, planner, and Stagehand (default `gpt-5-mini`) |
| `OPENAI_PLANNER_MODEL` / `OPENAI_STAGEHAND_MODEL` | Optional overrides; Stagehand auto-prefixes `openai/` |
| `STEEL_API_KEY` | Cloud Chromium + live viewer (required in production) |
| `DATABASE_URL` | PostgreSQL (Compose default: `postgresql://minerva:minerva@localhost:5432/minerva_agent`) |
| `PINECONE_API_KEY` / `PINECONE_INDEX` | Optional RAG for `tax_code_delta` |
| `FRONTEND_URL` | CORS origin (default `http://localhost:3000`) |
| `URL_POLICY_MODE` | `public` (default) or `allowlist` |
| `URL_ALLOWLIST` | Host list when `URL_POLICY_MODE=allowlist` |
| `COMPOSIO_API_KEY` | Optional Shopify/Stripe OAuth; else live-browser login |
| `COMPOSIO_USER_ID` | Composio user id (default `minerva-demo`) |
| `GATEWAY_API_KEY` | Optional in development; **required in production** — protects WebSocket and `/sessions`. Mirror as `NEXT_PUBLIC_GATEWAY_API_KEY` on the web app |
| `PORT` | HTTP port (default `3001`) |

---

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run start:dev` | Nest watch mode |
| `npm run start:prod` | Run compiled `dist/main.js` |
| `npm run build` | Compile to `dist/` |
| `docker compose up --build` | API + Postgres |

---


