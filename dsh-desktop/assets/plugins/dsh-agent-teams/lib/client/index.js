// 此文件为源码副本，发布 bundle 以 lib/client.js 为准，改动需双同步。
import { jsx as _jsx } from "react/jsx-runtime";
import { ActivityPanel } from "./ActivityPanel.js";
import { AgentTeamsCard } from "./AgentTeamsCard.js";
import { agentTeamsCardDefinition } from "./agent-teams-card-definition.js";
import { AGENT_TEAMS_LOCALE_NAMESPACE, en, zh, } from "./locales.js";
import { openAgentTeamMember } from "./session-navigation.js";
/** Required services: conversation nodes, slots, sessions navigation, and locale. */
// EAC 适配（与 lib/client.js 保持一致）：rc.2 的顶层服务 conversationEvents
// 在 alpha.1 已并入 uiConversation 服务（.events = ConversationEventRegistry，
// 契约与原版一致），故 inject 改为 uiConversation、注册处走双解析。
export const inject = ['uiConversation', 'slots', 'sessions', 'locale'];
/** The replayed user message is the canonical transcript entry. */
function HiddenAgentTeamsCommand() {
    return null;
}
/**
 * Register the activity monitor in the shell's additive overlay and the
 * in-conversation team card. The card's activity button re-opens a folded
 * monitor via a window event — the recovery path for an old session.
 */
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(AGENT_TEAMS_LOCALE_NAMESPACE, { zh, en }), 'agent-teams: dictionaries');
    const openMember = (parentId, childId) => {
        void openAgentTeamMember(ctx.sessions, parentId, childId).catch((error) => {
            console.warn(`agent-teams: failed to open member transcript ${childId}: ${String(error)}`);
        });
    };
    const Panel = ({ t }) => (_jsx(ActivityPanel, { sessionsList: ctx.sessions.list, openMember: openMember, t: t }));
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'agent-teams-activity',
        order: 80,
        label: 'AgentTeams activity',
        locale: AGENT_TEAMS_LOCALE_NAMESPACE,
    }, Panel));
    // The host command is only the slash-menu/admission surface. Its input is
    // replayed as the visible user message, so the generic result row would be
    // a duplicate placed before that message by command lifecycle ordering.
    ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
        name: 'conversation.chat.commandview',
        key: 'agent-teams',
    }, HiddenAgentTeamsCommand));
    // 事件注册表双解析（与 lib/client.js 同款）：优先 uiConversation.events，
    // 旧宿主回退顶层 conversationEvents；两者皆缺时降级禁用团队卡并告警，
    // 不让插件崩溃。
    const conversationEvents = (ctx.uiConversation && ctx.uiConversation.events)
        ? ctx.uiConversation.events
        : ctx.conversationEvents;
    if (conversationEvents && typeof conversationEvents.register === 'function') {
        conversationEvents.register(agentTeamsCardDefinition);
    }
    else {
        console.warn('agent-teams: conversation definition registry unavailable; team card disabled');
    }
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'agent-teams',
        locale: AGENT_TEAMS_LOCALE_NAMESPACE,
        inject: () => ({
            openMember,
        }),
    }, AgentTeamsCard));
}
