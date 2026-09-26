const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// user store tạm trong RAM — reset khi restart server
const users = {
  admin: { pass: '123456' },
  test:  { pass: 'test'  },
};

const sessions = new Map(); // socket.id → username

io.on('connection', (socket) => {
  console.log('[+] connected:', socket.id);

  socket.on('register', ({ user, pass }, cb) => {
    if (!user || !pass) return cb({ ok: false, msg: 'Điền đầy đủ thông tin' });
    if (users[user])    return cb({ ok: false, msg: 'Tên đã tồn tại' });
    users[user] = { pass };
    console.log('[register]', user);
    cb({ ok: true, msg: 'Đăng ký thành công' });
  });

  socket.on('login', ({ user, pass }, cb) => {
    if (!user || !pass) return cb({ ok: false, msg: 'Điền đầy đủ thông tin' });
    const u = users[user];
    if (!u)            return cb({ ok: false, msg: 'Tài khoản không tồn tại' });
    if (u.pass !== pass) return cb({ ok: false, msg: 'Sai mật khẩu' });
    sessions.set(socket.id, user);
    console.log('[login]', user, socket.id);
    cb({ ok: true, msg: 'Đăng nhập thành công', user });
  });

  socket.on('whoami', (cb) => {
    cb({ user: sessions.get(socket.id) || null });
  });

  socket.on('logout', (cb) => {
    const u = sessions.get(socket.id);
    sessions.delete(socket.id);
    console.log('[logout]', u);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('disconnect', () => {
    sessions.delete(socket.id);
    console.log('[-] disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server on http://localhost:' + PORT));
