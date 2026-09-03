const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const DECK = [
    { month: 1, kwang: true },  { month: 1, kwang: false },
    { month: 2, kwang: false }, { month: 2, kwang: false },
    { month: 3, kwang: true },  { month: 3, kwang: false },
    { month: 4, kwang: false }, { month: 4, kwang: false },
    { month: 5, kwang: false }, { month: 5, kwang: false },
    { month: 6, kwang: false }, { month: 6, kwang: false },
    { month: 7, kwang: false }, { month: 7, kwang: false },
    { month: 8, kwang: true },  { month: 8, kwang: false },
    { month: 9, kwang: false }, { month: 9, kwang: false },
    { month: 10, kwang: false },{ month: 10, kwang: false }
];

let players = [];
let readyPlayers = new Set();

io.on('connection', (socket) => {
    if (players.length < 2) {
        players.push(socket.id);
        socket.emit('playerNo', players.length);
    } else {
        socket.emit('status', '방이 가득 찼습니다.');
    }

    // 둘 다 준비하면 카드를 3장씩 랜덤으로 나눠줌
    socket.on('ready', () => {
        readyPlayers.add(socket.id);
        if (readyPlayers.size === 2) {
            const shuffled = [...DECK].sort(() => Math.random() - 0.5);
            const p1Cards = [shuffled[0], shuffled[1], shuffled[2]];
            const p2Cards = [shuffled[3], shuffled[4], shuffled[5]];

            io.to(players[0]).emit('dealCards', p1Cards);
            io.to(players[1]).emit('dealCards', p2Cards);
            readyPlayers.clear();
        }
    });

    socket.on('bet', (data) => {
        socket.broadcast.emit('opponentAction', data);
    });

    socket.on('disconnect', () => {
        players = players.filter(id => id !== socket.id);
        readyPlayers.delete(socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: ${PORT}`));
