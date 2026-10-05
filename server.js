const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ============ STATE ============
const users = new Map();   // socketId -> { id, name, room, color }
const rooms = new Map();   // roomName -> Set(socketId)
const history = new Map(); // roomName -> Array(message)  (giữ 100 tin gần nhất)

const COLORS = [
    '#e11d48', '#db2777', '#c026d3', '#9333ea', '#7c3aed',
    '#4f46e5', '#2563eb', '#0284c7', '#0891b2', '#0d9488',
    '#059669', '#16a34a', '#ca8a04', '#ea580c', '#dc2626'
];

function pickColor() {
    return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function addHistory(room, msg) {
    if (!history.has(room)) history.set(room, []);
    const arr = history.get(room);
    arr.push(msg);
    if (arr.length > 100) arr.shift();
}

function userList(room) {
    const ids = rooms.get(room) || new Set();
    return [...ids].map(id => {
        const u = users.get(id);
        return u ? { id: u.id, name: u.name, color: u.color } : null;
    }).filter(Boolean);
}

function broadcastUserList(room) {
    io.to(room).emit('user list', userList(room));
}

// ============ SOCKET ============
io.on('connection', (socket) => {
    console.log('[+] connected:', socket.id);

    socket.on('join', ({ name, room }) => {
        name = String(name || '').trim().slice(0, 24) || 'Ẩn danh';
        room = String(room || '').trim().slice(0, 32) || 'general';

        // rời phòng cũ nếu có
        const old = users.get(socket.id);
        if (old && old.room && old.room !== room) {
            socket.leave(old.room);
            const set = rooms.get(old.room);
            if (set) {
                set.delete(socket.id);
                if (set.size === 0) rooms.delete(old.room);
                else broadcastUserList(old.room);
            }
        }

        const user = {
            id: socket.id,
            name,
            room,
            color: pickColor()
        };
        users.set(socket.id, user);

        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(socket.id);

        socket.join(room);

        // gửi lịch sử cho người mới
        socket.emit('history', history.get(room) || []);
        socket.emit('joined', { name, room, color: user.color });

        // thông báo
        socket.to(room).emit('system', {
            text: `${name} đã vào phòng`,
            time: Date.now()
        });

        broadcastUserList(room);
        console.log(`[join] ${name} -> #${room}`);
    });

    socket.on('message', (payload) => {
        const u = users.get(socket.id);
        if (!u) return;
        const text = String(payload?.text || '').slice(0, 2000).trim();
        if (!text) return;

        const msg = {
            id: socket.id + '_' + Date.now(),
            userId: socket.id,
            name: u.name,
            color: u.color,
            text,
            time: Date.now()
        };
        addHistory(u.room, msg);
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

    socket.on('leave', () => {
        const u = users.get(socket.id);
        if (!u) return;
        const set = rooms.get(u.room);
        socket.leave(u.room);
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
            console.log(`[-] ${u.name} left #${u.room}`);
        }
    });
});

// ============ STATS ============
app.get('/stats', (req, res) => {
    res.json({
        online: users.size,
        rooms: [...rooms.entries()].map(([name, set]) => ({
            name,
            count: set.size,
            history: (history.get(name) || []).length
        }))
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Chat server running on port ${PORT}`);
    console.log(`  Local: http://localhost:${PORT}\n`);
});
