const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 1e7
});

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// ============ STATE ============
const users = new Map();
const usersByUid = new Map();
const rooms = new Map();
const history = new Map();
const dms = new Map();

const COLORS = ['#e11d48','#db2777','#c026d3','#9333ea','#7c3aed','#4f46e5','#2563eb','#0284c7','#0891b2','#0d9488','#059669','#16a34a','#ca8a04','#ea580c','#dc2626'];

const genUid = () => 'u_' + Math.random().toString(36).slice(2, 10);
const dmKey = (a, b) => [a, b].sort().join('::');

function addHistory(map, key, msg, max) {
    if (!map.has(key)) map.set(key, []);
    const arr = map.get(key);
    arr.push(msg);
    if (arr.length > (max || 200)) arr.shift();
}

function userPublic(u) {
    if (!u) return null;
    return {
        uid: u.uid,
        name: u.name,
        avatar: u.avatar || null,
        color: u.color,
        bio: u.bio || '',
        room: u.room
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
    for (const r of [...rooms.keys()]) broadcastUserList(r);
    io.emit('global online', { online: users.size, rooms: rooms.size });
}

// ============ SOCKET ============
io.on('connection', (socket) => {
    console.log('[+]', socket.id);

    socket.on('join', (data) => {
        const name = String(data?.name || '').trim().slice(0, 32) || 'Ẩn danh';
        const room = String(data?.room || '').trim().slice(0, 32) || 'general';
        const bio = String(data?.bio || '').trim().slice(0, 200);
        const uid = (data?.uid && String(data.uid).slice(0, 32)) || genUid();
        const avatar = data?.avatar || null;

        let user = usersByUid.get(uid);
        if (user) {
            users.delete(user.id);
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
                avatar,
                color: COLORS[Math.floor(Math.random() * COLORS.length)],
                joinedAt: Date.now(),
                online: true
            };
            usersByUid.set(uid, user);
        }
        users.set(socket.id, user);

        // rời phòng cũ
        for (const [r, set] of rooms.entries()) {
            if (r !== room && set.has(socket.id)) {
                set.delete(socket.id);
                if (set.size === 0) rooms.delete(r);
            }
        }

        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(socket.id);
        socket.join(room);

        socket.emit('joined', { ...userPublic(user), socketId: socket.id });
        socket.emit('history', history.get(room) || []);

        socket.to(room).emit('system', {
            text: `${name} đã vào phòng`,
            time: Date.now()
        });

        broadcastUserList(room);
        broadcastAll();
        console.log(`[join] ${name} -> #${room}`);
    });

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

    socket.on('image', (payload) => {
        const u = users.get(socket.id);
        if (!u) return;
        const dataUrl = payload?.dataUrl;
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return;
        if (dataUrl.length > 8e6) return;
        const msg = {
            id: 'i_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            kind: 'image',
            userId: socket.id,
            uid: u.uid,
            name: u.name,
            avatar: u.avatar,
            color: u.color,
            dataUrl,
            text: String(payload?.caption || '').slice(0, 500),
            time: Date.now()
        };
        addHistory(history, u.room, msg);
        io.to(u.room).emit('message', msg);
    });

    socket.on('voice', (payload) => {
        const u = users.get(socket.id);
        if (!u) return;
        const dataUrl = payload?.dataUrl;
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
            duration: Number(payload?.duration) || 0,
            time: Date.now()
        };
        addHistory(history, u.room, msg);
        io.to(u.room).emit('message', msg);
    });

    socket.on('typing', (isTyping) => {
        const u = users.get(socket.id);
        if (!u) return;
        socket.to(u.room).emit('typing', {
            userId: socket.id,
            name: u.name,
            typing: !!isTyping
        });
    });

    socket.on('update profile', (payload) => {
        const u = users.get(socket.id);
        if (!u) return;
        if (payload?.name) u.name = String(payload.name).trim().slice(0, 32);
        if (payload?.bio !== undefined) u.bio = String(payload.bio).trim().slice(0, 200);
        if (payload?.avatar !== undefined) u.avatar = payload.avatar;
        const pub = userPublic(u);
        io.to(u.room).emit('profile updated', pub);
        io.emit('user updated', pub);
        broadcastUserList(u.room);
    });

    socket.on('get profile', (uid, cb) => {
        const u = usersByUid.get(uid);
        if (typeof cb === 'function') cb(userPublic(u));
    });

    socket.on('friend request', (payload) => {
        const from = users.get(socket.id);
        if (!from) return;
        const toUid = payload?.toUid;
        const target = usersByUid.get(toUid);
        if (!target) return socket.emit('friend error', 'Người dùng không online');
        for (const [sid, u] of users.entries()) {
            if (u.uid === toUid) {
                io.to(sid).emit('friend request', userPublic(from));
                break;
            }
        }
        socket.emit('friend request sent', toUid);
    });

    socket.on('friend accept', (payload) => {
        const me = users.get(socket.id);
        if (!me) return;
        const fromUid = payload?.fromUid;
        const other = usersByUid.get(fromUid);
        if (!other) return;
        me.friends = me.friends || new Set();
        other.friends = other.friends || new Set();
        me.friends.add(fromUid);
        other.friends.add(me.uid);
        socket.emit('friends', [...me.friends]);
        for (const [sid, u] of users.entries()) {
            if (u.uid === fromUid) {
                io.to(sid).emit('friends', [...other.friends]);
                break;
            }
        }
        io.to(me.room).emit('system', {
            text: `${me.name} và ${other.name} đã kết bạn`,
            time: Date.now()
        });
    });

    socket.on('friend decline', (payload) => {
        const me = users.get(socket.id);
        if (!me) return;
        for (const [sid, u] of users.entries()) {
            if (u.uid === payload?.fromUid) {
                io.to(sid).emit('system', {
                    text: `${me.name} đã từ chối kết bạn`,
                    time: Date.now()
                });
                break;
            }
        }
    });

    socket.on('dm', (payload) => {
        const me = users.get(socket.id);
        if (!me) return;
        const toUid = payload?.toUid;
        if (!toUid) return;
        const key = dmKey(me.uid, toUid);
        let msg;
        if (payload.kind === 'image' && typeof payload.dataUrl === 'string' && payload.dataUrl.startsWith('data:image/')) {
            if (payload.dataUrl.length > 8e6) return;
            msg = {
                id: 'dm_i_' + Date.now(),
                kind: 'image',
                dataUrl: payload.dataUrl,
                text: String(payload.caption || '').slice(0, 500),
                fromUid: me.uid,
                toUid,
                name: me.name,
                avatar: me.avatar,
                color: me.color,
                time: Date.now()
            };
        } else if (payload.kind === 'voice' && typeof payload.dataUrl === 'string' && payload.dataUrl.startsWith('data:audio/')) {
            if (payload.dataUrl.length > 8e6) return;
            msg = {
                id: 'dm_v_' + Date.now(),
                kind: 'voice',
                dataUrl: payload.dataUrl,
                duration: Number(payload.duration) || 0,
                fromUid: me.uid,
                toUid,
                name: me.name,
                avatar: me.avatar,
                color: me.color,
                time: Date.now()
            };
        } else {
            const t = String(payload.text || '').slice(0, 5000);
            if (!t.trim()) return;
            msg = {
                id: 'dm_' + Date.now(),
                kind: 'text',
                text: t,
                fromUid: me.uid,
                toUid,
                name: me.name,
                avatar: me.avatar,
                color: me.color,
                time: Date.now()
            };
        }
        addHistory(dms, key, msg);
        socket.emit('dm message', msg);
        for (const [sid, u] of users.entries()) {
            if (u.uid === toUid) {
                io.to(sid).emit('dm message', msg);
                break;
            }
        }
    });

    socket.on('dm history', (payload, cb) => {
        const me = users.get(socket.id);
        if (!me) return;
        const key = dmKey(me.uid, payload?.withUid);
        const arr = dms.get(key) || [];
        if (typeof cb === 'function') cb(arr);
    });

    socket.on('dm typing', (payload) => {
        const me = users.get(socket.id);
        if (!me) return;
        for (const [sid, u] of users.entries()) {
            if (u.uid === payload?.toUid) {
                io.to(sid).emit('dm typing', {
                    fromUid: me.uid,
                    name: me.name,
                    typing: !!payload.typing
                });
                break;
            }
        }
    });

    socket.on('disconnect', () => {
        const u = users.get(socket.id);
        if (u) {
            const set = rooms.get(u.room);
            if (set) {
                set.delete(socket.id);
                if (set.size === 0) rooms.delete(u.room);
                else {
                    socket.to(u.room).emit('system', {
                        text: `${u.name} đã rời phòng`,
                        time: Date.now()
                    });
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

app.get('/stats', (req, res) => {
    res.json({
        online: users.size,
        uniqueUsers: usersByUid.size,
        rooms: [...rooms.entries()].map(([name, set]) => ({
            name,
            count: set.size
        })),
        dms: dms.size
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Chat server v2 on port ${PORT}`);
    console.log(`  Local: http://localhost:${PORT}\n`);
});
