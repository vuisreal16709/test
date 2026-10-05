(function() {
'use strict';

// ============ SOCKET ============
const socket = io();

// ============ DOM HELPERS ============
function $(id) { return document.getElementById(id); }

// ============ DOM ELEMENTS ============
const screens = {
    splash: $('screenSplash'),
    setup: $('screenSetup'),
    app: $('screenApp')
};

const inputMsg = $('inputMsg');
const messages = $('messages');
const roomName = $('roomName');
const onlineCount = $('onlineCount');
const typingBar = $('typingBar');
const userList = $('userList');
const drawer = $('drawer');
const overlay = $('overlay');
const toastEl = $('toast');
const friendsList = $('friendsList');
const dmView = $('dmView');
const dmMessages = $('dmMessages');
const dmInput = $('dmInput');
const dmTitle = $('dmTitle');
const dmTypingBar = $('dmTypingBar');
const emojiPicker = $('emojiPicker');
const friendReqBox = $('friendReqBox');

// ============ STATE ============
const state = {
    me: null,
    myFriends: [],
    users: [],
    activeTab: 'rooms',
    activeDmUid: null,
    dmUnread: {},
    typingUsers: new Map(),
    dmTypingUsers: new Map(),
    friendRequests: new Map(),
    pendingImage: null,
    mediaRecorder: null,
    audioChunks: [],
    recordingTimer: null,
    recordingStart: 0,
    recordingTarget: 'room',
    emojiTarget: 'room',
    imgTarget: 'room',
    editAvatar: null
};

// ============ SOUND ============
const Sound = {
    ctx: null,
    init() {
        if (!this.ctx) {
            try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
        }
    },
    play(type) {
        this.init();
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        switch (type) {
            case 'click':
                osc.frequency.setValueAtTime(880, t);
                osc.frequency.exponentialRampToValueAtTime(500, t + 0.05);
                gain.gain.setValueAtTime(0.08, t);
                gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
                osc.start(t); osc.stop(t + 0.06);
                break;
            case 'send':
                osc.frequency.setValueAtTime(600, t);
                osc.frequency.setValueAtTime(900, t + 0.04);
                gain.gain.setValueAtTime(0.1, t);
                gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
                osc.start(t); osc.stop(t + 0.1);
                break;
            case 'recv':
                osc.frequency.setValueAtTime(1200, t);
                osc.frequency.setValueAtTime(800, t + 0.05);
                gain.gain.setValueAtTime(0.06, t);
                gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
                osc.start(t); osc.stop(t + 0.1);
                break;
            case 'toggle':
                osc.frequency.setValueAtTime(700, t);
                gain.gain.setValueAtTime(0.06, t);
                gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
                osc.start(t); osc.stop(t + 0.05);
                break;
            case 'friend':
                osc.frequency.setValueAtTime(523, t);
                osc.frequency.setValueAtTime(659, t + 0.08);
                osc.frequency.setValueAtTime(784, t + 0.16);
                gain.gain.setValueAtTime(0.12, t);
                gain.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
                osc.start(t); osc.stop(t + 0.26);
                break;
        }
    }
};

document.addEventListener('touchstart', () => Sound.init(), { once: true });
document.addEventListener('click', () => Sound.init(), { once: true });

// ============ UTILS ============
function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('visible'));
    if (screens[name]) screens[name].classList.add('visible');
}

function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('visible'), 1800);
}

function fmtTime(ts) {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

// XSS-enabled: chỉ strip script, on*, javascript:
function sanitizeXSS(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('script').forEach(s => s.remove());
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
        return '<div class="msg-avatar" style="width:' + sz + 'px;height:' + sz + 'px"><img src="' + u.avatar + '"></div>';
    }
    const initial = (u.name || '?').charAt(0).toUpperCase();
    return '<div class="msg-avatar" style="background:' + u.color + ';width:' + sz + 'px;height:' + sz + 'px">' + escapeHtml(initial) + '</div>';
}

function avatarFriendHtml(u, size, showStatus) {
    const sz = size || 44;
    const inner = u.avatar
        ? '<img src="' + u.avatar + '">'
        : escapeHtml((u.name || '?').charAt(0).toUpperCase());
    const bg = u.avatar ? '' : 'background:' + u.color;
    const status = showStatus ? '<span class="status' + (u.online !== false ? ' online' : '') + '"></span>' : '';
    return '<div class="avatar" style="' + bg + ';width:' + sz + 'px;height:' + sz + 'px">' + inner + status + '</div>';
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
            const img = new Image();
            img.onload = () => {
                const max = 800;
                let w = img.width, h = img.height;
                if (w > max || h > max) {
                    const r = Math.min(max / w, max / h);
                    w = Math.floor(w * r);
                    h = Math.floor(h * r);
                }
                const cvs = document.createElement('canvas');
                cvs.width = w;
                cvs.height = h;
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

// ============ LOCAL STORAGE ============
function loadMe() {
    try { return JSON.parse(localStorage.getItem('chat_me') || 'null'); } catch (e) { return null; }
}
function saveMe(m) {
    localStorage.setItem('chat_me', JSON.stringify(m));
}

// ============ INIT ============
function init() {
    setTimeout(() => {
        const me = loadMe();
        if (me && me.uid && me.name) {
            state.me = me;
            socket.emit('join', {
                uid: me.uid,
                name: me.name,
                room: 'general',
                avatar: me.avatar || null,
                bio: me.bio || ''
            });
        } else {
            showScreen('setup');
        }
    }, 600);
}

// ============ SETUP ============
let setupAvatar = null;

$('btnPickAvatar').addEventListener('click', () => $('avatarInput').click());

$('avatarInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
        const dataUrl = await readImage(f);
        setupAvatar = dataUrl;
        $('avatarPreview').innerHTML = '<img src="' + dataUrl + '">';
        Sound.play('click');
    } catch (err) {
        toast('Lỗi ảnh');
    }
});

$('btnSetupDone').addEventListener('click', () => {
    const name = $('setupName').value.trim();
    const bio = $('setupBio').value.trim();
    if (!name) {
        $('setupHint').textContent = 'Nhập tên đi bạn';
        return;
    }
    const me = {
        uid: 'u_' + Math.random().toString(36).slice(2, 10),
        name: name,
        avatar: setupAvatar,
        bio: bio
    };
    saveMe(me);
    state.me = me;
    $('setupHint').textContent = 'Đang kết nối...';
    socket.emit('join', {
        uid: me.uid,
        name: name,
        room: 'general',
        avatar: me.avatar,
        bio: me.bio
    });
});

// ============ SOCKET EVENTS ============
socket.on('connect', () => console.log('connected', socket.id));

socket.on('joined', (u) => {
    state.me = {
        uid: u.uid,
        name: u.name,
        avatar: u.avatar,
        bio: u.bio,
        color: u.color,
        room: u.room
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
    div.innerHTML = '<div class="bubble">' + escapeHtml(s.text) + '</div>';
    messages.appendChild(div);
    scrollBottom(messages);
});

socket.on('user list', (list) => {
    state.users = list;
    onlineCount.textContent = list.length + ' online';
    renderUsers(list);
    renderFriends();
});

socket.on('profile updated', (u) => {
    const i = state.users.findIndex(x => x.uid === u.uid);
    if (i >= 0) state.users[i] = u;
    renderUsers(state.users);
    renderFriends();
});

socket.on('user updated', (u) => {
    const i = state.users.findIndex(x => x.uid === u.uid);
    if (i >= 0) state.users[i] = u;
});

socket.on('typing', (data) => {
    if (data.typing) {
        if (state.typingUsers.has(data.userId)) clearTimeout(state.typingUsers.get(data.userId).t);
        const t = setTimeout(() => {
            state.typingUsers.delete(data.userId);
            renderTyping();
        }, 2500);
        state.typingUsers.set(data.userId, { name: data.name, t: t });
    } else {
        const x = state.typingUsers.get(data.userId);
        if (x) clearTimeout(x.t);
        state.typingUsers.delete(data.userId);
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
    friendReqBox.classList.remove('hidden');
    Sound.play('friend');
    setTimeout(() => {
        if (state.friendRequests.has(fromUser.uid)) {
            friendReqBox.classList.add('hidden');
            state.friendRequests.delete(fromUser.uid);
        }
    }, 15000);
});

socket.on('friend request sent', () => {
    toast('Đã gửi lời mời kết bạn');
});

socket.on('friend error', (msg) => {
    toast(msg);
});

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

socket.on('dm typing', (data) => {
    if (data.fromUid !== state.activeDmUid) return;
    if (data.typing) {
        if (state.dmTypingUsers.has(data.fromUid)) clearTimeout(state.dmTypingUsers.get(data.fromUid).t);
        const t = setTimeout(() => {
            state.dmTypingUsers.delete(data.fromUid);
            renderDmTyping();
        }, 2500);
        state.dmTypingUsers.set(data.fromUid, { name: data.name, t: t });
    } else {
        const x = state.dmTypingUsers.get(data.fromUid);
        if (x) clearTimeout(x.t);
        state.dmTypingUsers.delete(data.fromUid);
    }
    renderDmTyping();
});

// ============ RENDER MESSAGE ============
function renderMessage(m, target) {
    const container = target === 'dm' ? dmMessages : messages;
    const isOwn = (m.uid === state.me.uid) || (m.fromUid === state.me.uid);

    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (isOwn ? 'own' : 'other');

    const av = avatarHtml({ name: m.name, avatar: m.avatar, color: m.color });

    let bubbleHtml = '';
    if (m.kind === 'image') {
        bubbleHtml = '<div class="bubble image">' +
            '<img src="' + m.dataUrl + '" loading="lazy" data-src="' + m.dataUrl + '">' +
            (m.text ? '<div class="cap">' + sanitizeXSS(m.text) + '</div>' : '') +
            '</div>';
    } else if (m.kind === 'voice') {
        bubbleHtml = '<div class="bubble voice">' +
            '<audio controls preload="metadata" src="' + m.dataUrl + '"></audio>' +
            '</div>';
    } else {
        bubbleHtml = '<div class="bubble">' + sanitizeXSS(m.text) + '</div>';
    }

    wrap.innerHTML =
        av +
        '<div class="body">' +
            '<div class="meta">' +
                '<span class="author" style="color:' + m.color + '" data-uid="' + (m.uid || m.fromUid) + '">' + escapeHtml(m.name) + '</span>' +
                '<span class="time">' + fmtTime(m.time) + '</span>' +
            '</div>' +
            bubbleHtml +
        '</div>';

    wrap.querySelectorAll('[data-uid]').forEach(el => {
        el.addEventListener('click', () => {
            const uid = el.dataset.uid;
            if (uid) openProfile(uid);
        });
    });

    const imgEl = wrap.querySelector('.bubble.image img');
    if (imgEl) {
        imgEl.addEventListener('click', () => {
            const w = window.open();
            if (w) w.document.write('<img src="' + imgEl.dataset.src + '" style="max-width:100%">');
        });
    }

    container.appendChild(wrap);
    scrollBottom(container);
}

function renderTyping() {
    const names = [...state.typingUsers.values()].map(x => x.name);
    if (names.length === 0) {
        typingBar.classList.remove('visible');
        typingBar.textContent = '';
    } else {
        typingBar.classList.add('visible');
        typingBar.textContent = names.length === 1
            ? names[0] + ' đang nhập...'
            : names.slice(0, 2).join(', ') + (names.length > 2 ? ' và ' + (names.length - 2) + ' người khác' : '') + ' đang nhập...';
    }
}

function renderDmTyping() {
    const names = [...state.dmTypingUsers.values()].map(x => x.name);
    if (names.length === 0) {
        dmTypingBar.classList.remove('visible');
        dmTypingBar.textContent = '';
    } else {
        dmTypingBar.classList.add('visible');
        dmTypingBar.textContent = names[0] + ' đang nhập...';
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
        item.innerHTML =
            avatarHtml({ name: u.name, avatar: u.avatar, color: u.color }, 36) +
            '<div class="uname">' + escapeHtml(u.name) + (u.uid === state.me.uid ? ' (bạn)' : '') + '</div>' +
            '<div class="dot"></div>';
        item.addEventListener('click', () => {
            Sound.play('click');
            openProfile(u.uid);
        });
        userList.appendChild(item);
    }
}

// ============ FRIENDS ============
function renderFriends() {
    const friendUsers = state.myFriends.map(uid => {
        const inRoom = state.users.find(u => u.uid === uid);
        if (inRoom) return inRoom;
        return { uid: uid, name: '?', color: '#71717a', avatar: null, online: false };
    });
    const nonFriendUsers = state.users.filter(u => state.myFriends.indexOf(u.uid) === -1);

    friendsList.innerHTML = '';

    if (friendUsers.length > 0) {
        const h = document.createElement('div');
        h.style.cssText = 'padding:12px 12px 6px;font-size:11px;color:var(--text-dim);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;';
        h.textContent = 'Bạn bè (' + friendUsers.length + ')';
        friendsList.appendChild(h);

        for (const u of friendUsers) {
            const item = document.createElement('div');
            item.className = 'friend-item';
            const unread = state.dmUnread[u.uid] || 0;
            item.innerHTML =
                avatarFriendHtml(u, 44, true) +
                '<div class="info">' +
                    '<div class="fname">' + escapeHtml(u.name) + '</div>' +
                    '<div class="fmeta">' + (u.online !== false ? 'online' : 'offline') + '</div>' +
                '</div>' +
                (unread > 0 ? '<div class="badge">' + unread + '</div>' : '');
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
        h.textContent = 'Trong phòng (' + nonFriendUsers.length + ')';
        friendsList.appendChild(h);

        for (const u of nonFriendUsers) {
            const item = document.createElement('div');
            item.className = 'friend-item';
            item.innerHTML =
                avatarFriendHtml(u, 44) +
                '<div class="info">' +
                    '<div class="fname">' + escapeHtml(u.name) + '</div>' +
                    '<div class="fmeta">nhấn để xem hồ sơ</div>' +
                '</div>' +
                '<button class="btn small light" data-add="' + u.uid + '">+ Kết bạn</button>';
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

// ============ SEND ROOM ============
let typingSent = false;
let typingTimer = null;

function sendRoom(text) {
    if (!text.trim()) return;
    socket.emit('message', { text: text });
    Sound.play('send');
    if (typingSent) {
        socket.emit('typing', false);
        typingSent = false;
    }
    clearTimeout(typingTimer);
}

$('btnSend').addEventListener('click', () => {
    sendRoom(inputMsg.value);
    inputMsg.value = '';
    inputMsg.focus();
});

inputMsg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendRoom(inputMsg.value);
        inputMsg.value = '';
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

// ============ SEND DM ============
let dmTypingSent = false;
let dmTypingTimer = null;

function sendDm(text) {
    if (!state.activeDmUid || !text.trim()) return;
    socket.emit('dm', {
        toUid: state.activeDmUid,
        text: text
    });
    Sound.play('send');
    if (dmTypingSent) {
        socket.emit('dm typing', { toUid: state.activeDmUid, typing: false });
        dmTypingSent = false;
    }
    clearTimeout(dmTypingTimer);
}

$('btnDmSend').addEventListener('click', () => {
    sendDm(dmInput.value);
    dmInput.value = '';
    dmInput.focus();
});

dmInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendDm(dmInput.value);
        dmInput.value = '';
    }
});

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
    roomName.textContent = '#' + (state.me ? state.me.room : 'general');
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

$('btnUserList').addEventListener('click', () => {
    Sound.play('click');
    drawer.classList.add('visible');
    overlay.classList.add('visible');
});

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
function openProfile(uid, isSelf) {
    const me = isSelf || uid === state.me.uid;
    let target;
    if (me) {
        target = {
            uid: state.me.uid,
            name: state.me.name,
            avatar: state.me.avatar,
            bio: state.me.bio,
            color: state.me.color,
            room: state.me.room
        };
    } else {
        target = state.users.find(x => x.uid === uid);
        if (!target) {
            toast('Người dùng không online');
            return;
        }
    }

    $('profileTitle').textContent = me ? 'Hồ sơ của bạn' : 'Hồ sơ';
    $('profileName').textContent = target.name;
    $('profileUid').textContent = 'UID: ' + target.uid;
    $('profileBio').textContent = target.bio || 'Chưa có giới thiệu';
    $('profileStatus').textContent = me ? 'online (bạn)' : 'online';

    const av = $('profileAvatar');
    if (target.avatar) {
        av.innerHTML = '<img src="' + target.avatar + '">';
        av.style.background = '';
        av.style.color = '';
    } else {
        av.innerHTML = '';
        av.style.background = target.color || '#71717a';
        av.style.color = '#fff';
        av.textContent = (target.name || '?').charAt(0).toUpperCase();
    }

    $('profileMeta').innerHTML =
        '<div>Phòng: #' + (target.room || state.me.room) + '</div>' +
        '<div>UID dùng để kết bạn</div>';

    const actions = $('profileActions');
    actions.innerHTML = '';

    if (me) {
        const editBtn = document.createElement('button');
        editBtn.className = 'btn primary';
        editBtn.textContent = 'Chỉnh sửa hồ sơ';
        editBtn.addEventListener('click', () => {
            Sound.play('click');
            $('editName').value = state.me.name;
            $('editBio').value = state.me.bio || '';
            const eav = $('editAvatarPreview');
            if (state.me.avatar) eav.innerHTML = '<img src="' + state.me.avatar + '">';
            else eav.textContent = (state.me.name || '?').charAt(0).toUpperCase();
            $('modalProfile').classList.remove('visible');
            $('modalEdit').classList.add('visible');
        });
        actions.appendChild(editBtn);
    } else {
        const isFriend = state.myFriends.indexOf(target.uid) !== -1;
        if (isFriend) {
            const dmBtn = document.createElement('button');
            dmBtn.className = 'btn primary';
            dmBtn.textContent = 'Nhắn tin';
            dmBtn.addEventListener('click', () => {
                Sound.play('click');
                $('modalProfile').classList.remove('visible');
                state.activeTab = 'friends';
                $('tabRooms').classList.remove('visible');
                $('tabFriends').classList.add('visible');
                roomName.textContent = 'Bạn bè';
                openDm(target.uid, target.name);
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

$('editAvatarInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
        const dataUrl = await readImage(f);
        state.editAvatar = dataUrl;
        $('editAvatarPreview').innerHTML = '<img src="' + dataUrl + '">';
        Sound.play('click');
    } catch (err) {
        toast('Lỗi ảnh');
    }
});

$('btnSaveProfile').addEventListener('click', () => {
    const name = $('editName').value.trim();
    const bio = $('editBio').value.trim();
    if (!name) {
        toast('Tên không được trống');
        return;
    }
    const payload = { name: name, bio: bio };
    if (state.editAvatar) payload.avatar = state.editAvatar;
    socket.emit('update profile', payload);
    state.me.name = name;
    state.me.bio = bio;
    if (state.editAvatar) state.me.avatar = state.editAvatar;
    saveMe(state.me);
    state.editAvatar = null;
    $('modalEdit').classList.remove('visible');
    toast('Đã lưu hồ sơ');
    Sound.play('friend');
});

$('editClose').addEventListener('click', () => {
    Sound.play('click');
    $('modalEdit').classList.remove('visible');
});

// ============ EMOJI ============
const EMOJIS = ('😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👻 💀 ☠️ 👽 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 💕 💞 💓 💗 💖 💘 💝 👍 👎 👌 ✌️ 🤞 🤟 🤘 👊 ✊ 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🖐️ ✋ 🤚 🖖 👋 🤙 💅 👂 👃 🧠 👀 👁️ 👅 👄 💋 🔥 ⭐ 🌟 ✨ ⚡ 💥 💫 💦 💨 💬 💭 💯 ✅ ❌ ⭕ 🚫 ⚠️ 🎉 🎊 🎈 🎁 🎂 🍰 🍻 🥂 🍷 🍸 🍹 🍺 🍕 🍔 🍟 🌭 🍿 🍩 🍪 🍫 🍬 🍭 🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🍍 🥝 🍅 🥑 🥦 🥕 🌽 🌶️ 🥒 🥬 🧄 🧅 🥔 🥐 🍞 🥖 🧀 🥚 🍳 🥞 🥓 🥩 🍗 🍖 🌮 🌯 🥙 🥪 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍢 🍡 🍧 🍨 🍦 🥧 🧁').split(' ').filter(Boolean);

function buildEmojiGrid() {
    const grid = $('emojiGrid');
    grid.innerHTML = '';
    for (const e of EMOJIS) {
        const d = document.createElement('div');
        d.className = 'emoji-item';
        d.textContent = e;
        d.addEventListener('click', () => {
            Sound.play('click');
            if (state.emojiTarget === 'dm') {
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
    state.emojiTarget = 'room';
    emojiPicker.classList.toggle('visible');
});

$('btnDmEmoji').addEventListener('click', () => {
    Sound.play('click');
    state.emojiTarget = 'dm';
    emojiPicker.classList.toggle('visible');
});

// ============ IMAGE ============
$('btnImage').addEventListener('click', () => {
    Sound.play('click');
    state.imgTarget = 'room';
    $('imgInputGlobal').click();
});

$('btnDmImage').addEventListener('click', () => {
    Sound.play('click');
    state.imgTarget = 'dm';
    $('imgInputGlobal').click();
});

$('imgInputGlobal').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
        const dataUrl = await readImage(f);
        state.pendingImage = dataUrl;
        $('imgPreviewEl').src = dataUrl;
        $('imgCaption').value = '';
        $('imgPreview').classList.add('visible');
    } catch (err) {
        toast('Lỗi ảnh');
    }
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
    if (state.imgTarget === 'dm' && state.activeDmUid) {
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
    } catch (e) {
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
    } catch (e) {
        toast('Không ghi âm được');
        return;
    }
    state.mediaRecorder.ondataavailable = (ev) => {
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
                    dataUrl: dataUrl,
                    duration: duration
                });
            } else {
                socket.emit('voice', { dataUrl: dataUrl, duration: duration });
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
    if (s >= 60) stopRecording();
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
    friendReqBox.classList.add('hidden');
    Sound.play('friend');
});

$('frDecline').addEventListener('click', () => {
    const first = [...state.friendRequests.keys()][0];
    if (!first) return;
    socket.emit('friend decline', { fromUid: first });
    state.friendRequests.delete(first);
    friendReqBox.classList.add('hidden');
    Sound.play('click');
});

// ============ VISIBILITY ============
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket.disconnected) {
        socket.connect();
    }
});

// ============ BOOT ============
init();

})();
