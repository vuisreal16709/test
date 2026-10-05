(function() {
'use strict';

const socket = io();

// ============ DOM ============
const $ = id => document.getElementById(id);
const screenLogin = $('screenLogin');
const screenChat = $('screenChat');
const inputName = $('inputName');
const inputRoom = $('inputRoom');
const btnJoin = $('btnJoin');
const loginHint = $('loginHint');

const roomName = $('roomName');
const onlineCount = $('onlineCount');
const messages = $('messages');
const inputMsg = $('inputMsg');
const btnSend = $('btnSend');
const btnBack = $('btnBack');
const btnUsers = $('btnUsers');
const typingBar = $('typingBar');

const drawer = $('drawer');
const overlay = $('overlay');
const drawerClose = $('drawerClose');
const userList = $('userList');
const toast = $('toast');

// ============ STATE ============
const me = { name: '', room: '', color: '' };
const typingUsers = new Map(); // userId -> {name, timeout}
let typingSent = false;
let typingTimer = null;

// ============ HELPERS ============
function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('visible'), 1800);
}

function formatTime(ts) {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2, '0') + ':' +
           d.getMinutes().toString().padStart(2, '0');
}

function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function scrollBottom(force) {
    const near = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120;
    if (near || force) {
        requestAnimationFrame(() => {
            messages.scrollTop = messages.scrollHeight;
        });
    }
}

// ============ RENDER ============
function renderMessage(m) {
    const isOwn = m.userId === socket.id;
    const div = document.createElement('div');
    div.className = 'msg ' + (isOwn ? 'own' : 'other');
    div.innerHTML = `
        <div class="meta">
            <span class="author" style="color:${m.color}">${escapeHtml(m.name)}</span>
            <span class="time">${formatTime(m.time)}</span>
        </div>
        <div class="bubble">${escapeHtml(m.text)}</div>
    `;
    messages.appendChild(div);
    scrollBottom(false);
}

function renderSystem(text) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
    messages.appendChild(div);
    scrollBottom(false);
}

function renderUsers(list) {
    userList.innerHTML = '';
    if (list.length === 0) {
        userList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:12px">Không có ai</div>';
        return;
    }
    for (const u of list) {
        const item = document.createElement('div');
        item.className = 'user-item';
        const initial = u.name.charAt(0).toUpperCase();
        item.innerHTML = `
            <div class="avatar" style="background:${u.color}">${escapeHtml(initial)}</div>
            <div class="uname">${escapeHtml(u.name)}${u.id === socket.id ? ' (bạn)' : ''}</div>
            <div class="dot"></div>
        `;
        userList.appendChild(item);
    }
}

function renderTyping() {
    const names = [...typingUsers.values()].map(u => u.name);
    if (names.length === 0) {
        typingBar.classList.remove('visible');
        typingBar.textContent = '';
    } else {
        typingBar.classList.add('visible');
        typingBar.textContent = names.length === 1
            ? `${names[0]} đang nhập...`
            : `${names.slice(0, 2).join(', ')}${names.length > 2 ? ' và ' + (names.length - 2) + ' người khác' : ''} đang nhập...`;
    }
}

// ============ LOGIN ============
function joinRoom() {
    const name = inputName.value.trim();
    const room = inputRoom.value.trim() || 'general';
    if (!name) {
        loginHint.textContent = 'Nhập tên đi bạn';
        inputName.focus();
        return;
    }
    btnJoin.disabled = true;
    loginHint.textContent = 'Đang kết nối...';

    me.name = name;
    me.room = room;
    socket.emit('join', { name, room });
}

btnJoin.addEventListener('click', joinRoom);
inputName.addEventListener('keydown', e => { if (e.key === 'Enter') inputRoom.focus(); });
inputRoom.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

// ============ SOCKET EVENTS ============
socket.on('connect', () => {
    console.log('connected:', socket.id);
});

socket.on('joined', (data) => {
    me.color = data.color;
    roomName.textContent = '#' + data.room;
    messages.innerHTML = '';
    screenLogin.classList.remove('visible');
    screenChat.classList.add('visible');
    btnJoin.disabled = false;
    loginHint.textContent = '';
    inputMsg.focus();

    // lưu vào localStorage
    localStorage.setItem('chat_name', me.name);
    localStorage.setItem('chat_room', me.room);
});

socket.on('history', (arr) => {
    messages.innerHTML = '';
    for (const m of arr) renderMessage(m);
    scrollBottom(true);
});

socket.on('message', (m) => {
    renderMessage(m);
});

socket.on('system', (s) => {
    renderSystem(s.text);
});

socket.on('user list', (list) => {
    onlineCount.textContent = list.length + ' online';
    renderUsers(list);
});

socket.on('typing', ({ userId, name, typing }) => {
    if (typing) {
        if (typingUsers.has(userId)) clearTimeout(typingUsers.get(userId).timeout);
        const timeout = setTimeout(() => {
            typingUsers.delete(userId);
            renderTyping();
        }, 2500);
        typingUsers.set(userId, { name, timeout });
    } else {
        const t = typingUsers.get(userId);
        if (t) clearTimeout(t.timeout);
        typingUsers.delete(userId);
    }
    renderTyping();
});

socket.on('disconnect', () => {
    showToast('Mất kết nối. Đang thử lại...');
});

socket.on('connect_error', () => {
    showToast('Không kết nối được server');
});

// ============ SEND ============
function sendMessage() {
    const text = inputMsg.value.trim();
    if (!text) return;
    socket.emit('message', { text });
    inputMsg.value = '';
    inputMsg.focus();
    // tắt typing
    if (typingSent) {
        socket.emit('typing', false);
        typingSent = false;
    }
    clearTimeout(typingTimer);
}

btnSend.addEventListener('click', sendMessage);
inputMsg.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

inputMsg.addEventListener('input', () => {
    if (!typingSent) {
        socket.emit('typing', true);
        typingSent = true;
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        socket.emit('typing', false);
        typingSent = false;
    }, 1500);
});

// ============ DRAWER ============
function openDrawer() {
    drawer.classList.add('visible');
    overlay.classList.add('visible');
}
function closeDrawer() {
    drawer.classList.remove('visible');
    overlay.classList.remove('visible');
}
btnUsers.addEventListener('click', openDrawer);
drawerClose.addEventListener('click', closeDrawer);
overlay.addEventListener('click', closeDrawer);

// ============ LEAVE ============
btnBack.addEventListener('click', () => {
    if (!confirm('Rời phòng?')) return;
    socket.emit('leave');
    screenChat.classList.remove('visible');
    screenLogin.classList.add('visible');
    messages.innerHTML = '';
    onlineCount.textContent = '0 online';
    typingUsers.clear();
    renderTyping();
});

// ============ AUTOFILL ============
const savedName = localStorage.getItem('chat_name');
const savedRoom = localStorage.getItem('chat_room');
if (savedName) inputName.value = savedName;
if (savedRoom) inputRoom.value = savedRoom;

// ============ VISIBILITY ============
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket.disconnected) {
        socket.connect();
    }
});

})();
