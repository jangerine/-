const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

let players = [];

io.on('connection', (socket) => {
    console.log('유저 접속:', socket.id);

    if (players.length < 2) {
        players.push(socket.id);
        socket.emit('playerNo', players.length);
    } else {
        socket.emit('status', '방이 가득 찼습니다.');
    }

    socket.on('bet', (data) => {
        socket.broadcast.emit('opponentBet', data);
    });

    socket.on('disconnect', () => {
        console.log('유저 퇴장:', socket.id);
        players = players.filter(id => id !== socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 서버가 실행 중입니다. 포트: ${PORT}`);
});
