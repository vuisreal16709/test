(function() {
'use strict';

const socket = io();
const $ = id => document.getElementById(id);

// ============ DOM ============
const screens = {
    splash: $('screenSplash'),
    setup: $('screenSetup'),
    app: $('screenApp')
};
function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('visible'));
    screens[name].classList.add('visible');
}

const inputMsg = $('inputMsg');
const messages = $('messages');
const roomName = $('roomName');
const onlineCount = $('onlineCount');
const typingBar = $('typingBar');
const userList = $('userList');
const drawer = $('drawer');
const overlay = $('overlay');
const toast = $('toast');
const friendsList = $('friendsList');
const dmView = $('dmView');
const dmMessages = $('dmMessages');
const dmInput = $('dmInput');
const dmTitle = $('dmTitle');
const dmTypingBar = $('dmTypingBar');
const emojiPicker = $('emojiPicker');

// ============ STATE ============
const state = {
    me: null,           // { uid, name, avatar, bio, color, room }
    myFriends: [],      // [uid]
    users: [],          // users in room
    activeTab: 'rooms', // rooms | friends
    activeDmUid: null,  // đang chat dm với ai
    dmUnread: {},       // uid -> count
    typingUsers: new Map(),
    dmTypingUsers: new Map(),
    friendRequests: new Map(),
    pendingImage: null,
    pendingDmImage: null,
    mediaRecorder: null,
    audioChunks: [],
    recordingTimer: null,
    recordingStart: 0,
    recordingTarget: 'room' // room | dm
};

// ============ SOUND ============
const Sound = {
    ctx: null,
    init() { if (!this.ctx) try { this.ctx = new (window.AudioContext||window.webkitAudioContext)(); } catch(e){} },
    play(type) {
        this.init(); if (!this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain); gain.connect(this.ctx.destination);
        switch(type) {
            case 'click':
                osc.frequency.setValueAtTime(880, t);
                osc.frequency.exponentialRampToValueAtTime(500, t+0.05);
                gain.gain.setValueAtTime(0.08, t);
                gain.gain.exponentialRampToValueAtTime(0.001, t+0.06);
                osc.start(t); osc.stop(t+0.06); break;
            case 'send':
                osc.frequency.setValueAtTime(600, t);
                osc.frequency.setValueAtTime(900, t+0.04);
                gain.gain.setValueAtTime(0.1, t);
                gain.gain.exponentialRampToValueAtTime(0.001, t+0.1);
                osc.start(t); osc.stop(t+0.1); break;
            case 'recv':
                osc.frequency.setValueAtTime(1200, t);
                osc.frequency.setValueAtTime(800, t+0.05);
                gain.gain.setValueAtTime(0.06, t);
                gain.gain.exponentialRampToValueAtTime(0.001, t+0.1);
                osc.start(t); osc.stop(t+0.1); break;
            case 'toggle':
                osc.frequency.setValueAtTime(700, t);
                gain.gain.setValueAtTime(0.06, t);
                gain.gain.exponentialRampToValueAtTime(0.001, t+0.05);
                osc.start(t); osc.stop(t+0.05); break;
            case 'friend':
                osc.frequency.setValueAtTime(523, t);
                osc.frequency.setValueAtTime(659, t+0.08);
                osc.frequency.setValueAtTime(784, t+0.16);
                gain.gain.setValueAtTime(0.12, t);
                gain.gain.exponentialRampToValueAtTime(0.001, t+0.26);
                osc.start(t); osc.stop(t+0.26); break;
        }
    }
};

document.addEventListener('touchstart', () => { Sound.init(); }, { once: true });
document.addEventListener('click', () => { Sound.init(); }, { once: true });

// ============ HELPERS ============
function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('visible'), 1800);
}
const toastEl = $('toast');

function fmtTime(ts) {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

// Render HTML cho phép XSS (mục đích của m là cho phép render HTML)
// Chỉ chặn javascript: URL và on* attributes để không phá app của chính m
function sanitizeXSS(html) {
    // strip <script>, on* attributes, javascript: href
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    // xóa script tags
    tmp.querySelectorAll('script').forEach(s => s.remove());
    // xóa on* attributes
    tmp.querySelectorAll('*').forEach(el => {
        [...el.attributes].forEach(attr => {
            const n = attr.name.toLowerCase();
            const v = (attr.value || '').toLowerCase().trim();
            if (n.startsWith('on')) el.removeAttribute(attr.name);
            if ((n === 'href' || n === 'src') && v.startsWith('javascript:')) el.removeAttribute(attr.name);
        });
    });
    return tmp.innerHTML;
}

function avatarHtml(u, size) {
    const sz = size || 34;
    if (u.avatar) {
        return `<div class="msg-avatar" style="width:${sz}px;height:${sz}px"><img src="${u.avatar}"></div>`;
    }
    const initial = (u.name || '?').charAt(0).toUpperCase();
    return `<div class="msg-avatar" style="background:${u.color};width:${sz}px;height:${sz}px">${escapeHtml(initial)}</div>`;
}

function avatarHtmlFriend(u, size) {
    const sz = size || 44;
    if (u.avatar) {
        return `<div class="avatar" style="width:${sz}px;height:${sz}px"><img src="${u.avatar}"></div>`;
    }
    const initial = (u.name || '?').charAt(0).toUpperCase();
    return `<div class="avatar" style="background:${u.color};width:${sz}px;height:${sz}px">${escapeHtml(initial)}</div>`;
}

function scrollBottom(el, force) {
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (near || force) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

function readImage(file) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type.startsWith('image/')) return reject('Not image');
        const reader = new FileReader();
        reader.onload = e => {
            // resize xuống max 800px
            const img = new Image();
            img.onload = () => {
                const max = 800;
                let w = img.width, h = img.height;
                if (w > max || h > max) {
                    const r = Math.min(max/w, max/h);
                    w = Math.floor(w*r); h = Math.floor(h*r);
                }
                const cvs = document.createElement('canvas');
                cvs.width = w; cvs.height = h;
                cvs.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(cvs.toDataURL('image/jpeg', 0.75));
            };
            img.onerror = () => resolve(e.target.result);
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ============ INIT ============
function loadMe() {
    try { return JSON.parse(localStorage.getItem('chat_me') || 'null'); } catch(e) { return null; }
}
function saveMe(m) {
    localStorage.setItem('chat_me', JSON.stringify(m));
}

function init() {
    setTimeout(() => {
        const me = loadMe();
        if (me && me.uid && me.name) {
            // tự động vào chat luôn
            state.me = me;
            socket.emit('join', {
                uid: me.uid, name: me.name, room: 'general',
                avatar: me.avatar || null, bio: me.bio || ''
            });
        } else {
            showScreen('setup');
        }
    }, 700);
}

// ============ SETUP ============
let setupAvatar = null;
$('btnPickAvatar').addEventListener('click', () => $('avatarInput').click());
$('avatarInput').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
        const dataUrl = await readImage(f);
        setupAvatar = dataUrl;
        $('avatarPreview').innerHTML = `<img src="${dataUrl}">`;
        Sound.play('click');
    } catch(err) { toast('Lỗi ảnh'); }
});

$('btnSetupDone').addEventListener('click', () => {
    const name = $('setupName').value.trim();
    const bio = $('setupBio').value.trim();
    if (!name) { $('setupHint').textContent = 'Nhập tên đi bạn'; return; }
    const me = {
        uid: 'u_' + Math.random().toString(36).slice(2, 10),
        name, avatar: setupAvatar, bio
    };
    saveMe(me);
    state.me = me;
    $('setupHint').textContent = 'Đang kết nối...';
    socket.emit('join', {
        uid: me.uid, name, room: 'general', avatar: me.avatar, bio
    });
});

// ============ SOCKET EVENTS ============
socket.on('connect', () => console.log('connected', socket.id));

socket.on('joined', (u) => {
    state.me = {
        uid: u.uid, name: u.name, avatar: u.avatar,
        bio: u.bio, color: u.color, room: u.room
    };
    saveMe(state.me);
    roomName.textContent = '#' + u.room;
    showScreen('app');
    messages.innerHTML = '';
    dmMessages.innerHTML = '';
    Sound.play('click');
});

socket.on('history', (arr) => {
    messages.innerHTML = '';
    for (const m of arr) renderMessage(m, 'room');
    scrollBottom(messages, true);
});

socket.on('message', (m) => {
    renderMessage(m, 'room');
    if (m.userId !== socket.id) Sound.play('recv');
});

socket.on('system', (s) => {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.innerHTML = `<div class="bubble">${escapeHtml(s.text)}</div>`;
    messages.appendChild(div);
    scrollBottom(messages);
});

socket.on('user list', (list) => {
    state.users = list;
    onlineCount.textContent = list.length + ' online';
    renderUsers(list);
    renderFriends();
});

socket.on('global online', (data) => {
    // có thể hiện ở header nếu muốn
});

socket.on('profile updated', (u) => {
    // update local
    const i = state.users.findIndex(x => x.uid === u.uid);
    if (i >= 0) state.users[i] = u;
    renderUsers(state.users);
    renderFriends();
});

socket.on('user updated', (u) => {
    const i = state.users.findIndex(x => x.uid === u.uid);
    if (i >= 0) state.users[i] = u;
});

socket.on('typing', ({ userId, name, typing }) => {
    if (typing) {
        if (state.typingUsers.has(userId)) clearTimeout(state.typingUsers.get(userId).t);
        const t = setTimeout(() => {
            state.typingUsers.delete(userId);
            renderTyping();
        }, 2500);
        state.typingUsers.set(userId, { name, t });
    } else {
        const x = state.typingUsers.get(userId);
        if (x) clearTimeout(x.t);
        state.typingUsers.delete(userId);
    }
    renderTyping();
});

socket.on('friends', (arr) => {
    state.myFriends = arr || [];
    renderFriends();
});

socket.on('friend request', (fromUser) => {
    state.friendRequests.set(fromUser.uid, fromUser);
    $('frName').textContent = fromUser.name;
    $('friendReqBox').classList.remove('hidden');
    Sound.play('friend');
    setTimeout(() => {
        if (state.friendRequests.has(fromUser.uid)) {
            $('friendReqBox').classList.add('hidden');
            state.friendRequests.delete(fromUser.uid);
        }
    }, 15000);
});

socket.on('friend request sent', (uid) => {
    toast('Đã gửi lời mời kết bạn');
});

socket.on('friend error', (msg) => {
    toast(msg);
});

// ============ DM ============
socket.on('dm message', (m) => {
    const otherUid = m.fromUid === state.me.uid ? m.toUid : m.fromUid;
    if (state.activeDmUid === otherUid) {
        renderMessage(m, 'dm');
        scrollBottom(dmMessages, true);
        if (m.fromUid !== state.me.uid) Sound.play('recv');
    } else {
        if (m.fromUid !== state.me.uid) {
            state.dmUnread[otherUid] = (state.dmUnread[otherUid] || 0) + 1;
            renderFriends();
            Sound.play('recv');
        }
    }
});

socket.on('dm history', (arr) => {
    dmMessages.innerHTML = '';
    for (const m of arr) renderMessage(m, 'dm');
    scrollBottom(dmMessages, true);
});

socket.on('dm typing', ({ fromUid, name, typing }) => {
    if (fromUid !== state.activeDmUid) return;
    if (typing) {
        if (state.dmTypingUsers.has(fromUid)) clearTimeout(state.dmTypingUsers.get(fromUid).t);
        const t = setTimeout(() => {
            state.dmTypingUsers.delete(fromUid);
            renderDmTyping();
        }, 2500);
        state.dmTypingUsers.set(fromUid, { name, t });
    } else {
        const x = state.dmTypingUsers.get(fromUid);
        if (x) clearTimeout(x.t);
        state.dmTypingUsers.delete(fromUid);
    }
    renderDmTyping();
});

// ============ RENDER MESSAGE ============
function renderMessage(m, target) {
    const container = target === 'dm' ? dmMessages : messages;
    const isOwn = (m.uid === state.me.uid) || (m.fromUid === state.me.uid);

    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (isOwn ? 'own' : 'other');

    const av = avatarHtml({
        name: m.name, avatar: m.avatar, color: m.color
    });

    let bubbleHtml = '';
    if (m.kind === 'image') {
        bubbleHtml = `
            <div class="bubble image">
                <img src="${m.dataUrl}" loading="lazy" onclick="window.__openImg('${m.id}')" data-src="${m.dataUrl}">
                ${m.text ? `<div class="cap">${sanitizeXSS(m.text)}</div>` : ''}
            </div>`;
    } else if (m.kind === 'voice') {
        bubbleHtml = `
            <div class="bubble voice">
                <audio controls preload="metadata" src="${m.dataUrl}"></audio>
            </div>`;
    } else {
        bubbleHtml = `<div class="bubble">${sanitizeXSS(m.text)}</div>`;
    }

    wrap.innerHTML = `
        ${av}
        <div class="body">
            <div class="meta">
                <span class="author" style="color:${m.color}" data-uid="${m.uid || m.fromUid}">${escapeHtml(m.name)}</span>
                <span class="time">${fmtTime(m.time)}</span>
            </div>
            ${bubbleHtml}
        </div>
    `;

    // click avatar/author -> profile
    wrap.querySelectorAll('[data-uid]').forEach(el => {
        el.addEventListener('click', () => {
            const uid = el.dataset.uid;
            if (uid) openProfile(uid);
        });
    });

    // click ảnh
    const imgEl = wrap.querySelector('.bubble.image img');
    if (imgEl) {
        imgEl.addEventListener('click', () => {
            const w = window.open();
            if (w) w.document.write(`<img src="${imgEl.dataset.src}" style="max-width:100%">`);
        });
    }

    container.appendChild(wrap);
    scrollBottom(container);
}

// global image opener helper (để onclick trên img hoạt động)
window.__openImg = function(id) {
    const img = document.querySelector(`img[onclick*="${id}"]`);
    if (img) {
        const w = window.open();
        if (w) w.document.write(`<img src="${img.dataset.src}" style="max-width:100%">`);
    }
};

function renderTyping() {
    const names = [...state.typingUsers.values()].map(x => x.name);
    if (names.length === 0) {
        typingBar.classList.remove('visible');
        typingBar.textContent = '';
    } else {
        typingBar.classList.add('visible');
        typingBar.textContent = names.length === 1
            ? `${names[0]} đang nhập...`
            : `${names.slice(0,2).join(', ')}${names.length > 2 ? ' và ' + (names.length-2) + ' người khác' : ''} đang nhập...`;
    }
}

function renderDmTyping() {
    const names = [...state.dmTypingUsers.values()].map(x => x.name);
    if (names.length === 0) {
        dmTypingBar.classList.remove('visible');
        dmTypingBar.textContent = '';
    } else {
        dmTypingBar.classList.add('visible');
        dmTypingBar.textContent = `${names[0]} đang nhập...`;
    }
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
        const av = avatarHtml({name:u.name, avatar:u.avatar, color:u.color}, 36);
        const initial = (u.name||'?').charAt(0).toUpperCase();
        item.innerHTML = `
            ${av}
            <div class="uname">${escapeHtml(u.name)}${u.uid === state.me.uid ? ' (bạn)' : ''}</div>
            <div class="dot"></div>
        `;
        item.addEventListener('click', () => {
            Sound.play('click');
            openProfile(u.uid);
        });
        userList.appendChild(item);
    }
}

// ============ FRIENDS ============
function renderFriends() {
    // combine: friends (from state.myFriends) + current users in room
    const friendUsers = state.myFriends.map(uid => {
        const inRoom = state.users.find(u => u.uid === uid);
        if (inRoom) return inRoom;
        // user offline — dùng cache
        return { uid, name: '?', color: '#71717a', avatar: null, online: false };
    });
    // merge với users trong room (không phải friend)
    const nonFriendUsers = state.users.filter(u => !state.myFriends.includes(u.uid));

    friendsList.innerHTML = '';

    if (friendUsers.length > 0) {
        const h = document.createElement('div');
        h.style.cssText = 'padding:12px 12px 6px;font-size:11px;color:var(--text-dim);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;';
        h.textContent = `Bạn bè (${friendUsers.length})`;
        friendsList.appendChild(h);

        for (const u of friendUsers) {
            const item = document.createElement('div');
            item.className = 'friend-item';
            const unread = state.dmUnread[u.uid] || 0;
            item.innerHTML = `
                ${avatarHtmlFriend(u, 44).replace('class="avatar"', 'class="avatar"' + (u.online !== false ? '<span class="status online"></span>' : '<span class="status"></span>'))}
                <div class="info">
                    <div class="fname">${escapeHtml(u.name)}</div>
                    <div class="fmeta">${u.online !== false ? 'online' : 'offline'}</div>
                </div>
                ${unread > 0 ? `<div class="badge">${unread}</div>` : ''}
            `;
            item.addEventListener('click', () => {
                Sound.play('click');
                openDm(u.uid, u.name);
            });
            friendsList.appendChild(item);
        }
    }

    if (nonFriendUsers.length > 0) {
        const h = document.createElement('div');
        h.style.cssText = 'padding:12px 12px 6px;font-size:11px;color:var(--text-dim);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;';
        h.textContent = `Trong phòng (${nonFriendUsers.length})`;
        friendsList.appendChild(h);

        for (const u of nonFriendUsers) {
            const item = document.createElement('div');
            item.className = 'friend-item';
            item.innerHTML = `
                ${avatarHtmlFriend(u, 44)}
                <div class="info">
                    <div class="fname">${escapeHtml(u.name)}</div>
                    <div class="fmeta">nhấn để xem hồ sơ</div>
                </div>
                <button class="btn small light" data-add="${u.uid}">+ Kết bạn</button>
            `;
            item.addEventListener('click', (e) => {
                if (e.target.dataset.add) return;
                Sound.play('click');
                openProfile(u.uid);
            });
            const addBtn = item.querySelector('[data-add]');
            if (addBtn) {
                addBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    Sound.play('click');
                    socket.emit('friend request', { toUid: u.uid });
                });
            }
            friendsList.appendChild(item);
        }
    }

    if (friendUsers.length === 0 && nonFriendUsers.length === 0) {
        friendsList.innerHTML = '<div class="friends-empty">Chưa có ai.<br>Mời bạn bè vào phòng chat chung nhé.</div>';
    }
}

// ============ DM VIEW ============
function openDm(uid, name) {
    state.activeDmUid = uid;
    state.dmUnread[uid] = 0;
    dmTitle.textContent = name;
    dmView.classList.add('active');
    dmView.classList.remove('hidden');
    dmMessages.innerHTML = '';
    // xóa typing cũ
    state.dmTypingUsers.clear();
    renderDmTyping();
    socket.emit('dm history', { withUid: uid }, (arr) => {
        dmMessages.innerHTML = '';
        for (const m of arr) renderMessage(m, 'dm');
        scrollBottom(dmMessages, true);
    });
    renderFriends();
    dmInput.focus();
}

function closeDm() {
    state.activeDmUid = null;
    dmView.classList.remove('active');
    dmView.classList.add('hidden');
}

$('btnDmBack').addEventListener('click', () => { Sound.play('click'); closeDm(); });
$('btnDmInfo').addEventListener('click', () => {
    if (state.activeDmUid) openProfile(state.activeDmUid);
});

// ============ SEND MESSAGE (room) ============
function sendRoom(text) {
    if (!text.trim()) return;
    socket.emit('message', { text });
    Sound.play('send');
    if (typingSent) { socket.emit('typing', false); typingSent = false; }
    clearTimeout(typingTimer);
}

$('btnSend').addEventListener('click', () => {
    sendRoom(inputMsg.value);
    inputMsg.value = '';
    inputMsg.focus();
});

inputMsg.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendRoom(inputMsg.value);
        inputMsg.value = '';
    }
});

// ============ SEND MESSAGE (dm) ============
function sendDm(text) {
    if (!state.activeDmUid || !text.trim()) return;
    socket.emit('dm', {
        toUid: state.activeDmUid,
        text
    });
    Sound.play('send');
}

$('btnDmSend').addEventListener('click', () => {
    sendDm(dmInput.value);
    dmInput.value = '';
    dmInput.focus();
});

dmInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendDm(dmInput.value);
        dmInput.value = '';
    }
});

// ============ TYPING ============
let typingSent = false;
let typingTimer = null;
inputMsg.addEventListener('input', () => {
    if (!typingSent) { socket.emit('typing', true); typingSent = true; }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        socket.emit('typing', false);
        typingSent = false;
    }, 1500);
});

let dmTypingSent = false;
let dmTypingTimer = null;
dmInput.addEventListener('input', () => {
    if (!state.activeDmUid) return;
    if (!dmTypingSent) {
        socket.emit('dm typing', { toUid: state.activeDmUid, typing: true });
        dmTypingSent = true;
    }
    clearTimeout(dmTypingTimer);
    dmTypingTimer = setTimeout(() => {
        socket.emit('dm typing', { toUid: state.activeDmUid, typing: false });
        dmTypingSent = false;
    }, 1500);
});

// ============ HEADER BUTTONS ============
$('btnTabRooms').addEventListener('click', () => {
    Sound.play('click');
    state.activeTab = 'rooms';
    $('tabRooms').classList.add('visible');
    $('tabFriends').classList.remove('visible');
    roomName.textContent = '#' + (state.me?.room || 'general');
});
$('btnTabFriends').addEventListener('click', () => {
    Sound.play('click');
    state.activeTab = 'friends';
    $('tabRooms').classList.remove('visible');
    $('tabFriends').classList.add('visible');
    roomName.textContent = 'Bạn bè';
    renderFriends();
});
$('btnProfile').addEventListener('click', () => {
    Sound.play('click');
    if (state.me) openProfile(state.me.uid, true);
});

// ============ DRAWER ============
$('btnUsers').addEventListener('click', () => {});
// header hiện tại: chỉ có 4 nút. thêm nút user list vào header?
// patch: chèn nút xem user list
(function addUsersBtn() {
    const header = $('appHeader');
    const btn = document.createElement('button');
    btn.className = 'icon-btn';
    btn.id = 'btnUserList';
    btn.textContent = '☰';
    const before = $('btnProfile');
    header.insertBefore(btn, before);
    btn.addEventListener('click', () => {
        Sound.play('click');
        drawer.classList.add('visible');
        overlay.classList.add('visible');
    });
})();

$('drawerClose').addEventListener('click', () => {
    Sound.play('click');
    drawer.classList.remove('visible');
    overlay.classList.remove('visible');
});
overlay.addEventListener('click', () => {
    drawer.classList.remove('visible');
    overlay.classList.remove('visible');
    emojiPicker.classList.remove('visible');
    $('modalProfile').classList.remove('visible');
    $('modalEdit').classList.remove('visible');
    $('imgPreview').classList.remove('visible');
});

// ============ PROFILE ============
let editingUid = null;

function openProfile(uid, isSelf) {
    const u = state.users.find(x => x.uid === uid);
    if (!u && !isSelf) {
        // offline user — thử lấy từ friend cache
        toast('Người dùng không online');
        return;
    }
    const me = isSelf || uid === state.me.uid;
    const target = isSelf ? state.me : u;
    if (!target) return;

    // nếu là mình, refresh từ me
    if (me) {
        target.uid = state.me.uid;
        target.name = state.me.name;
        target.avatar = state.me.avatar;
        target.bio = state.me.bio;
        target.color = state.me.color;
    }

    $('profileTitle').textContent = me ? 'Hồ sơ của bạn' : 'Hồ sơ';
    $('profileName').textContent = target.name;
    $('profileUid').textContent = 'UID: ' + target.uid;
    $('profileBio').textContent = target.bio || 'Chưa có giới thiệu';
    $('profileStatus').textContent = me ? 'online (bạn)' : 'online';
    $('profileStatus').classList.remove('offline');

    const av = $('profileAvatar');
    if (target.avatar) av.innerHTML = `<img src="${target.avatar}">`;
    else {
        const ini = (target.name||'?').charAt(0).toUpperCase();
        av.innerHTML = '';
        av.style.background = target.color || '#71717a';
        av.textContent = ini;
        av.style.color = '#fff';
    }

    // meta
    $('profileMeta').innerHTML = `
        <div>Tham gia: ${fmtTime(Date.now())} hôm nay</div>
        <div>Phòng: #${target.room || state.me.room}</div>
    `;

    // actions
    const actions = $('profileActions');
    actions.innerHTML = '';
    if (me) {
        editingUid = target.uid;
        const editBtn = document.createElement('button');
        editBtn.className = 'btn primary';
        editBtn.textContent = 'Chỉnh sửa hồ sơ';
        editBtn.addEventListener('click', () => {
            Sound.play('click');
            $('editName').value = state.me.name;
            $('editBio').value = state.me.bio || '';
            const av = $('editAvatarPreview');
            if (state.me.avatar) av.innerHTML = `<img src="${state.me.avatar}">`;
            else av.textContent = (state.me.name||'?').charAt(0).toUpperCase();
            $('modalProfile').classList.remove('visible');
            $('modalEdit').classList.add('visible');
        });
        actions.appendChild(editBtn);
    } else {
        // nút kết bạn / nhắn tin
        const isFriend = state.myFriends.includes(target.uid);
        if (isFriend) {
            const dmBtn = document.createElement('button');
            dmBtn.className = 'btn primary';
            dmBtn.textContent = 'Nhắn tin';
            dmBtn.addEventListener('click', () => {
                Sound.play('click');
                $('modalProfile').classList.remove('visible');
                openDm(target.uid, target.name);
                // chuyển sang tab friends
                state.activeTab = 'friends';
                $('tabRooms').classList.remove('visible');
                $('tabFriends').classList.add('visible');
                roomName.textContent = 'Bạn bè';
            });
            actions.appendChild(dmBtn);
        } else {
            const addBtn = document.createElement('button');
            addBtn.className = 'btn primary';
            addBtn.textContent = '+ Kết bạn';
            addBtn.addEventListener('click', () => {
                Sound.play('click');
                socket.emit('friend request', { toUid: target.uid });
            });
            actions.appendChild(addBtn);
        }
    }

    $('modalProfile').classList.add('visible');
}

$('profileClose').addEventListener('click', () => {
    Sound.play('click');
    $('modalProfile').classList.remove('visible');
});

// ============ EDIT PROFILE ============
$('btnEditAvatar').addEventListener('click', () => $('editAvatarInput').click());
$('editAvatarInput').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
        const dataUrl = await readImage(f);
        state._editAvatar = dataUrl;
        $('editAvatarPreview').innerHTML = `<img src="${dataUrl}">`;
        Sound.play('click');
    } catch(err) { toast('Lỗi ảnh'); }
});

$('btnSaveProfile').addEventListener('click', () => {
    const name = $('editName').value.trim();
    const bio = $('editBio').value.trim();
    if (!name) { toast('Tên không được trống'); return; }
    const payload = { name, bio };
    if (state._editAvatar) payload.avatar = state._editAvatar;
    socket.emit('update profile', payload);
    state.me.name = name;
    state.me.bio = bio;
    if (state._editAvatar) state.me.avatar = state._editAvatar;
    saveMe(state.me);
    state._editAvatar = null;
    $('modalEdit').classList.remove('visible');
    toast('Đã lưu hồ sơ');
    Sound.play('friend');
});

$('editClose').addEventListener('click', () => {
    Sound.play('click');
    $('modalEdit').classList.remove('visible');
});

// ============ EMOJI ============
const EMOJIS = ('😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👻 💀 ☠️ 👽 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 👍 👎 👌 ✌️ 🤞 🤟 🤘 👊 ✊ 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🦾 🖐️ ✋ 🤚 🖖 👋 🤙 💅 🦵 🦶 👂 🦻 👃 🧠 🦷 👀 👁️ 👅 👄 💋 🔥 ⭐ 🌟 ✨ ⚡ 💥 💫 💦 💨 🕳️ 💬 💭 🗯️ ♨️ 💯 ✅ ❌ ⭕ 🚫 ⚠️ ☢️ ☣️ ⬆️ ⬇️ ⬅️ ➡️ 🔙 🔚 🔛 🔜 🔝 🎉 🎊 🎈 🎁 🎀 🎂 🍰 🍻 🥂 🍷 🍸 🍹 🍺 🥃 🍾 🍕 🍔 🍟 🌭 🍿 🍩 🍪 🍫 🍬 🍭 🍮 🍯 🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🥕 🌽 🌶️ 🥒 🥬 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🥞 🧇 🥓 🥩 🍗 🍖 🌮 🌯 🥙 🥪 🥣 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🥠 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍫 🍬').split(' ').filter(Boolean);

function buildEmojiGrid() {
    const grid = $('emojiGrid');
    grid.innerHTML = '';
    for (const e of EMOJIS) {
        const d = document.createElement('div');
        d.className = 'emoji-item';
        d.textContent = e;
        d.addEventListener('click', () => {
            Sound.play('click');
            if (state._emojiTarget === 'dm') {
                dmInput.value += e;
                dmInput.focus();
            } else {
                inputMsg.value += e;
                inputMsg.focus();
            }
        });
        grid.appendChild(d);
    }
}
buildEmojiGrid();

$('btnEmoji').addEventListener('click', () => {
    Sound.play('click');
    state._emojiTarget = 'room';
    emojiPicker.classList.toggle('visible');
});
$('btnDmEmoji').addEventListener('click', () => {
    Sound.play('click');
    state._emojiTarget = 'dm';
    emojiPicker.classList.toggle('visible');
});

// ============ IMAGE ============
$('btnImage').addEventListener('click', () => {
    Sound.play('click');
    state._imgTarget = 'room';
    $('imgInputGlobal').click();
});
$('btnDmImage').addEventListener('click', () => {
    Sound.play('click');
    state._imgTarget = 'dm';
    $('imgInputGlobal').click();
});

$('imgInputGlobal').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
        const dataUrl = await readImage(f);
        state.pendingImage = dataUrl;
        $('imgPreviewEl').src = dataUrl;
        $('imgCaption').value = '';
        $('imgPreview').classList.add('visible');
    } catch(err) { toast('Lỗi ảnh'); }
    e.target.value = '';
});

$('imgClose').addEventListener('click', () => {
    Sound.play('click');
    $('imgPreview').classList.remove('visible');
    state.pendingImage = null;
});

$('imgSend').addEventListener('click', () => {
    if (!state.pendingImage) return;
    const cap = $('imgCaption').value.trim();
    if (state._imgTarget === 'dm' && state.activeDmUid) {
        socket.emit('dm', {
            toUid: state.activeDmUid,
            kind: 'image',
            dataUrl: state.pendingImage,
            caption: cap
        });
    } else {
        socket.emit('image', { dataUrl: state.pendingImage, caption: cap });
    }
    state.pendingImage = null;
    $('imgPreview').classList.remove('visible');
    Sound.play('send');
});

// ============ VOICE ============
let mediaStream = null;

async function startRecording(target) {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch(e) {
        toast('Không truy cập được mic');
        return;
    }
    state.recordingTarget = target;
    state.audioChunks = [];
    let mime = 'audio/webm';
    if (!MediaRecorder.isTypeSupported(mime)) mime = 'audio/mp4';
    if (!MediaRecorder.isTypeSupported(mime)) mime = '';
    try {
        state.mediaRecorder = mime
            ? new MediaRecorder(mediaStream, { mimeType: mime })
            : new MediaRecorder(mediaStream);
    } catch(e) {
        toast('Không ghi âm được');
        return;
    }
    state.mediaRecorder.ondataavailable = ev => {
        if (ev.data && ev.data.size > 0) state.audioChunks.push(ev.data);
    };
    state.mediaRecorder.onstop = () => {
        const blob = new Blob(state.audioChunks, { type: state.mediaRecorder.mimeType || 'audio/webm' });
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result;
            const duration = (Date.now() - state.recordingStart) / 1000;
            if (state.recordingTarget === 'dm' && state.activeDmUid) {
                socket.emit('dm', {
                    toUid: state.activeDmUid,
                    kind: 'voice',
                    dataUrl,
                    duration
                });
            } else {
                socket.emit('voice', { dataUrl, duration });
            }
            Sound.play('send');
        };
        reader.readAsDataURL(blob);
        if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
    };
    state.mediaRecorder.start();
    state.recordingStart = Date.now();
    $('voiceRecorder').classList.add('visible');
    updateVoiceTimer();
    state.recordingTimer = setInterval(updateVoiceTimer, 200);
}

function updateVoiceTimer() {
    const s = Math.floor((Date.now() - state.recordingStart) / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    $('vrTimer').textContent = m + ':' + sec.toString().padStart(2, '0');
    if (s >= 60) stopRecording(); // max 60s
}

function stopRecording() {
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
        state.mediaRecorder.stop();
    }
    clearInterval(state.recordingTimer);
    $('voiceRecorder').classList.remove('visible');
}

function cancelRecording() {
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
        state.mediaRecorder.onstop = () => {
            if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
            mediaStream = null;
        };
        state.mediaRecorder.stop();
    }
    clearInterval(state.recordingTimer);
    $('voiceRecorder').classList.remove('visible');
}

$('btnVoice').addEventListener('click', () => { Sound.play('click'); startRecording('room'); });
$('btnDmVoice').addEventListener('click', () => { Sound.play('click'); startRecording('dm'); });
$('vrStop').addEventListener('click', () => { Sound.play('click'); stopRecording(); });
$('vrCancel').addEventListener('click', () => { Sound.play('click'); cancelRecording(); });

// ============ FRIEND REQUEST ============
$('frAccept').addEventListener('click', () => {
    const first = [...state.friendRequests.keys()][0];
    if (!first) return;
    socket.emit('friend accept', { fromUid: first });
    state.friendRequests.delete(first);
    $('friendReqBox').classList.add('hidden');
    Sound.play('friend');
});
$('frDecline').addEventListener('click', () => {
    const first = [...state.friendRequests.keys()][0];
    if (!first) return;
    socket.emit('friend decline', { fromUid: first });
    state.friendRequests.delete(first);
    $('friendReqBox').classList.add('hidden');
    Sound.play('click');
});

// ============ VISIBILITY ============
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket.disconnected) socket.connect();
});

// ============ BOOT ============
init();

})();
