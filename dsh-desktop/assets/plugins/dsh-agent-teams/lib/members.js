/**
 * Member subagent lifecycle: spawn a continuable child per member, deliver
 * messages into its FIFO inbox, and observe its activity.
 *
 * Members are durable continuable subagents of the captain, so a member keeps
 * its conversation across turns and across harness restarts: the captain
 * wakes it with {@link ctx.subagents.sendMessage}（0.1.3 起取代 followup）,
 * it works through its turn (updating team state through the
 * `agent_teams_*` tools), and becomes idle again. Its final assistant message
 * is not readable programmatically, so the member persists its report into
 * the captain's mailbox and the task records, which the captain reads
 * through `agent_teams_status`.
 * @module dsh-agent-teams/members
 */
// Declaration merge only: makes ctx.subagents visible.
import { SubagentError } from '@deepseek-ai/dsh-subagent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { join } from 'node:path';
import { readRetiredMemberIds } from "./state.js";
/** Captain-only AgentTeams tools hidden from newly spawned members. */
const MEMBER_DENIED_TOOLS = [
    'agent_teams_create',
    'agent_teams_add_member',
    'agent_teams_remove_member',
    'agent_teams_reassign_task',
    'agent_teams_create_task',
    'agent_teams_delete',
];
/**
 * Restore the SessionId brand on a value that round-tripped through the
 * durable team file. The brand is erased by JSON serialization; the value
 * originated from `startContinuable`/`agent.id`, so this cast is the boundary
 * restoration, not a new assertion.
 */
function brandedSessionId(value) {
    return value;
}
const MEMBER_LABEL_PREFIX = 'agent-teams:';
function pendingSelectionKey(parentSessionId, label) {
    return `${parentSessionId}\u0000${label}`;
}
/**
 * Resolve one member's complete model selection. Ordinary members snapshot the
 * captain's current request route and reasoning effort. When provider or model
 * changes, effort is intentionally omitted so the target model materializes
 * its own default instead of receiving an adapter-owned id from another route.
 * An explicit effort overrides either policy; the sentinel "default" also
 * selects the target model's default. The final effort is validated against
 * the target model before a child is created.
 */
export async function resolveMemberLlmSelection(ctx, captain, request, signal) {
    const explicitProvider = request.provider?.trim();
    const explicitModel = request.model?.trim();
    const defaultModel = request.defaultModel?.trim();
    const explicitEffort = request.reasoningEffort?.trim();
    if (request.provider !== undefined && explicitProvider === '') {
        throw new Error('member LLM provider must not be empty');
    }
    if (request.model !== undefined && explicitModel === '') {
        throw new Error('member model must not be empty');
    }
    if (request.defaultModel !== undefined && defaultModel === '') {
        throw new Error('configured memberModel must not be empty');
    }
    if (request.reasoningEffort !== undefined && explicitEffort === '') {
        throw new Error('member reasoning effort must not be empty');
    }
    if (explicitProvider !== undefined && explicitModel === undefined) {
        throw new Error('an explicit member LLM provider requires an explicit member model');
    }
    const current = captain.session.requestHeader()?.config;
    const currentProvider = current?.provider ?? captain.options.provider;
    const currentModel = current?.model ?? captain.options.model;
    const provider = explicitProvider ?? currentProvider;
    const model = explicitModel ?? defaultModel ?? currentModel;
    if (provider === undefined || model === undefined) {
        throw new Error('cannot resolve the member LLM route from the current captain session');
    }
    // Effort ids belong to one exact provider/model capability. Preserve the
    // captain's effort only on the same route; a changed route must resolve its
    // own default. Explicit effort still wins, while "default" forces that
    // target-default behavior even when the route did not change.
    const sameRoute = provider === currentProvider && model === currentModel;
    const reasoningEffort = explicitEffort === undefined
        ? sameRoute
            ? current?.reasoningEffort
            : undefined
        : explicitEffort === 'default'
            ? undefined
            : ReasoningEffortId(explicitEffort);
    const resolved = await ctx.llm.resolveCallConfig({
        provider,
        model,
        ...reasoningEffort === undefined
            ? {}
            : { reasoningEffort },
    }, signal);
    return {
        provider: resolved.provider,
        model: resolved.model,
        ...resolved.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: String(resolved.reasoningEffort) },
    };
}
/**
 * Install the member selection bridge for fresh continuable children.
 * 内核 0.1.3：SubagentService.registerContinuableSetup 被移除 —— 生命周期由
 * SessionHandle/continuation manager 接管。路由还原拆成两半：
 *   · 新建成员：spawnMember 已把 agentOptions {provider, model,
 *     reasoningEffort} 随 startContinuable 请求直传（0.1.3 的
 *     resolveChildAgentOptions 原生合并），无需 per-child 钩子；
 *   · 冷恢复成员：路由持久化在 subagent descriptor 里，内核
 *     parentAgentOptionsForDelegation/applyChildComposition 原生恢复
 *     （spawnMember 的 descriptor 一致性检查仍由
 *     withPending 内的一致校验承担）。
 * 本函数降级为「pending 路由表」持有者：withPending 语义不变（新建时
 * 校验 route 一致、结束后清理），不再向内核登记任何 setup 回调。
 * Legacy members without a complete saved route retain Harness's
 * descriptor provider/model behavior.
 */
export function installMemberSelectionRuntime(ctx, stateDir) {
    const pending = new Map();
    return {
        async withPending(parentSessionId, label, selection, operation) {
            const key = pendingSelectionKey(parentSessionId, label);
            if (pending.has(key)) {
                throw new Error(`member model selection is already pending for "${label}"`);
            }
            pending.set(key, selection);
            try {
                return await operation();
            }
            finally {
                pending.delete(key);
            }
        },
    };
}
/**
 * The member's system prompt (persona), shadowing the deployment persona for
 * that child. Self-contained: it replaces the whole persona section.
 * @param team - the team the member joined.
 * @param member - the member record (name/role are read before spawning).
 * @param stateDir - configured state directory, so the member can locate the
 *   team files with its own file tools.
 */
export function memberPersona(team, member, stateDir) {
    return `You are ${member.name}, a member of the multi-agent team "${team.name}" running inside DeepSeek Harness AgentTeams. The captain leads the team; you are a worker member${member.role ? ` with the role: ${member.role}` : ''}.

Team context:
- Team id: ${team.id}
- Your name inside the team (use it as \`from\`/identity): ${member.name}
- The team state lives under ${stateDir}/${team.id}/ (team.json and inbox/*.jsonl). You may inspect these files read-only for diagnostics, but never edit them directly; use the agent_teams_* tools so JSON escaping and concurrent updates stay safe.
- The captain and your teammates reach you through messages. Each message you receive is a new turn: act on it and end your turn with a concise reply.

Working rules:
1. When you receive a task assignment, call agent_teams_claim_task with the task id. Keep the returned attempt_id: include it in every agent_teams_update_task call for that execution attempt. Then mark the task in_progress.
2. Work thoroughly with your available tools; do not cut corners.
3. When finished, call agent_teams_update_task with the same attempt_id, status=completed, and a concise \`output\` summarizing what you did and the key results. A stale-attempt rejection means the captain reassigned or took over the task; stop touching that task and wait for new work.
4. Send a short report to the captain with agent_teams_send_message (to=captain) when you complete a task or hit a blocker.
5. To ask a teammate something, use agent_teams_send_message with to=<teammate name>; the message lands in their mailbox and wakes them directly — teammates talk to each other without the captain in the loop. The same applies to the captain (to=captain).
6. After your turn becomes idle, the shared task scheduler may assign your next ready task automatically. Never claim a second task while you still own unfinished work.
7. You are a worker: do not create or delete teams, reassign tasks, or add/remove members — that is the captain's job.`;
}
/**
 * The initial user message delivered when the member is created.
 * @param team - the team the member joined.
 */
export function memberWelcome(team) {
    return `You have joined the team "${team.name}" as a member. The captain will send you tasks and messages; wait for instructions. Current team status: ${team.tasks.length} task(s), none assigned to you yet.`;
}
/**
 * Spawn one member as a durable continuable subagent of the captain and fill
 * `member.id` with its child session id. On failure nothing is persisted.
 * @param ctx - the plugin context (injects `subagents`).
 * @param config - member runtime knobs.
 * @param selections - fresh/cold child model-selection bridge.
 * @param llmSelection - resolved provider/model/reasoning snapshot.
 * @param captain - the exact live captain agent (the calling agent).
 * @param team - the team record (read-only here).
 * @param member - the member draft whose `id` is filled on success.
 * @param stateDir - configured state directory (for the persona).
 * @param signal - caller cancellation, forwarded to the start.
 */
export async function spawnMember(ctx, config, selections, llmSelection, captain, team, member, stateDir, signal) {
    // Fail loud at the first use: provider registration is a sibling plugin's
    // effect and may settle after this plugin mounts. Capability checks here
    // mirror what startContinuable would reject, with an actionable error.
    const provider = ctx.subagents.getProvider(config.provider);
    if (provider === undefined) {
        throw new Error(`agent-teams: no subagent provider "${config.provider}" is registered (available: ${ctx.subagents.list().join(', ') || 'none'}) — `
            + 'check that the subagent provider row (e.g. subagent-spawn) is mounted in the composition');
    }
    if (provider.prepareContinuable === undefined) {
        throw new Error(`agent-teams: provider "${config.provider}" does not support continuable members`);
    }
    if (!provider.capabilities.persona) {
        throw new Error(`agent-teams: provider "${config.provider}" cannot apply a member persona`);
    }
    if (!provider.capabilities.toolFilter) {
        throw new Error(`agent-teams: provider "${config.provider}" cannot restrict captain-only tools for members`);
    }
    const label = `${MEMBER_LABEL_PREFIX}${team.id}:${member.name}`;
    const start = await selections.withPending(captain.id, label, llmSelection, () => (ctx.subagents.startContinuable({
        provider: config.provider,
        label,
        request: {
            prompt: [{ type: 'text', text: memberWelcome(team) }],
            parent: captain,
            persona: memberPersona(team, member, stateDir),
            toolFilter: { deny: [...MEMBER_DENIED_TOOLS] },
            agentOptions: {
                provider: llmSelection.provider,
                model: llmSelection.model,
            },
            ...config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {},
        },
        signal,
    })));
    member.id = start.childId;
}
/**
 * Deliver one message to a member as its next FIFO turn. Best effort: a
 * failure (member gone or not continuable) is logged and reported as `false`
 * so the caller can decide (mailbox delivery still happened).
 *
 * Any team sender can route through this helper: the captain is the direct
 * parent of every member, and the caller passes the captain's live Agent
 * (its own when the captain calls, the registry-resolved one when a member
 * sends) — mirroring the Claude Code mailbox model where the writer writes
 * the target's inbox and the target picks it up on its own.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captain - the exact live captain agent (the member's direct parent).
 * @param childId - the member's durable child session id.
 * @param text - the message content.
 * @param signal - caller cancellation, forwarded to the delivery.
 * @returns whether the member inbox accepted the message.
 */
export async function deliverToMember(ctx, captain, childId, text, signal) {
    try {
        // 内核 0.1.3：SubagentService.followup(parent,…) 已被 sendMessage(sender,…)
        // 取代 —— 发送方改为 captain Agent 本身（而非「以 captain 之名投递」），
        // options 只收 {signal}（source 归因内置为发送方 Agent，不再接受
        // host-provenance 字段）。投递语义不变：运行中成员在最近步边界
        // steer，空闲成员开新轮。
        await ctx.subagents.sendMessage(captain, brandedSessionId(childId), [{ type: 'text', text }], {
            signal,
        });
        return true;
    }
    catch (error) {
        ctx.logger.warn(`agent-teams: sendMessage to member ${childId} failed: ${String(error)}`);
        return false;
    }
}
/**
 * Request cancellation of one live member's current turn. Best effort, fire
 * and return; the target may keep running until it observes the signal.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captain - the exact live captain agent (the member's parent).
 * @param childId - the member's durable child session id.
 */
export function interruptMember(ctx, captain, childId) {
    try {
        ctx.subagents.interrupt(brandedSessionId(childId), { kind: 'ancestor', agent: captain });
    }
    catch (error) {
        ctx.logger.warn(`agent-teams: interrupt of member ${childId} failed: ${String(error)}`);
    }
}
/**
 * Install the missing per-child retirement boundary above Harness rc.6.
 *
 * Upstream `interrupt()` deliberately preserves continuable sessions and the
 * upstream seam exposes no targeted forget/retire method. The durable
 * AgentTeams index therefore rejects member delivery before it can cold-resume
 * a retired member. Catalog rows deliberately remain discoverable: Harness rc.8
 * uses the direct-child catalog to authorize historical transcript reads and
 * `openSubagent()`, so filtering those rows would make an archived member's
 * persisted conversation inaccessible. Exact ids keep unrelated subagents
 * untouched while the delivery boundary still prevents further model turns.
 */
export function installRetiredMemberGuard(ctx, stateDir) {
    const runtime = ctx.subagents;
    ctx.effect(() => {
        // 内核 0.1.3：guard 锚点从 followup(parent,…) 迁到 sendMessage(sender,…)。
        // 成员会话的 cwd 记录在 sender 的 session header 里不可靠（sendMessage
        // 的 sender 是 captain），retired 名册按 team stateDir 读取（调用方
        // 传入的 stateDir 即 team 目录）。
        const sendMessage = runtime.sendMessage;
        const guardedSend = async (sender, targetId, content, options) => {
            const retired = await readRetiredMemberIds(join(sender.session.header.cwd ?? process.cwd(), stateDir));
            if (retired.has(targetId)) {
                throw new SubagentError(`AgentTeams member "${targetId}" was retired and cannot be resumed`, 'NOT_RESUMABLE');
            }
            return sendMessage.call(runtime, sender, targetId, content, options);
        };
        runtime.sendMessage = guardedSend;
        return () => {
            if (runtime.sendMessage === guardedSend)
                runtime.sendMessage = sendMessage;
        };
    }, 'agent-teams: retired member guard');
}
/**
 * Snapshot the real driver activity for durable member ids.
 *
 * The team record is the membership authority, so this path intentionally no
 * longer depends on `listChildren()`'s versioned projection shape. Harness
 * rc.8 changed those rows to branded `SessionId` values plus residency-only
 * `activity`; neither is needed to answer whether the live Agent driver is
 * running, idle, or absent/ready.
 * @param ctx - the plugin context (injects `agents`).
 * @param memberIds - child ids restored from the durable team record.
 * @returns child id → live activity.
 */
export function memberActivity(ctx, memberIds) {
    const activity = new Map();
    for (const id of memberIds) {
        if (id === '')
            continue;
        const live = ctx.agents.get(brandedSessionId(id));
        activity.set(id, live === undefined ? 'ready' : live.status);
    }
    return activity;
}
