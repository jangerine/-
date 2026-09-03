const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const INITIAL_MONEY = 100000; // 초기 10만원
const REFILL_MONEY = 50000;   // 파산 시 충전금 5만원
const BASE_BET = 5000;        // 판돈(참가비) 5천원

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
let maxPlayers = 2;
let readyPlayers = new Set();
let totalPot = 0;

io.on('connection', (socket) => {
    if (players.length >= maxPlayers && players.length > 0) {
        socket.emit('status', '이미 게임이 진행 중이거나 방이 가득 찼습니다.');
        return;
    }

    const playerNum = players.length + 1;
    const isHost = playerNum === 1;

    const newPlayer = {
        id: socket.id,
        playerNum: playerNum,
        money: INITIAL_MONEY
    };
    players.push(newPlayer);

    socket.emit('init', { isHost, playerNum, money: INITIAL_MONEY });
    io.emit('status', `현재 접속 인원: ${players.length} / ${maxPlayers} 명`);

    socket.on('setMaxPlayers', (num) => {
        if (socket.id === players[0]?.id) {
            maxPlayers = parseInt(num);
            io.emit('updateMaxPlayers', maxPlayers);
            io.emit('status', `방장이 목표 인원을 ${maxPlayers}명으로 설정했습니다.`);
        }
    });

    socket.on('ready', () => {
        const p = players.find(player => player.id === socket.id);
        if (!p) return;

        // 준비 시점에 기본 판돈보다 돈이 적으면 자동 충전
        if (p.money < BASE_BET) {
            p.money += REFILL_MONEY;
            socket.emit('refillMoney', { money: p.money, refilledAmount: REFILL_MONEY });
            io.emit('status', `💸 ${p.playerNum}번 유저가 파산하여 지원금 5만원을 받았습니다!`);
        }

        readyPlayers.add(socket.id);
        io.emit('status', `준비 완료: ${readyPlayers.size} / ${maxPlayers} 명`);

        if (readyPlayers.size === maxPlayers && maxPlayers >= 2) {
            totalPot = 0;
            const shuffled = [...DECK].sort(() => Math.random() - 0.5);

            players.forEach((player, idx) => {
                player.money -= BASE_BET;
                totalPot += BASE_BET;
                const pCards = [shuffled[idx * 3], shuffled[idx * 3 + 1], shuffled[idx * 3 + 2]];
                
                io.to(player.id).emit('gameStart', {
                    cards: pCards,
                    money: player.money,
                    totalPot: totalPot
                });
            });

            io.emit('status', `🎴 게임 시작! 기본 판돈(5,000원) 차감 완료. 총 판돈: ${totalPot.toLocaleString()}원`);
            readyPlayers.clear();
        }
    });

    socket.on('bet', (data) => {
        const p = players.find(player => player.id === socket.id);
        if (!p) return;

        let betAmount = 0;
        if (data.type === '하프') betAmount = Math.floor(totalPot * 0.5);
        else if (data.type === '콜') betAmount = 10000;
        else if (data.type === '다이') betAmount = 0;

        if (betAmount > p.money) betAmount = p.money; // 올인

        p.money -= betAmount;
        totalPot += betAmount;

        socket.emit('updateMoney', { money: p.money });
        io.emit('updatePot', { totalPot: totalPot });
        io.emit('opponentAction', { playerNum: p.playerNum, type: data.type, betAmount: betAmount });

        // 베팅 후 잔액이 0원이 되면 즉시 5만원 자동 지원
        if (p.money <= 0) {
            p.money += REFILL_MONEY;
            socket.emit('refillMoney', { money: p.money, refilledAmount: REFILL_MONEY });
            io.emit('status', `🚨 ${p.playerNum}번 유저 올인 파산! 구제 지원금 5만원 지급 완료.`);
        }
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        readyPlayers.delete(socket.id);

        if (players.length === 0) {
            maxPlayers = 2;
            totalPot = 0;
        } else {
            io.emit('status', `유저 퇴장. 현재 접속 인원: ${players.length} / ${maxPlayers} 명`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: ${PORT}`));
