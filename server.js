const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    maxHttpBufferSize: 1e7 // 10MB cho ảnh/voice base64
});

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// ============ STATE ============
const users = new Map();      // socketId -> user
const usersByUid = new Map(); // uid -> user (bền qua socket)
const rooms = new Map();      // roomName -> Set(socketId)
const history = new Map();    // roomName -> Message[]
const dms = new Map();        // dmKey -> Message[]  (dmKey = sorted uid pair)
const friendGraph = new Map();// uid -> Set(uid)

const COLORS = ['#e11d48','#db2777','#c026d3','#9333ea','#7c3aed','#4f46e5','#2563eb','#0284c7','#0891b2','#0d9488','#059669','#16a34a','#ca8a04','#ea580c','#dc2626'];

const genUid = () => 'u_' + Math.random().toString(36).slice(2, 10);
const dmKey = (a, b) => [a, b].sort().join('::');

function addHistory(map, key, msg, max = 200) {
    if (!map.has(key)) map.set(key, []);
    const arr = map.get(key);
    arr.push(msg);
    if (arr.length > max) arr.shift();
}

function userPublic(u) {
    if (!u) return null;
    return {
        uid: u.uid,
        name: u.name,
        avatar: u.avatar || null,
        color: u.color,
        bio: u.bio || '',
        room: u.room,
        online: true,
        joinedAt: u.joinedAt
    };
}

function userList(room) {
    const ids = rooms.get(room) || new Set();
    return [...ids].map(id => users.get(id)).filter(Boolean).map(userPublic);
}

function broadcastUserList(room) {
    io.to(room).emit('user list', userList(room));
}

function broadcastAll() {
    const roomsList = [...rooms.keys()];
    for (const r of roomsList) broadcastUserList(r);
    // emit global online count
    io.emit('global online', { online: users.size, rooms: roomsList.length });
}

// ============ SOCKET ============
io.on('connection', (socket) => {
    console.log('[+]', socket.id);

    // ============ JOIN ============
    socket.on('join', ({ uid, name, room, avatar, bio }) => {
        name = String(name || '').trim().slice(0, 32) || 'Ẩn danh';
        room = String(room || '').trim().slice(0, 32) || 'general';
        bio = String(bio || '').trim().slice(0, 200);
        uid = uid && String(uid).slice(0, 32) || genUid();

        // user cũ trong usersByUid
        let user = usersByUid.get(uid);
        if (user) {
            // update socket id
            const oldSocketId = user.id;
            users.delete(oldSocketId);
            // copy fields
            user.id = socket.id;
            user.name = name;
            user.room = room;
            user.bio = bio;
            if (avatar) user.avatar = avatar;
            user.online = true;
        } else {
            user = {
                id: socket.id,
                uid,
                name,
                room,
                bio,
                avatar: avatar || null,
                color: COLORS[Math.floor(Math.random() * COLORS.length)],
                joinedAt: Date.now(),
                online: true,
                friends: new Set()
            };
            usersByUid.set(uid, user);
        }
        users.set(socket.id, user);

        // rời phòng cũ
        const old = [...rooms.entries()].find(([r, s]) => s.has(socket.id) && r !== room);
        if (old) {
            old[1].delete(socket.id);
            if (old[1].size === 0) rooms.delete(old[0]);
        }

        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(socket.id);
        socket.join(room);

        socket.emit('joined', { ...userPublic(user), socketId: socket.id });
        socket.emit('history', history.get(room) || []);
        socket.emit('friends', [...(user.friends || [])]);

        socket.to(room).emit('system', {
            text: `${name} đã vào phòng`,
            time: Date.now()
        });

        broadcastUserList(room);
        broadcastAll();
        console.log(`[join] ${name} (${uid}) -> #${room}`);
    });

    // ============ MESSAGE (room) ============
    socket.on('message', (payload) => {
        const u = users.get(socket.id);
        if (!u) return;
        const text = String(payload?.text || '').slice(0, 5000);
        if (!text.trim()) return;

        const msg = {
            id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            kind: 'text',
            userId: socket.id,
            uid: u.uid,
            name: u.name,
            avatar: u.avatar,
            color: u.color,
            text,
            time: Date.now()
        };
        addHistory(history, u.room, msg);
        io.to(u.room).emit('message', msg);
    });

    // ============ IMAGE ============
    socket.on('image', ({ dataUrl, caption }) => {
        const u = users.get(socket.id);
        if (!u) return;
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return;
        if (dataUrl.length > 8e6) return; // ~6MB

        const msg = {
            id: 'i_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            kind: 'image',
            userId: socket.id,
            uid: u.uid,
            name: u.name,
            avatar: u.avatar,
            color: u.color,
            dataUrl,
            text: String(caption || '').slice(0, 500),
            time: Date.now()
        };
        addHistory(history, u.room, msg);
        io.to(u.room).emit('message', msg);
    });

    // ============ VOICE ============
    socket.on('voice', ({ dataUrl, duration }) => {
        const u = users.get(socket.id);
        if (!u) return;
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:audio/')) return;
        if (dataUrl.length > 8e6) return;

        const msg = {
            id: 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            kind: 'voice',
            userId: socket.id,
            uid: u.uid,
            name: u.name,
            avatar: u.avatar,
            color: u.color,
            dataUrl,
            duration: Number(duration) || 0,
            time: Date.now()
        };
        addHistory(history, u.room, msg);
        io.to(u.room).emit('message', msg);
    });

    // ============ TYPING ============
    socket.on('typing', (isTyping) => {
        const u = users.get(socket.id);
        if (!u) return;
        socket.to(u.room).emit('typing', {
            userId: socket.id, name: u.name, typing: !!isTyping
        });
    });

    // ============ UPDATE PROFILE ============
    socket.on('update profile', ({ name, avatar, bio }) => {
        const u = users.get(socket.id);
        if (!u) return;
        if (name) u.name = String(name).trim().slice(0, 32);
        if (bio !== undefined) u.bio = String(bio).trim().slice(0, 200);
        if (avatar !== undefined) u.avatar = avatar;
        const pub = userPublic(u);
        io.to(u.room).emit('profile updated', pub);
        io.emit('user updated', pub); // broadcast toàn bộ để friend list update
        broadcastUserList(u.room);
    });

    // ============ GET PROFILE BY UID ============
    socket.on('get profile', (uid, cb) => {
        const u = usersByUid.get(uid);
        if (typeof cb === 'function') cb(userPublic(u));
    });

    // ============ FRIEND REQUEST ============
    socket.on('friend request', ({ toUid }) => {
        const from = users.get(socket.id);
        if (!from) return;
        const target = usersByUid.get(toUid);
        if (!target) return socket.emit('friend error', 'Người dùng không online');

        // tìm socket của target
        for (const [sid, u] of users.entries()) {
            if (u.uid === toUid) {
                io.to(sid).emit('friend request', userPublic(from));
                break;
            }
        }
        socket.emit('friend request sent', toUid);
    });

    // ============ FRIEND ACCEPT ============
    socket.on('friend accept', ({ fromUid }) => {
        const me = users.get(socket.id);
        if (!me) return;
        const other = usersByUid.get(fromUid);
        if (!other) return;

        if (!me.friends) me.friends = new Set();
        if (!other.friends) other.friends = new Set();
        me.friends.add(fromUid);
        other.friends.add(me.uid);

        socket.emit('friends', [...me.friends]);
        // thông báo cho other
        for (const [sid, u] of users.entries()) {
            if (u.uid === fromUid) {
                io.to(sid).emit('friends', [...other.friends]);
                io.to(sid).emit('system', { text: `${me.name} đã chấp nhận kết bạn`, time: Date.now() });
                break;
            }
        }
        io.to(me.room).emit('system', { text: `${me.name} và ${other.name} đã kết bạn`, time: Date.now() });
    });

    // ============ FRIEND DECLINE ============
    socket.on('friend decline', ({ fromUid }) => {
        const me = users.get(socket.id);
        if (!me) return;
        for (const [sid, u] of users.entries()) {
            if (u.uid === fromUid) {
                io.to(sid).emit('system', { text: `${me.name} đã từ chối kết bạn`, time: Date.now() });
                break;
            }
        }
    });

    // ============ DM ============
    socket.on('dm', ({ toUid, text, kind, dataUrl, duration, caption }) => {
        const me = users.get(socket.id);
        if (!me) return;
        const key = dmKey(me.uid, toUid);

        let msg;
        if (kind === 'image' && typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
            if (dataUrl.length > 8e6) return;
            msg = {
                id: 'dm_i_' + Date.now(),
                kind: 'image', dataUrl,
                text: String(caption || '').slice(0, 500),
                fromUid: me.uid, toUid, name: me.name,
                avatar: me.avatar, color: me.color, time: Date.now()
            };
        } else if (kind === 'voice' && typeof dataUrl === 'string' && dataUrl.startsWith('data:audio/')) {
            if (dataUrl.length > 8e6) return;
            msg = {
                id: 'dm_v_' + Date.now(),
                kind: 'voice', dataUrl,
                duration: Number(duration) || 0,
                fromUid: me.uid, toUid, name: me.name,
                avatar: me.avatar, color: me.color, time: Date.now()
            };
        } else {
            const t = String(text || '').slice(0, 5000);
            if (!t.trim()) return;
            msg = {
                id: 'dm_' + Date.now(),
                kind: 'text', text: t,
                fromUid: me.uid, toUid, name: me.name,
                avatar: me.avatar, color: me.color, time: Date.now()
            };
        }

        addHistory(dms, key, msg);
        socket.emit('dm message', msg); // echo to sender
        // gửi đến target
        for (const [sid, u] of users.entries()) {
            if (u.uid === toUid) {
                io.to(sid).emit('dm message', msg);
                break;
            }
        }
    });

    // ============ DM HISTORY ============
    socket.on('dm history', ({ withUid }, cb) => {
        const me = users.get(socket.id);
        if (!me) return;
        const key = dmKey(me.uid, withUid);
        const arr = dms.get(key) || [];
        if (typeof cb === 'function') cb(arr);
        else socket.emit('dm history', arr);
    });

    // ============ DM TYPING ============
    socket.on('dm typing', ({ toUid, typing }) => {
        const me = users.get(socket.id);
        if (!me) return;
        for (const [sid, u] of users.entries()) {
            if (u.uid === toUid) {
                io.to(sid).emit('dm typing', { fromUid: me.uid, name: me.name, typing: !!typing });
                break;
            }
        }
    });

    // ============ LEAVE ============
    socket.on('leave', () => {
        const u = users.get(socket.id);
        if (!u) return;
        const set = rooms.get(u.room);
        socket.leave(u.room);
        if (set) {
            set.delete(socket.id);
            if (set.size === 0) rooms.delete(u.room);
            else {
                socket.to(u.room).emit('system', { text: `${u.name} đã rời phòng`, time: Date.now() });
                broadcastUserList(u.room);
            }
        }
        users.delete(socket.id);
        u.online = false;
        broadcastAll();
    });

    // ============ DISCONNECT ============
    socket.on('disconnect', () => {
        const u = users.get(socket.id);
        if (u) {
            const set = rooms.get(u.room);
            if (set) {
                set.delete(socket.id);
                if (set.size === 0) rooms.delete(u.room);
                else {
                    socket.to(u.room).emit('system', { text: `${u.name} đã rời phòng`, time: Date.now() });
                    broadcastUserList(u.room);
                }
            }
            users.delete(socket.id);
            u.online = false;
            broadcastAll();
        }
        console.log('[-]', socket.id);
    });
});

// ============ STATS ============
app.get('/stats', (req, res) => {
    res.json({
        online: users.size,
        uniqueUsers: usersByUid.size,
        rooms: [...rooms.entries()].map(([name, set]) => ({
            name, count: set.size, history: (history.get(name) || []).length
        })),
        dms: dms.size
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Chat server v2 on port ${PORT}`);
    console.log(`  Local: http://localhost:${PORT}\n`);
});
