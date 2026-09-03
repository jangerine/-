const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 1. 정적 파일 및 메인 경로(Cannot GET / 에러 방지) 설정
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. 화투패 데이터 (20장)
const ORIGINAL_DECK = [
    { month: 1, kwang: true, id: 1 },  { month: 1, kwang: false, id: 2 },
    { month: 2, kwang: false, id: 3 }, { month: 2, kwang: false, id: 4 },
    { month: 3, kwang: true, id: 5 },  { month: 3, kwang: false, id: 6 },
    { month: 4, kwang: false, id: 7 }, { month: 4, kwang: false, id: 8 },
    { month: 5, kwang: false, id: 9 }, { month: 5, kwang: false, id: 10 },
    { month: 6, kwang: false, id: 11 }, { month: 6, kwang: false, id: 12 },
    { month: 7, kwang: false, id: 13 }, { month: 7, kwang: false, id: 14 },
    { month: 8, kwang: true, id: 15 }, { month: 8, kwang: false, id: 16 },
    { month: 9, kwang: false, id: 17 }, { month: 9, kwang: false, id: 18 },
    { month: 10, kwang: false, id: 19 }, { month: 10, kwang: false, id: 20 }
];

// 3. 2장 조합 족보 계산 로직
function calculateJokbo(card1, card2) {
    const m1 = card1.month, m2 = card2.month;
    const k1 = card1.kwang, k2 = card2.kwang;

    // 광땡
    if (k1 && k2) {
        if ((m1 === 3 && m2 === 8) || (m1 === 8 && m2 === 3)) return { name: "38광땡", rank: 100 };
        if ((m1 === 1 && m2 === 8) || (m1 === 8 && m2 === 1)) return { name: "18광땡", rank: 99 };
        if ((m1 === 1 && m2 === 3) || (m1 === 3 && m2 === 1)) return { name: "13광땡", rank: 98 };
    }

    // 땡 (1땡 ~ 장땡)
    if (m1 === m2) return { name: `${m1}땡`, rank: 80 + m1 };

    // 알리, 독사, 구빙, 장빙, 장사, 세륙
    const sorted = [m1, m2].sort((a, b) => a - b);
    const pair = `${sorted[0]}-${sorted[1]}`;

    if (pair === "1-2") return { name: "알리", rank: 70 };
    if (pair === "1-5") return { name: "독사", rank: 69 };
    if (pair === "1-9") return { name: "구빙", rank: 68 };
    if (pair === "1-10") return { name: "장빙", rank: 67 };
    if (pair === "4-10") return { name: "장사", rank: 66 };
    if (pair === "4-6") return { name: "세륙", rank: 65 };

    // 특수 족보 (암행어사, 땡잡이, 구사)
    if (pair === "4-7") return { name: "암행어사", rank: 60 };
    if (pair === "3-7") return { name: "땡잡이", rank: 50 };
    if (pair === "4-9") return { name: "구사", rank: 40 };

    // 끗
    const kkut = (m1 + m2) % 10;
    return { name: kkut === 0 ? "망통" : `${kkut}끗`, rank: kkut };
}

// 3장 중 2장 선택 가능한 조합 3개 계산
function getPossibleJokbos(cards) {
    const [c1, c2, c3] = cards;
    return [
        { cards: [c1, c2], ...calculateJokbo(c1, c2) },
        { cards: [c1, c3], ...calculateJokbo(c1, c3) },
        { cards: [c2, c3], ...calculateJokbo(c2, c3) }
    ];
}

const rooms = {};

// 4. Socket.io 실시간 멀티플레이 이벤트
io.on('connection', (socket) => {
    // 🏠 방 만들기
    socket.on('createRoom', ({ nickname }) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomCode] = {
            host: socket.id,
            players: [{ id: socket.id, name: nickname, money: 100000, hand: [], openCard: null, selectedJokbo: null }],
            pot: 0,
            turnIndex: 0,
            deck: [],
            gameState: 'WAITING'
        };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode });
    });

    // 🚪 방 참여하기
    socket.on('joinRoom', ({ nickname, roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('errorMsg', '존재하지 않는 방입니다.');
        if (room.players.length >= 2) return socket.emit('errorMsg', '방이 가득 찼습니다.');

        room.players.push({ id: socket.id, name: nickname, money: 100000, hand: [], openCard: null, selectedJokbo: null });
        socket.join(roomCode);

        socket.emit('roomJoined', { roomCode });
        io.to(room.host).emit('playerJoined', { opponentName: nickname });
    });

    // 🎮 게임 시작 (방장전용)
    socket.on('startGame', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.players.length < 2) return;

        // 덱 셔플 및 판돈 기본 베팅 (각 1,000원)
        room.deck = [...ORIGINAL_DECK].sort(() => Math.random() - 0.5);
        room.pot = 2000;
        room.gameState = 'PLAYING';

        room.players.forEach(p => {
            p.money -= 1000;
            p.hand = [room.deck.pop(), room.deck.pop()];
            p.openCard = null;
            p.selectedJokbo = null;
        });

        room.players.forEach((p) => {
            io.to(p.id).emit('roundStarted', {
                yourHand: p.hand,
                yourMoney: p.money,
                pot: room.pot
            });
        });
    });

    // 🎴 공개할 1번째 카드 선택
    socket.on('selectOpenCard', ({ roomCode, cardIndex }) => {
        const room = rooms[roomCode];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        const opponent = room.players.find(p => p.id !== socket.id);

        player.openCard = player.hand[cardIndex];

        if (opponent.openCard) {
            room.turnIndex = 0;
            room.players.forEach((p, idx) => {
                const opp = room.players.find(o => o.id !== p.id);
                io.to(p.id).emit('openCardRevealed', {
                    opponentOpenCard: opp.openCard,
                    isMyTurn: idx === room.turnIndex
                });
            });
        }
    });

    // 💰 베팅 처리 (하프, 콜, 다이)
    socket.on('playerBet', ({ roomCode, betType }) => {
        const room = rooms[roomCode];
        if (!room) return;

        const playerIdx = room.players.findIndex(p => p.id === socket.id);
        const player = room.players[playerIdx];
        const opponent = room.players.find(p => p.id !== socket.id);

        if (betType === '다이') {
            opponent.money += room.pot;
            io.to(roomCode).emit('showdownResult', {
                myJokbo: "기권",
                oppJokbo: "승리",
                resultMessage: `${player.name}님의 다이! ${opponent.name}님이 판돈을 획득했습니다.`,
                yourMoney: player.money
            });
            return;
        }

        const betAmount = betType === '하프' ? Math.floor(room.pot / 2) : 1000;
        player.money -= betAmount;
        room.pot += betAmount;

        if (room.gameState === 'BETTING_1') {
            room.gameState = 'SELECTING_JOKBO';
            room.players.forEach(p => {
                const thirdCard = room.deck.pop();
                p.hand.push(thirdCard);
                const jokbos = getPossibleJokbos(p.hand);
                io.to(p.id).emit('receiveThirdCard', { thirdCard, possibleJokbos: jokbos });
            });
        } else {
            room.gameState = 'BETTING_1';
            room.turnIndex = (room.turnIndex + 1) % 2;
            room.players.forEach((p, idx) => {
                io.to(p.id).emit('updateBetState', {
                    pot: room.pot,
                    yourMoney: p.money,
                    isMyTurn: idx === room.turnIndex
                });
            });
        }
    });

    // 🎯 최종 족보 선택 수신 및 승패 판정
    socket.on('selectFinalJokbo', ({ roomCode, jokbo }) => {
        const room = rooms[roomCode];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        player.selectedJokbo = jokbo;

        const p1 = room.players[0];
        const p2 = room.players[1];

        if (p1.selectedJokbo && p2.selectedJokbo) {
            let winner = null;
            let p1Rank = p1.selectedJokbo.rank;
            let p2Rank = p2.selectedJokbo.rank;

            // 암행어사 예외 처리
            if (p1.selectedJokbo.name === "암행어사" && (p2.selectedJokbo.name === "13광땡" || p2.selectedJokbo.name === "18광땡")) p1Rank = 999;
            if (p2.selectedJokbo.name === "암행어사" && (p1.selectedJokbo.name === "13광땡" || p1.selectedJokbo.name === "18광땡")) p2Rank = 999;

            if (p1Rank > p2Rank) winner = p1;
            else if (p2Rank > p1Rank) winner = p2;

            if (winner) {
                winner.money += room.pot;
            } else {
                p1.money += room.pot / 2;
                p2.money += room.pot / 2;
            }

            room.players.forEach(p => {
                const opp = room.players.find(o => o.id !== p.id);
                const isWinner = winner && winner.id === p.id;
                const isDraw = !winner;

                io.to(p.id).emit('showdownResult', {
                    myJokbo: p.selectedJokbo.name,
                    oppJokbo: opp.selectedJokbo.name,
                    resultMessage: isDraw ? "무승부! 판돈을 나눕니다." : (isWinner ? "🎉 승리하셨습니다!" : "패배하셨습니다."),
                    yourMoney: p.money
                });
            });
        }
    });
});

// Render 포트 및 로컬 포트 호환 설정
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`섯다 멀티 서버 실행 중: http://localhost:${PORT}`));
