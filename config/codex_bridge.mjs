#!/usr/bin/env node
/**
 * Antigravity <-> Codex App Server Bridge
 *
 * Dual-mode global helper:
 * 1. Default (no CLI subcommand): runs as a persistent stdio MCP server wrapping `codex app-server`.
 * 2. CLI fallback (`explore` / `resume` / `review`): runs a single short command and exits cleanly.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, 'last_threads.json');
const DEFAULT_TIMEOUT_MS = 1_800_000;
const MCP_SLICE_MS = 150_000;
const MAX_MCP_SLICE_MS = 165_000;
const MAX_JOB_HISTORY = 20;
const MAX_CONCURRENT_JOBS = 2; // 严格限制最多 2 并发
const DEFAULT_EXPLORE_MODEL = process.env.CODEX_EXPLORE_MODEL || 'gpt-6-luna';
const DEFAULT_REVIEW_MODEL = process.env.CODEX_REVIEW_MODEL || 'gpt-6.2-sol';

function resolveModelArg(model, fallback = '') {
    const raw = String(model || '').trim();
    if (raw) return raw;
    return fallback;
}

function resolveEffortArg(effort, model = '') {
    const raw = String(effort || '').trim();
    if (raw) return raw;
    const m = String(model || '').toLowerCase();
    if (m.includes('sol')) return 'medium';
    if (m.includes('luna')) return 'xhigh';
    return 'max';
}

function resolveServiceTierArg(serviceTier, model = '') {
    const raw = String(serviceTier || '').trim();
    if (raw) return raw;
    return 'default';
}

function normalizeCwdKey(cwd) {
    return path.resolve(cwd || process.cwd()).toLowerCase();
}

function readThreadStore() {
    try {
        if (!fs.existsSync(STATE_PATH)) return { byCwd: {}, latest: null };
        const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        return parsed && typeof parsed === 'object'
            ? { byCwd: parsed.byCwd || {}, latest: parsed.latest || null }
            : { byCwd: {}, latest: null };
    } catch {
        return { byCwd: {}, latest: null };
    }
}

function saveLastThread(cwd, threadId) {
    if (!threadId) return;
    try {
        const store = readThreadStore();
        const key = normalizeCwdKey(cwd);
        store.byCwd[key] = threadId;
        store.latest = threadId;
        fs.writeFileSync(STATE_PATH, JSON.stringify(store, null, 2), 'utf8');
    } catch {}
}

function resolveThreadId(threadId, cwd) {
    const raw = String(threadId || '').trim();
    if (raw && raw.toLowerCase() !== 'last') return raw;
    const store = readThreadStore();
    return store.byCwd[normalizeCwdKey(cwd)] || store.latest || '';
}

function resolveCodexCommand() {
    const envJs = process.env.CODEX_JS_PATH;
    if (envJs && fs.existsSync(envJs)) {
        return { cmd: process.execPath, args: [envJs, 'app-server', '--listen', 'stdio://'] };
    }
    if (process.platform === 'win32' && process.env.APPDATA) {
        const npmCodexJs = path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (fs.existsSync(npmCodexJs)) {
            return { cmd: process.execPath, args: [npmCodexJs, 'app-server', '--listen', 'stdio://'] };
        }
    }
    return { cmd: 'codex', args: ['app-server', '--listen', 'stdio://'] };
}

function buildReviewPrompt({ target = 'uncommitted', branch, commit, instructions }) {
    const tail = [
        'Operate strictly in read-only mode (do not modify any files).',
        'Focus on real bugs, regressions, edge cases, concurrency/race issues, security/boundary flaws, and missing error handling.',
        'For each issue found, provide priority [P0]/[P1]/[P2], exact file:line, root cause, and suggested fix. If no actionable bugs are found, say so clearly with what you checked.'
    ];
    if (instructions && String(instructions).trim() && target !== 'custom') {
        tail.push(`Additional review focus: ${String(instructions).trim()}`);
    }
    if (target === 'branch') {
        if (!branch) throw new Error('`branch` is required when target="branch"');
        return `Perform an independent read-only code review of changes compared against base branch \`${branch}\` (inspect \`git diff ${branch}...HEAD\` and the affected files directly).\n\n${tail.join('\n')}`;
    }
    if (target === 'commit') {
        if (!commit) throw new Error('`commit` is required when target="commit"');
        return `Perform an independent read-only code review of commit \`${commit}\` (inspect \`git show ${commit}\` and surrounding files directly).\n\n${tail.join('\n')}`;
    }
    if (target === 'custom') {
        if (!instructions) throw new Error('`instructions` is required when target="custom"');
        return `Perform an independent read-only code review in this repository:\n${instructions}\n\n${tail.join('\n')}`;
    }
    return `Perform an independent read-only code review of all current uncommitted workspace changes (inspect \`git status\`, \`git diff\`, \`git diff --cached\`, untracked files if any, and read the modified files in context).\n\n${tail.join('\n')}`;
}

class CodexAppServerClient {
    constructor() {
        this.child = null;
        this.rl = null;
        this.nextId = 1;
        this.pending = new Map();
        this.activeTurn = null;
        this.startPromise = null;
    }

    async ensureStarted() {
        if (this.child && !this.child.killed && this.child.exitCode === null) {
            return;
        }
        if (this.startPromise) return this.startPromise;
        this.startPromise = this._startInternal().finally(() => {
            this.startPromise = null;
        });
        return this.startPromise;
    }

    async _startInternal() {
        const { cmd, args } = resolveCodexCommand();
        const child = spawn(cmd, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
        this.child = child;

        this.rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        this.rl.on('line', (line) => this._handleLine(line));

        child.stderr.on('data', (chunk) => {
            const msg = String(chunk || '').trim();
            if (msg && process.env.CODEX_BRIDGE_DEBUG === '1') {
                process.stderr.write(`[codex-app-server] ${msg}\n`);
            }
        });

        child.on('exit', (code) => {
            const err = new Error(`codex app-server exited (code=${code})`);
            this._rejectAllInFlight(err);
            this.child = null;
            this.rl = null;
        });

        child.on('error', (err) => {
            this._rejectAllInFlight(err);
            this.child = null;
            this.rl = null;
        });

        child.stdin.on('error', (err) => {
            this._rejectAllInFlight(err);
        });

        await this.request('initialize', {
            clientInfo: {
                name: 'antigravity-codex-bridge',
                title: 'Antigravity Codex Bridge',
                version: '1.0.0'
            },
            capabilities: { experimentalApi: false }
        }, 20_000);
        this.notify('initialized', {});
    }

    _rejectAllInFlight(err) {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(err);
        }
        this.pending.clear();
        if (this.activeTurn) {
            const cur = this.activeTurn;
            this.activeTurn = null;
            clearTimeout(cur.timer);
            cur.reject(err);
        }
    }

    _sendRaw(obj) {
        if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
            throw new Error('codex app-server stdin unavailable');
        }
        this.child.stdin.write(JSON.stringify(obj) + '\n', 'utf8');
    }

    notify(method, params) {
        this._sendRaw(params !== undefined ? { method, params } : { method });
    }

    request(method, params, timeoutMs = 60_000) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`RPC timeout (${timeoutMs}ms): ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this._sendRaw({ id, method, params });
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err);
            }
        });
    }

    _handleLine(line) {
        const trimmed = String(line || '').trim();
        if (!trimmed) return;
        let msg;
        try {
            msg = JSON.parse(trimmed);
        } catch {
            return;
        }

        // Response to our RPC request
        if (msg.id !== undefined && msg.method === undefined) {
            const entry = this.pending.get(msg.id);
            if (!entry) return;
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) {
                entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
                entry.resolve(msg.result);
            }
            return;
        }

        // Server-initiated request: never block headless execution
        if (msg.id !== undefined && typeof msg.method === 'string') {
            if (msg.method.includes('Approval')) {
                this._sendRaw({ id: msg.id, result: { decision: 'decline' } });
            } else {
                this._sendRaw({
                    id: msg.id,
                    error: { code: -32601, message: `Unsupported headless server request: ${msg.method}` }
                });
            }
            return;
        }

        // Server notification
        if (typeof msg.method === 'string') {
            this._handleNotification(msg.method, msg.params || {});
        }
    }

    _handleNotification(method, params) {
        const cur = this.activeTurn;
        if (!cur) return;
        const pThreadId = params.threadId;
        if (cur.threadIds && cur.threadIds.size > 0 && pThreadId && !cur.threadIds.has(pThreadId)) return;

        if (method === 'item/completed') {
            const item = params.item;
            if (item && item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
                cur.agentMessages.push(item.text.trim());
            } else if (item && item.type === 'exitedReviewMode' && typeof item.review === 'string' && item.review.trim()) {
                cur.reviewMessages.push(item.review.trim());
            }
        } else if (method === 'thread/tokenUsage/updated') {
            if (params.tokenUsage) {
                cur.tokenUsage = params.tokenUsage;
            }
        } else if (method === 'turn/completed') {
            const turn = params.turn || {};
            if (cur.turnId && turn.id && turn.id !== cur.turnId) return;
            if (cur.agentMessages.length === 0 && cur.reviewMessages.length === 0 && Array.isArray(turn.items)) {
                for (const item of turn.items) {
                    if (item && item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
                        cur.agentMessages.push(item.text.trim());
                    } else if (item && item.type === 'exitedReviewMode' && typeof item.review === 'string' && item.review.trim()) {
                        cur.reviewMessages.push(item.review.trim());
                    }
                }
            }
            const finalAnswer = (cur.agentMessages.length > 0 ? cur.agentMessages : cur.reviewMessages).join('\n\n').trim();
            this.activeTurn = null;
            clearTimeout(cur.timer);
            cur.resolve({
                threadId: cur.returnThreadId || pThreadId || Array.from(cur.threadIds)[0],
                turnId: turn.id || cur.turnId,
                status: turn.status || 'completed',
                error: turn.error || null,
                answer: finalAnswer,
                tokenUsage: cur.tokenUsage
            });
        }
    }

    async _runTurn(expectedThreadId, startTurnFn, timeoutMs = DEFAULT_TIMEOUT_MS) {
        if (this.activeTurn) {
            throw new Error('Another Codex turn is currently running in this bridge.');
        }
        const t0 = Date.now();
        const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.activeTurn) {
                    const tid = this.activeTurn.returnThreadId || Array.from(this.activeTurn.threadIds)[0];
                    const turnId = this.activeTurn.turnId;
                    this.activeTurn = null;
                    if (tid && turnId) {
                        this.request('turn/interrupt', { threadId: tid, turnId }, 5_000).catch(() => {});
                    }
                }
                reject(new Error(`Codex turn timed out after ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);

            const initialIds = new Set(expectedThreadId ? [expectedThreadId] : []);
            this.activeTurn = {
                threadIds: initialIds,
                returnThreadId: expectedThreadId || null,
                turnId: null,
                agentMessages: [],
                reviewMessages: [],
                tokenUsage: null,
                timer,
                resolve,
                reject
            };

            Promise.resolve()
                .then(startTurnFn)
                .then((started) => {
                    if (this.activeTurn && started) {
                        if (started.threadId) {
                            this.activeTurn.threadIds.add(started.threadId);
                            this.activeTurn.returnThreadId = started.threadId;
                        }
                        if (started.turnId) this.activeTurn.turnId = started.turnId;
                    }
                })
                .catch((err) => {
                    if (this.activeTurn) {
                        clearTimeout(this.activeTurn.timer);
                        this.activeTurn = null;
                        reject(err);
                    }
                });
        });
        result.elapsedMs = Date.now() - t0;
        return result;
    }

    async _dispatchOnThread({ threadId, prompt, cwd, model, defaultModel = '', effort, serviceTier, writable = false, timeoutMs = DEFAULT_TIMEOUT_MS }) {
        await this.ensureStarted();
        const workDir = path.resolve(cwd || process.cwd());
        const sandbox = writable ? 'workspace-write' : 'read-only';
        const resolvedModel = resolveModelArg(model, defaultModel);

        let tid = threadId ? resolveThreadId(threadId, workDir) : '';
        let activeModel = resolvedModel;
        let preTier = resolveServiceTierArg(serviceTier, resolvedModel);

        if (threadId) {
            if (!tid) {
                throw new Error('No thread_id provided and no previous Codex thread found for this workspace.');
            }
            const resumeRes = await this.request('thread/resume', {
                threadId: tid,
                cwd: workDir,
                sandbox,
                approvalPolicy: 'never',
                serviceTier: preTier,
                ...(resolvedModel ? { model: resolvedModel } : {})
            });
            activeModel = resolvedModel || resumeRes?.model || resumeRes?.thread?.model || '';
        } else {
            const threadRes = await this.request('thread/start', {
                cwd: workDir,
                sandbox,
                approvalPolicy: 'never',
                serviceTier: preTier,
                ...(resolvedModel ? { model: resolvedModel } : {}),
                ephemeral: false
            });
            tid = threadRes?.thread?.id;
            activeModel = threadRes?.model || threadRes?.thread?.model || resolvedModel;
        }
        if (!tid) throw new Error('Failed to obtain Codex thread');
        saveLastThread(workDir, tid);

        const resolvedEffort = resolveEffortArg(effort, activeModel);
        const resolvedTier = resolveServiceTierArg(serviceTier, activeModel);
        const res = await this._runTurn(tid, async () => {
            const turnRes = await this.request('turn/start', {
                threadId: tid,
                cwd: workDir,
                input: [{ type: 'text', text: prompt }],
                effort: resolvedEffort,
                serviceTier: resolvedTier,
                approvalPolicy: 'never'
            });
            return { threadId: tid, turnId: turnRes?.turn?.id };
        }, timeoutMs);
        res.model = activeModel;
        res.effort = resolvedEffort;
        res.serviceTier = resolvedTier;
        saveLastThread(workDir, res.threadId || tid);
        return res;
    }

    async explore({ prompt, cwd, model, effort, serviceTier, writable = false, timeoutMs = DEFAULT_TIMEOUT_MS }) {
        return this._dispatchOnThread({
            threadId: null,
            prompt,
            cwd,
            model,
            defaultModel: DEFAULT_EXPLORE_MODEL,
            effort,
            serviceTier,
            writable,
            timeoutMs
        });
    }

    async resume({ threadId, prompt, cwd, model, effort, serviceTier, writable = false, timeoutMs = DEFAULT_TIMEOUT_MS }) {
        return this._dispatchOnThread({
            threadId: threadId || 'last',
            prompt,
            cwd,
            model,
            defaultModel: '',
            effort,
            serviceTier,
            writable,
            timeoutMs
        });
    }

    async review({ target = 'uncommitted', branch, commit, instructions, threadId, cwd, model, effort, serviceTier, timeoutMs = DEFAULT_TIMEOUT_MS }) {
        const prompt = buildReviewPrompt({ target, branch, commit, instructions });
        const explicitThread = String(threadId || '').trim() || null;
        return this._dispatchOnThread({
            threadId: explicitThread,
            prompt,
            cwd,
            model,
            defaultModel: explicitThread ? '' : DEFAULT_REVIEW_MODEL,
            effort,
            serviceTier,
            writable: false,
            timeoutMs
        });
    }

    close() {
        if (this.rl) {
            try { this.rl.close(); } catch {}
            this.rl = null;
        }
        if (this.child && !this.child.killed) {
            const pid = this.child.pid;
            try { this.child.kill(); } catch {}
            if (process.platform === 'win32' && pid) {
                try {
                    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                } catch {}
            }
            this.child = null;
        }
    }
}

function formatTurnOutput(res) {
    const last = res.tokenUsage?.last;
    const modelStr = res.model ? ` | model=${res.model}` : '';
    const effortStr = res.effort ? ` | effort=${res.effort}` : '';
    const tierStr = res.serviceTier ? ` | tier=${res.serviceTier}` : '';
    const cacheStr = last && last.inputTokens > 0
        ? ` | last_input=${last.inputTokens}, cached=${last.cachedInputTokens} (${((last.cachedInputTokens / last.inputTokens) * 100).toFixed(1)}%), out=${last.outputTokens}`
        : '';
    const errPart = res.status !== 'completed' && res.error?.message
        ? `\n[status=${res.status}: ${res.error.message}]`
        : '';
    return [
        `[codex thread_id: ${res.threadId}${modelStr}${effortStr}${tierStr} | ${(res.elapsedMs / 1000).toFixed(1)}s${cacheStr}]`,
        res.answer || '(empty response)' + errPart
    ].join('\n\n');
}

const MCP_TOOLS = [
    {
        name: 'codex_explore',
        description: 'Start a new Codex session to explore/trace code or analyze architecture (read-only + gpt-6-luna + xhigh effort + default tier). Returns thread_id for follow-up via codex_resume.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Task or question for Codex (include file/module hints if helpful).' },
                cwd: { type: 'string', description: 'Absolute workspace directory path.' },
                effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Reasoning effort (default: medium for sol, xhigh for luna).' },
                serviceTier: { type: 'string', description: 'Service tier (default: default).' },
                model: { type: 'string', description: 'Optional model override (default: gpt-6-luna; e.g. gpt-6-luna, gpt-6.2-sol, gpt-6.1-terra).' },
                writable: { type: 'boolean', description: 'Allow workspace writes (default: false, strictly read-only).' }
            },
            required: ['prompt']
        }
    },
    {
        name: 'codex_resume',
        description: 'Continue an existing Codex thread by thread_id (or "last" for workspace latest), preserving full context and prompt cache.',
        inputSchema: {
            type: 'object',
            properties: {
                thread_id: { type: 'string', description: 'thread_id from a previous call, or "last".' },
                prompt: { type: 'string', description: 'Follow-up instruction or question.' },
                cwd: { type: 'string', description: 'Absolute workspace directory path.' },
                effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Reasoning effort (default: medium for sol, xhigh for luna).' },
                serviceTier: { type: 'string', description: 'Service tier (default: default).' },
                model: { type: 'string', description: 'Optional model override (keeps existing thread model if omitted).' },
                writable: { type: 'boolean', description: 'Allow workspace writes (default: false).' }
            },
            required: ['prompt']
        }
    },
    {
        name: 'codex_review',
        description: 'Run Codex native read-only code review (default: gpt-6.2-sol + medium effort + default tier; uncommitted changes, base branch diff, commit, or custom review instructions).',
        inputSchema: {
            type: 'object',
            properties: {
                target: { type: 'string', enum: ['uncommitted', 'branch', 'commit', 'custom'], description: 'What to review (default: uncommitted).' },
                cwd: { type: 'string', description: 'Absolute workspace directory path.' },
                effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Reasoning effort (default: medium for sol, xhigh for luna).' },
                serviceTier: { type: 'string', description: 'Service tier (default: default).' },
                model: { type: 'string', description: 'Optional model override (default: gpt-6.2-sol; e.g. gpt-6.2-sol, gpt-6-luna, gpt-6.1-terra).' },
                branch: { type: 'string', description: 'Base branch name when target="branch".' },
                commit: { type: 'string', description: 'Commit SHA when target="commit".' },
                instructions: { type: 'string', description: 'Custom review instructions when target="custom".' },
                thread_id: { type: 'string', description: 'Optional existing thread_id to review inside that context.' }
            }
        }
    },
    {
        name: 'codex_wait',
        description: 'Continue waiting for a running Codex job that exceeded the 150s MCP slice window (supports up to 1800s total runtime).',
        inputSchema: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'job_id from a running response, or "last" (default: "last").' },
                wait_seconds: { type: 'integer', description: 'Seconds to wait in this slice (default: 150, max: 165).' }
            }
        }
    }
];

class CodexClientPool {
    constructor(maxSize = MAX_CONCURRENT_JOBS) {
        this.maxSize = maxSize;
        this.idle = [];
        this.busy = new Set();
        this.starting = new Set();
        this.threadOwners = new Map(); // threadId -> client
        this.isClosed = false;
        this.prewarmPromise = null;
    }

    prewarm() {
        if (this.isClosed) return;
        const client = new CodexAppServerClient();
        this.prewarmPromise = (async () => {
            try {
                await client.ensureStarted();
                if (!this.isClosed) {
                    this.idle.push(client);
                } else {
                    client.close();
                }
            } catch {
                client.close();
            } finally {
                this.prewarmPromise = null;
            }
        })();
    }

    async acquire(targetThreadId = null) {
        if (this.isClosed) throw new Error('Codex client pool is closed');

        // 1. Thread affinity routing: route to the process that already loaded this thread
        if (targetThreadId) {
            const owner = this.threadOwners.get(targetThreadId);
            if (owner) {
                if (this.busy.has(owner) || this.starting.has(owner)) {
                    throw new Error(`Codex thread ${targetThreadId} is currently busy in another active turn. Please wait.`);
                }
                const idx = this.idle.indexOf(owner);
                if (idx !== -1) {
                    this.idle.splice(idx, 1);
                    if (owner.child && !owner.child.killed && owner.child.exitCode === null) {
                        this.busy.add(owner);
                        return owner;
                    }
                    this.threadOwners.delete(targetThreadId);
                    owner.close();
                }
            }
        }

        // 等待预热完成，避免初次并发启动时与预热进程互相排挤
        if (this.prewarmPromise && this.idle.length === 0) {
            try {
                await this.prewarmPromise;
            } catch {}
        }

        // 2. Reuse healthy idle client
        while (this.idle.length > 0) {
            const client = this.idle.pop();
            if (client.child && !client.child.killed && client.child.exitCode === null) {
                this.busy.add(client);
                return client;
            }
            this._cleanupClientThreads(client);
            client.close();
        }

        // 3. Concurrency limit check (counting busy + starting)
        if (this.busy.size + this.starting.size >= this.maxSize) {
            throw new Error(
                `Codex concurrency limit reached (max ${this.maxSize} concurrent tasks). Please wait for an active task to finish.`
            );
        }

        // 4. Start new client with slot reserved in starting set
        const client = new CodexAppServerClient();
        this.starting.add(client);
        try {
            await client.ensureStarted();
            this.starting.delete(client);
            if (this.isClosed) {
                client.close();
                throw new Error('Codex client pool was closed during startup');
            }
            this.busy.add(client);
            return client;
        } catch (err) {
            this.starting.delete(client);
            client.close();
            throw err;
        }
    }

    recordThreadOwner(threadId, client) {
        if (threadId && client) {
            this.threadOwners.set(threadId, client);
        }
    }

    _cleanupClientThreads(client) {
        for (const [tid, cl] of this.threadOwners.entries()) {
            if (cl === client) this.threadOwners.delete(tid);
        }
    }

    release(client, hasError = false) {
        this.busy.delete(client);
        if (this.isClosed || hasError) {
            this._cleanupClientThreads(client);
            client.close();
            return;
        }
        if (client.child && !client.child.killed && client.child.exitCode === null && !client.activeTurn) {
            this.idle.push(client);
        } else {
            this._cleanupClientThreads(client);
            client.close();
        }
    }

    close() {
        this.isClosed = true;
        for (const c of this.idle) c.close();
        for (const c of this.busy) c.close();
        for (const c of this.starting) c.close();
        this.idle = [];
        this.busy.clear();
        this.starting.clear();
        this.threadOwners.clear();
    }
}

function startMcpServer() {
    const pool = new CodexClientPool(MAX_CONCURRENT_JOBS);
    void pool.prewarm();

    const writeMsg = (obj) => process.stdout.write(JSON.stringify(obj) + '\n', 'utf8');
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const jobs = new Map();
    let latestJobId = null;
    let nextJobSeq = 1;

    const resolveWaitMs = (rawSeconds) => {
        if (rawSeconds === undefined || rawSeconds === null || rawSeconds === '') return MCP_SLICE_MS;
        const n = Number(rawSeconds);
        if (!Number.isFinite(n)) return MCP_SLICE_MS;
        return Math.max(1_000, Math.min(MAX_MCP_SLICE_MS, Math.round(n * 1000)));
    };

    const pruneOldJobs = () => {
        if (jobs.size <= MAX_JOB_HISTORY) return;
        for (const [id, job] of jobs) {
            if (jobs.size <= MAX_JOB_HISTORY) break;
            if (job.status !== 'running' && id !== latestJobId) {
                jobs.delete(id);
            }
        }
    };

    const startJob = (toolName, runFnWithClient, targetThreadId = null) => {
        const runningJobs = Array.from(jobs.values()).filter((j) => j.status === 'running');
        if (runningJobs.length >= MAX_CONCURRENT_JOBS) {
            throw new Error(
                `Codex concurrency limit reached (${runningJobs.length}/${MAX_CONCURRENT_JOBS} running). Call codex_wait or wait for an active task to finish.`
            );
        }
        const id = `job-${nextJobSeq++}-${Date.now().toString(36)}`;
        const job = {
            id,
            tool: toolName,
            startedAt: Date.now(),
            finishedAt: 0,
            status: 'running',
            result: null,
            error: null,
            threadId: targetThreadId || null,
            client: null,
            promise: null
        };
        jobs.set(id, job);
        latestJobId = id;
        pruneOldJobs();

        job.promise = (async () => {
            let client = null;
            let hadError = false;
            try {
                client = await pool.acquire(targetThreadId);
                job.client = client;
                const res = await runFnWithClient(client);
                job.status = 'completed';
                job.result = res;
                job.threadId = res?.threadId || job.threadId;
                if (job.threadId) {
                    pool.recordThreadOwner(job.threadId, client);
                }
                job.finishedAt = Date.now();
                return res;
            } catch (err) {
                hadError = true;
                job.status = 'error';
                job.error = err;
                job.finishedAt = Date.now();
                throw err;
            } finally {
                if (client) {
                    pool.release(client, hadError);
                }
            }
        })();

        return job;
    };

    const resolveJob = (rawJobId) => {
        const key = String(rawJobId || '').trim();
        if (!key || key.toLowerCase() === 'last') {
            if (latestJobId && jobs.get(latestJobId)?.status === 'running') {
                return jobs.get(latestJobId);
            }
            for (const j of Array.from(jobs.values()).reverse()) {
                if (j.status === 'running') return j;
            }
            return latestJobId ? jobs.get(latestJobId) || null : null;
        }
        return jobs.get(key) || null;
    };

    const waitForJob = (job, waitMs) => {
        if (job.status !== 'running') {
            return Promise.resolve({ done: true, job });
        }
        return new Promise((resolve) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                resolve({ done: false, job });
            }, waitMs);

            const onSettled = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ done: true, job });
            };

            job.promise.then(onSettled, onSettled);
        });
    };

    const formatJobOutcome = ({ done, job }) => {
        if (!done && job.status === 'running') {
            const elapsedSec = ((Date.now() - job.startedAt) / 1000).toFixed(1);
            const maxSec = Math.round(DEFAULT_TIMEOUT_MS / 1000);
            const tid = job.threadId || job.client?.activeTurn?.returnThreadId || 'pending';
            return {
                content: [{
                    type: 'text',
                    text: `[codex job_id: ${job.id} | status: running | elapsed: ${elapsedSec}s / ${maxSec}s | thread_id: ${tid}]\n\nCodex is still running in the background. Call \`codex_wait\` with \`job_id: "${job.id}"\` to continue waiting (up to ${Math.round(MCP_SLICE_MS / 1000)}s per slice, ${maxSec}s total).`
                }],
                isError: false
            };
        }
        if (job.status === 'error') {
            throw job.error || new Error('Codex job failed');
        }
        return {
            content: [{ type: 'text', text: formatTurnOutput(job.result) }],
            isError: job.result.status !== 'completed'
        };
    };

    const handleRequest = async (req) => {
        const { id, method, params } = req;
        if (id === undefined) return; // notification (e.g. notifications/initialized)

        try {
            if (method === 'initialize') {
                writeMsg({
                    jsonrpc: '2.0',
                    id,
                    result: {
                        protocolVersion: params?.protocolVersion || '2024-11-05',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'codex-bridge', version: '1.0.0' }
                    }
                });
            } else if (method === 'ping') {
                writeMsg({ jsonrpc: '2.0', id, result: {} });
            } else if (method === 'tools/list') {
                writeMsg({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
            } else if (method === 'tools/call') {
                const name = params?.name;
                const args = params?.arguments || {};
                const waitMs = resolveWaitMs(args.wait_seconds);
                let outcome;
                if (name === 'codex_explore' || name === 'codex_ask') {
                    const job = startJob(name, (cl) => cl.explore(args));
                    outcome = await waitForJob(job, waitMs);
                } else if (name === 'codex_resume') {
                    const tid = resolveThreadId(args.thread_id, args.cwd);
                    const job = startJob(name, (cl) => cl.resume({ ...args, threadId: tid }), tid);
                    outcome = await waitForJob(job, waitMs);
                } else if (name === 'codex_review') {
                    const tid = args.thread_id ? resolveThreadId(args.thread_id, args.cwd) : null;
                    const job = startJob(name, (cl) => cl.review({ ...args, threadId: tid }), tid);
                    outcome = await waitForJob(job, waitMs);
                } else if (name === 'codex_wait') {
                    const job = resolveJob(args.job_id);
                    if (!job) {
                        throw new Error(
                            args.job_id
                                ? `No Codex job found for job_id="${args.job_id}".`
                                : 'No active or recent Codex job found to wait on.'
                        );
                    }
                    outcome = await waitForJob(job, waitMs);
                } else {
                    writeMsg({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
                    return;
                }
                writeMsg({
                    jsonrpc: '2.0',
                    id,
                    result: formatJobOutcome(outcome)
                });
            } else {
                writeMsg({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
            }
        } catch (err) {
            if (method === 'tools/call') {
                writeMsg({
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [{ type: 'text', text: `Codex bridge error: ${err?.message || String(err)}` }],
                        isError: true
                    }
                });
            } else {
                writeMsg({ jsonrpc: '2.0', id, error: { code: -32603, message: err?.message || String(err) } });
            }
        }
    };

    rl.on('line', (line) => {
        const trimmed = String(line || '').trim();
        if (!trimmed) return;
        let msg;
        try {
            msg = JSON.parse(trimmed);
        } catch {
            return;
        }
        void handleRequest(msg).catch(() => {});
    });

    const shutdown = () => {
        pool.close();
        process.exit(0);
    };
    rl.on('close', shutdown);
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

const CLI_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCliArgs(argv) {
    const sub = argv[0];
    const opts = { cwd: process.cwd(), effort: undefined, serviceTier: undefined, writable: false, target: 'uncommitted', threadId: 'last', _explicitThread: false };
    const rest = [];
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--cwd' || a === '-C') opts.cwd = argv[++i];
        else if (a === '--thread' || a === '-t') { opts.threadId = argv[++i]; opts._explicitThread = true; }
        else if (a === '--effort' || a === '-e') opts.effort = argv[++i];
        else if (a === '--tier') opts.serviceTier = argv[++i];
        else if (a === '--model' || a === '-m') opts.model = argv[++i];
        else if (a === '--target') opts.target = argv[++i];
        else if (a === '--branch') opts.branch = argv[++i];
        else if (a === '--commit') opts.commit = argv[++i];
        else if (a === '--writable') opts.writable = true;
        else rest.push(a);
    }
    if (sub === 'resume' && !opts._explicitThread && rest.length > 0 && (CLI_UUID_RE.test(rest[0]) || rest[0].toLowerCase() === 'last')) {
        opts.threadId = rest.shift();
    }
    const text = rest.join(' ').trim();
    return { sub, opts, text };
}

async function runCli(client, argv) {
    const { sub, opts, text } = parseCliArgs(argv);
    try {
        let res;
        if (sub === 'explore' || sub === 'ask') {
            if (!text) throw new Error('Usage: codex_bridge.mjs explore [-C dir] [-e low|medium|high|max] "<prompt>"');
            res = await client.explore({ ...opts, prompt: text });
        } else if (sub === 'resume') {
            if (!text) throw new Error('Usage: codex_bridge.mjs resume [-t <id>|last] [-C dir] "<prompt>"');
            res = await client.resume({ ...opts, prompt: text });
        } else if (sub === 'review') {
            res = await client.review({ ...opts, instructions: text || opts.instructions, threadId: opts.threadId === 'last' ? undefined : opts.threadId });
        } else {
            throw new Error(`Unknown command: ${sub}. Expected explore | resume | review`);
        }
        process.stdout.write(formatTurnOutput(res) + '\n', 'utf8');
        client.close();
        process.exit(res.status === 'completed' ? 0 : 1);
    } catch (err) {
        process.stderr.write(`Error: ${err?.message || String(err)}\n`, 'utf8');
        client.close();
        process.exit(1);
    }
}

const subcmd = process.argv[2];
if (subcmd && ['explore', 'ask', 'resume', 'review'].includes(subcmd)) {
    const client = new CodexAppServerClient();
    void runCli(client, process.argv.slice(2));
} else {
    startMcpServer();
}
