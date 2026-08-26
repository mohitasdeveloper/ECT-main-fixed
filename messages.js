// messages.js
// Direct messages — text only, restricted to accepted connections.
// Realtime delivery + read receipts via Supabase.

import { supabase } from './supabase.js';
import { showToast } from './ui.js';
import { getAcceptedConnections, invalidateConnectionsCache } from './data-layer.js';

let myProfile = null;
let threadsCache = [];        // [{ user, lastMessage, unreadCount }]
let acceptedConnections = []; // full connections list, used by the "New Message" picker
let activeChat = null;        // { userId, name, avatar, tick }
let chatMessages = [];        // messages in the currently open conversation
let inboxChannel = null;
let chatChannel = null;
let sendInFlight = false;

const THREAD_SKELETON = `
    <div class="flex items-center gap-3.5 p-2.5 mb-1 animate-pulse">
        <div class="w-14 h-14 rounded-full shimmer-bg shrink-0"></div>
        <div class="flex-1">
            <div class="h-3.5 shimmer-bg rounded-md w-1/3 mb-2.5"></div>
            <div class="h-3 shimmer-bg rounded-md w-2/3"></div>
        </div>
    </div>
`.repeat(6);

export function initMessages(profile) {
    myProfile = profile;
    if (!myProfile) return;

    setupComposer();
    subscribeInbox();

    // Load the inbox immediately (not just on first tab open) so the nav badge
    // reflects unread messages right away, Instagram-style.
    fetchInbox();
}

// ==========================================
// Small helpers
// ==========================================
function avatarFallback(name) {
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(name || 'User')}&background=e1e3e4`;
}
function optAvatar(url) {
    return (typeof window.optimizeImageUrl === 'function') ? window.optimizeImageUrl(url, 'avatar') : url;
}
function tickHtml(type) {
    return (typeof window.getTickHtml === 'function') ? window.getTickHtml(type) : '';
}
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}
function timeShort(dateStr) {
    const d = new Date(dateStr);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
function dayLabel(dateStr) {
    const d = new Date(dateStr);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString([], sameYear ? { weekday: 'long', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

// ==========================================
// Connections (only people you can message)
// ==========================================
async function fetchAcceptedConnections() {
    if (!myProfile) return [];
    try {
        // OPTIMIZED: Use data-layer with caching (15 min TTL)
        return await getAcceptedConnections(myProfile.id);
    } catch (error) {
        console.error('Error loading connections for messages:', error);
        return [];
    }
}

// ==========================================
// Inbox (thread list)
// ==========================================
async function fetchInbox() {
    const container = document.getElementById('messages-inbox-container');
    if (!container || !myProfile) return;
    if (threadsCache.length === 0) container.innerHTML = THREAD_SKELETON;

    try {
        const [{ data: msgs, error: msgErr }, connections] = await Promise.all([
            supabase.from('messages')
                .select('id, sender_id, receiver_id, content, is_read, created_at')
                .or(`sender_id.eq.${myProfile.id},receiver_id.eq.${myProfile.id}`)
                .order('created_at', { ascending: false })
                .limit(300),
            fetchAcceptedConnections()
        ]);
        if (msgErr) throw msgErr;

        acceptedConnections = connections;
        const connectionMap = new Map(connections.map(u => [u.id, u]));

        const byPartner = new Map();
        for (const m of (msgs || [])) {
            const partnerId = m.sender_id === myProfile.id ? m.receiver_id : m.sender_id;
            if (!byPartner.has(partnerId)) byPartner.set(partnerId, { lastMessage: m, unreadCount: 0 });
            if (m.receiver_id === myProfile.id && !m.is_read) byPartner.get(partnerId).unreadCount++;
        }

        threadsCache = Array.from(byPartner.entries())
            .map(([partnerId, info]) => ({ user: connectionMap.get(partnerId), ...info }))
            .filter(t => t.user) // hide threads with people who are no longer connections
            .sort((a, b) => new Date(b.lastMessage.created_at) - new Date(a.lastMessage.created_at));

        renderInbox();
        updateNavBadge();
    } catch (error) {
        console.error('Error loading inbox:', error);
        container.innerHTML = `<p class="text-sm italic text-center py-8 text-error">Failed to load messages.</p>`;
    }
}

function renderInbox() {
    const container = document.getElementById('messages-inbox-container');
    if (!container) return;

    if (threadsCache.length === 0) {
        const hasConnections = acceptedConnections.length > 0;
        container.innerHTML = `
            <div class="py-14 flex flex-col items-center justify-center text-center px-6">
                <span class="material-symbols-outlined text-[46px] mb-3 opacity-30 text-on-surface-variant">forum</span>
                <p class="font-bold text-[15px] text-on-surface dark:text-gray-100 mb-1">No messages yet</p>
                <p class="text-[13px] text-on-surface-variant dark:text-gray-500 mb-5 leading-relaxed max-w-[220px]">${hasConnections ? 'Start a conversation with one of your connections.' : 'Connect with people first, then start chatting with them here.'}</p>
                ${hasConnections ? `<button onclick="window.openNewMessagePanel()" class="btn-primary px-6"><span class="material-symbols-outlined text-[18px]">edit_square</span> New Message</button>` : ''}
            </div>`;
        return;
    }

    container.innerHTML = threadsCache.map(t => {
        const u = t.user;
        const fallback = `this.onerror=null; this.src='${avatarFallback(u.full_name)}';`;
        const av = optAvatar(u.profile_img_url) || avatarFallback(u.full_name);
        const mine = t.lastMessage.sender_id === myProfile.id;
        const preview = `${mine ? 'You: ' : ''}${escapeHtml(t.lastMessage.content).slice(0, 60)}`;
        const unread = t.unreadCount > 0;

        return `
        <div onclick="window.openConversation('${u.id}')" class="flex items-center gap-3.5 p-2.5 rounded-2xl cursor-pointer active:scale-[0.98] hover:bg-surface-variant/20 dark:hover:bg-neutral-800/50 transition-all">
            <img loading="lazy" src="${av}" onerror="${fallback}" class="w-14 h-14 rounded-full object-cover border border-surface-variant/50 shrink-0">
            <div class="flex-1 min-w-0">
                <p class="font-bold text-[14.5px] text-on-surface dark:text-gray-100 truncate flex items-center gap-1">${escapeHtml(u.full_name)} ${tickHtml(u.tick_type)}</p>
                <p class="text-[13px] ${unread ? 'text-on-surface dark:text-gray-200 font-semibold' : 'text-on-surface-variant dark:text-gray-500'} truncate mt-0.5">${preview}</p>
            </div>
            <div class="flex flex-col items-end gap-1.5 shrink-0">
                <span class="text-[11px] ${unread ? 'text-primary font-bold' : 'text-on-surface-variant dark:text-gray-500'}">${timeShort(t.lastMessage.created_at)}</span>
                ${unread ? `<span class="w-2.5 h-2.5 rounded-full bg-primary"></span>` : ''}
            </div>
        </div>`;
    }).join('');
}

function updateNavBadge() {
    const badge = document.getElementById('msg-nav-badge');
    if (!badge) return;
    const hasUnread = threadsCache.some(t => t.unreadCount > 0);
    badge.classList.toggle('hidden', !hasUnread);
}

// ==========================================
// "New Message" picker (connections only)
// ==========================================
window.openNewMessagePanel = async function () {
    const modal = document.getElementById('modal-new-message');
    if (!modal) return;
    modal.classList.replace('hidden', 'flex');
    setTimeout(() => modal.classList.remove('translate-x-full'), 10);

    const list = document.getElementById('new-message-list');
    const search = document.getElementById('new-message-search');
    search.value = '';
    list.innerHTML = THREAD_SKELETON;

    if (!acceptedConnections.length) acceptedConnections = await fetchAcceptedConnections();
    renderNewMessageList(acceptedConnections);

    search.oninput = (e) => {
        const q = e.target.value.toLowerCase().trim();
        const filtered = acceptedConnections.filter(u => u.full_name.toLowerCase().includes(q));
        renderNewMessageList(filtered, q !== '');
    };
};

window.closeNewMessagePanel = function () {
    const modal = document.getElementById('modal-new-message');
    if (!modal) return;
    modal.classList.add('translate-x-full');
    setTimeout(() => modal.classList.replace('flex', 'hidden'), 300);
};

function renderNewMessageList(users, isSearch = false) {
    const list = document.getElementById('new-message-list');
    if (!list) return;

    if (users.length === 0) {
        list.innerHTML = `<div class="py-16 flex flex-col items-center justify-center opacity-40 text-on-surface-variant"><span class="material-symbols-outlined text-[42px] mb-2">group_off</span><p class="text-sm font-semibold">${isSearch ? 'No connections found.' : 'No connections yet.'}</p></div>`;
        return;
    }

    list.innerHTML = users.map(u => {
        const fallback = `this.onerror=null; this.src='${avatarFallback(u.full_name)}';`;
        const av = optAvatar(u.profile_img_url) || avatarFallback(u.full_name);
        return `
        <div onclick="window.closeNewMessagePanel(); setTimeout(() => window.openConversation('${u.id}'), 220);" class="flex items-center gap-3.5 p-3 hover:bg-surface-variant/20 dark:hover:bg-neutral-800/50 rounded-2xl cursor-pointer active:scale-[0.98] transition-all">
            <img loading="lazy" src="${av}" onerror="${fallback}" class="w-12 h-12 rounded-full object-cover border border-surface-variant/50 shrink-0">
            <div class="flex-1 min-w-0">
                <p class="font-bold text-[14.5px] text-on-surface dark:text-gray-100 truncate flex items-center gap-1">${escapeHtml(u.full_name)} ${tickHtml(u.tick_type)}</p>
                <p class="text-[12px] font-medium text-on-surface-variant dark:text-gray-500 mt-0.5 truncate">${escapeHtml(u.course) || 'Student'}</p>
            </div>
        </div>`;
    }).join('');
}

// ==========================================
// Conversation panel
// ==========================================
window.openConversation = async function (userId) {
    let partner = acceptedConnections.find(u => u.id === userId)
        || (threadsCache.find(t => t.user.id === userId) || {}).user;

    if (!partner) {
        const { data } = await supabase.from('users').select('id, full_name, profile_img_url, course, tick_type').eq('id', userId).single();
        partner = data;
    }
    if (!partner) { showToast("Couldn't open this conversation.", 'error'); return; }

    activeChat = { userId: partner.id, name: partner.full_name };

    const modal = document.getElementById('modal-chat-conversation');
    modal.classList.replace('hidden', 'flex');
    setTimeout(() => modal.classList.remove('translate-x-full'), 10);

    const headerAvatar = document.getElementById('chat-header-avatar');
    headerAvatar.src = optAvatar(partner.profile_img_url) || avatarFallback(partner.full_name);
    headerAvatar.onerror = function () { this.onerror = null; this.src = avatarFallback(partner.full_name); };
    document.getElementById('chat-header-name').innerHTML = `${escapeHtml(partner.full_name)} ${tickHtml(partner.tick_type)}`;

    const container = document.getElementById('chat-messages-container');
    container.innerHTML = `<div class="flex-1 flex items-center justify-center py-10"><div class="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin"></div></div>`;

    const input = document.getElementById('chat-composer-input');
    input.value = '';
    input.style.height = 'auto';
    updateSendButtonState();

    await loadConversation(partner.id);
    subscribeChat(partner.id);

    setTimeout(() => input.focus({ preventScroll: true }), 350);
};

window.closeConversation = function () {
    const modal = document.getElementById('modal-chat-conversation');
    if (!modal || modal.classList.contains('translate-x-full')) return;
    modal.classList.add('translate-x-full');
    setTimeout(() => modal.classList.replace('flex', 'hidden'), 300);
    document.getElementById('chat-composer-input')?.blur();
    unsubscribeChat();
    activeChat = null;
    chatMessages = [];
    fetchInbox(); // refresh previews / unread state now that the chat was seen
};

window.viewChatPartnerProfile = function () {
    if (!activeChat) return;
    const id = activeChat.userId;
    window.closeConversation();
    setTimeout(() => { if (typeof window.viewUserProfile === 'function') window.viewUserProfile(id); }, 260);
};

async function loadConversation(partnerId) {
    try {
        const { data, error } = await supabase
            .from('messages')
            .select('id, sender_id, receiver_id, content, is_read, created_at')
            .or(`and(sender_id.eq.${myProfile.id},receiver_id.eq.${partnerId}),and(sender_id.eq.${partnerId},receiver_id.eq.${myProfile.id})`)
            .order('created_at', { ascending: true })
            .limit(500);
        if (error) throw error;

        chatMessages = data || [];
        renderChatMessages();
        markVisibleAsRead(partnerId);
    } catch (error) {
        console.error('Error loading conversation:', error);
        document.getElementById('chat-messages-container').innerHTML = `<p class="text-sm italic text-center py-8 text-error">Failed to load conversation.</p>`;
    }
}

function renderChatMessages() {
    const container = document.getElementById('chat-messages-container');
    if (!container) return;

    if (chatMessages.length === 0) {
        container.innerHTML = `<div class="flex-1 flex flex-col items-center justify-center py-14 text-center px-6 opacity-50">
            <span class="material-symbols-outlined text-[42px] mb-2 text-on-surface-variant">waving_hand</span>
            <p class="text-sm font-medium text-on-surface-variant">Say hi to ${escapeHtml(activeChat?.name || '')}!</p>
        </div>`;
        return;
    }

    let html = '';
    let lastDay = null;

    for (let i = 0; i < chatMessages.length; i++) {
        const m = chatMessages[i];
        const day = new Date(m.created_at).toDateString();
        if (day !== lastDay) {
            html += `<div class="flex justify-center my-3"><span class="text-[11px] font-bold text-on-surface-variant dark:text-gray-500 bg-surface-variant/40 dark:bg-neutral-800/60 px-3 py-1 rounded-full">${dayLabel(m.created_at)}</span></div>`;
            lastDay = day;
        }

        const mine = m.sender_id === myProfile.id;
        const next = chatMessages[i + 1];
        const isLastInGroup = !next || next.sender_id !== m.sender_id || (new Date(next.created_at) - new Date(m.created_at)) > 5 * 60 * 1000;
        const isLastOverall = i === chatMessages.length - 1;

        html += `
        <div class="flex ${mine ? 'justify-end' : 'justify-start'} ${isLastInGroup ? 'mb-1' : 'mb-1'} chat-bubble-anim">
            <div class="max-w-[75%] px-4 py-2.5 text-[14.5px] leading-relaxed whitespace-pre-wrap break-words ${
                mine
                    ? 'bg-primary text-white rounded-2xl rounded-br-md' + (m.pending ? ' opacity-60' : '')
                    : 'bg-surface-variant/50 dark:bg-neutral-800 text-on-surface dark:text-gray-100 rounded-2xl rounded-bl-md'
            }">${escapeHtml(m.content)}</div>
        </div>`;

        if (isLastInGroup) {
            const seen = mine && isLastOverall && m.is_read && !m.pending ? ' · Seen' : '';
            html += `<div class="flex ${mine ? 'justify-end' : 'justify-start'} mb-3">
                <span class="text-[10.5px] text-on-surface-variant dark:text-gray-500 px-1">${timeShort(m.created_at)}${seen}</span>
            </div>`;
        }
    }

    container.innerHTML = html;
    container.scrollTop = container.scrollHeight;
}

async function markVisibleAsRead(partnerId) {
    const unreadIds = chatMessages.filter(m => m.receiver_id === myProfile.id && !m.is_read).map(m => m.id);
    if (!unreadIds.length) return;

    chatMessages.forEach(m => { if (unreadIds.includes(m.id)) m.is_read = true; });

    try {
        const { error } = await supabase.from('messages').update({ is_read: true }).in('id', unreadIds);
        if (error) throw error;
        updateNavBadge();
    } catch (error) {
        console.error('Error marking messages as read:', error);
    }
}

// ==========================================
// Composer
// ==========================================
function setupComposer() {
    const input = document.getElementById('chat-composer-input');
    if (!input) return;

    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 112) + 'px';
        updateSendButtonState();
    });

    input.addEventListener('keydown', (e) => {
        // Enter sends, Shift+Enter makes a newline (desktop/keyboard users)
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            window.sendChatMessage();
        }
    });
}

function updateSendButtonState() {
    const input = document.getElementById('chat-composer-input');
    const btn = document.getElementById('chat-send-btn');
    if (!input || !btn) return;
    btn.disabled = input.value.trim().length === 0;
}

window.sendChatMessage = async function () {
    const input = document.getElementById('chat-composer-input');
    if (!input || !activeChat || sendInFlight) return;

    const content = input.value.trim();
    if (!content) return;

    sendInFlight = true;
    input.value = '';
    input.style.height = 'auto';
    updateSendButtonState();

    const tempId = `temp-${Date.now()}`;
    const optimisticMsg = {
        id: tempId,
        sender_id: myProfile.id,
        receiver_id: activeChat.userId,
        content,
        is_read: false,
        created_at: new Date().toISOString(),
        pending: true
    };
    chatMessages.push(optimisticMsg);
    renderChatMessages();

    try {
        const { data, error } = await supabase
            .from('messages')
            .insert({ sender_id: myProfile.id, receiver_id: activeChat.userId, content })
            .select('id, sender_id, receiver_id, content, is_read, created_at')
            .single();
        if (error) throw error;

        const idx = chatMessages.findIndex(m => m.id === tempId);
        if (idx !== -1) chatMessages[idx] = data;
        renderChatMessages();
    } catch (error) {
        console.error('Error sending message:', error);
        chatMessages = chatMessages.filter(m => m.id !== tempId);
        renderChatMessages();
        showToast("Couldn't send that. You may only message your connections.", 'error');
        input.value = content; // restore so they can retry
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 112) + 'px';
        updateSendButtonState();
    } finally {
        sendInFlight = false;
    }
};

// ==========================================
// Realtime
// ==========================================
function subscribeInbox() {
    if (!myProfile || inboxChannel) return;
    inboxChannel = supabase
        .channel(`inbox-${myProfile.id}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `receiver_id=eq.${myProfile.id}` }, () => {
            fetchInbox();
        })
        .subscribe();
}

function subscribeChat(partnerId) {
    unsubscribeChat();
    chatChannel = supabase
        .channel(`chat-${myProfile.id}-${partnerId}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `sender_id=eq.${partnerId}` }, (payload) => {
            const m = payload.new;
            if (!activeChat || activeChat.userId !== partnerId || m.receiver_id !== myProfile.id) return;
            chatMessages.push(m);
            renderChatMessages();
            markVisibleAsRead(partnerId);
        })
        .subscribe();
}

function unsubscribeChat() {
    if (chatChannel) { supabase.removeChannel(chatChannel); chatChannel = null; }
}

window.refreshMessages = fetchInbox;

// CLEANUP FUNCTION FOR TAB SWITCHING
window.cleanupMessagesTab = function() {
    try {
        // Unsubscribe from channels to free up WebSocket connections
        if (inboxChannel) {
            try {
                inboxChannel.unsubscribe();
                inboxChannel = null;
            } catch (e) {
                console.debug("Error unsubscribing from inbox:", e);
            }
        }

        if (chatChannel) {
            try {
                chatChannel.unsubscribe();
                chatChannel = null;
            } catch (e) {
                console.debug("Error unsubscribing from chat:", e);
            }
        }

        // Clear active chat to free memory
        activeChat = null;
        chatMessages = [];
        
        console.debug("Messages tab cleanup complete");
    } catch (err) {
        console.error("Messages cleanup error:", err);
    }
};
