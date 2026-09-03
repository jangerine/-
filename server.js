const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const INITIAL_MONEY = 100000;
const REFILL_MONEY = 50000;
const BASE_BET = 5000;

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
let currentTurnIndex = 0;
let bettingRound = 1;
let betCountInRound = 0;

// 족보 점수 및 이름 계산 함수 (3장 중 최선의 2장 조합)
function getBestJokbo(cards) {
    if (!cards || cards.length < 2) return { score: 0, name: '노족보' };

    let best = { score: -1, name: '' };
    const combos = [
        [cards[0], cards[1]],
        [cards[0], cards[2]],
        [cards[1], cards[2]]
    ];

    combos.forEach(combo => {
        const res = calcTwoCards(combo[0], combo[1]);
        if (res.score > best.score) {
            best = res;
        }
    });

    return best;
}

function calcTwoCards(c1, c2) {
    if ((c1.month === 3 && c1.kwang && c2.month === 8 && c2.kwang) ||
        (c1.month === 8 && c1.kwang && c2.month === 3 && c2.kwang)) {
        return { score: 1000, name: '38광땡' };
    }
    if ((c1.kwang && c2.kwang) && (c1.month === 1 || c2.month === 1)) {
        return { score: 900, name: '광땡' };
    }
    if (c1.month === c2.month) {
        return { score: 800 + c1.month, name: `${c1.month}땡` };
    }
    if ((c1.month === 1 && c2.month === 2) || (c1.month === 2 && c2.month === 1)) return { score: 700, name: '알리' };
    if ((c1.month === 1 && c2.month === 4) || (c1.month === 4 && c2.month === 1)) return { score: 690, name: '독사' };
    if ((c1.month === 1 && c2.month === 9) || (c1.month === 9 && c2.month === 1)) return { score: 680, name: '구빙' };
    if ((c1.month === 1 && c2.month === 10) || (c1.month === 10 && c2.month === 1)) return { score: 670, name: '장빙' };
    if ((c1.month === 4 && c2.month === 10) || (c1.month === 10 && c2.month === 4)) return { score: 660, name: '장사' };
    if ((c1.month === 4 && c2.month === 6) || (c1.month === 6 && c2.month === 4)) return { score: 650, name: '세륙' };

    const sum = (c1.month + c2.month) % 10;
    if (sum === 0) return { score: 100, name: '망통' };
    return { score: 200 + sum, name: `${sum}끗` };
}

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
        money: INITIAL_MONEY,
        cards: [],
        openCardIndex: 0,
        isFolded: false
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

        if (p.money < BASE_BET) {
            p.money += REFILL_MONEY;
            socket.emit('refillMoney', { money: p.money, refilledAmount: REFILL_MONEY });
            io.emit('status', `💸 ${p.playerNum}번 유저가 파산하여 지원금 5만원을 지급받았습니다!`);
        }

        readyPlayers.add(socket.id);
        io.emit('status', `준비 완료: ${readyPlayers.size} / ${maxPlayers} 명`);

        if (readyPlayers.size === maxPlayers && maxPlayers >= 2) {
            totalPot = 0;
            currentTurnIndex = 0;
            bettingRound = 1;
            betCountInRound = 0;
            const shuffled = [...DECK].sort(() => Math.random() - 0.5);

            players.forEach((player, idx) => {
                player.money -= BASE_BET;
                player.isFolded = false;
                player.openCardIndex = 0;
                totalPot += BASE_BET;
                player.cards = [shuffled[idx * 3], shuffled[idx * 3 + 1], shuffled[idx * 3 + 2]];
                
                const bestJokbo = getBestJokbo(player.cards);

                io.to(player.id).emit('gameStart', {
                    cards: player.cards,
                    jokboName: bestJokbo.name, // 내 족보 이름 전달
                    money: player.money,
                    totalPot: totalPot,
                    isMyTurn: idx === currentTurnIndex
                });
            });

            io.emit('status', `🎴 게임 시작! 공개할 패 1장을 터치해 선택 후 1차 베팅을 하세요.`);
            readyPlayers.clear();
        }
    });

    socket.on('selectOpenCard', (index) => {
        const p = players.find(player => player.id === socket.id);
        if (!p) return;
        p.openCardIndex = index;
    });

    socket.on('bet', (data) => {
        const p = players[currentTurnIndex];
        if (!p || p.id !== socket.id) return;

        if (data.type === '다이') {
            p.isFolded = true;
        } else {
            let betAmount = 0;
            if (data.type === '하프') betAmount = Math.floor(totalPot * 0.5);
            else if (data.type === '콜') betAmount = 10000;

            if (betAmount > p.money) betAmount = p.money;

            p.money -= betAmount;
            totalPot += betAmount;

            socket.emit('updateMoney', { money: p.money });
            io.emit('updatePot', { totalPot: totalPot });
        }

        io.emit('opponentAction', { playerNum: p.playerNum, type: data.type });

        betCountInRound++;

        if (bettingRound === 1 && betCountInRound >= players.length) {
            bettingRound = 2;
            betCountInRound = 0;
            currentTurnIndex = 0;

            const openCardsInfo = players.map(p => ({
                playerNum: p.playerNum,
                openCard: p.cards[p.openCardIndex]
            }));

            io.emit('openOneCard', openCardsInfo);
            io.emit('status', `📢 1차 베팅 완료! 선택된 패 1장이 공개되었습니다. 2차(최종) 베팅을 시작합니다.`);
        } 
        else if (bettingRound === 2 && betCountInRound >= players.length) {
            let activePlayers = players.filter(p => !p.isFolded);
            if (activePlayers.length === 0) activePlayers = players;

            let winner = activePlayers[0];
            let bestJokbo = getBestJokbo(winner.cards);

            for (let i = 1; i < activePlayers.length; i++) {
                let currentJokbo = getBestJokbo(activePlayers[i].cards);
                if (currentJokbo.score > bestJokbo.score) {
                    winner = activePlayers[i];
                    bestJokbo = currentJokbo;
                }
            }

            winner.money += totalPot;
            io.to(winner.id).emit('updateMoney', { money: winner.money });

            const showdownData = players.map(p => ({
                playerNum: p.playerNum,
                cards: p.cards,
                jokboName: getBestJokbo(p.cards).name
            }));

            io.emit('showdown', {
                winnerNum: winner.playerNum,
                winningPot: totalPot,
                showdownData: showdownData
            });

            return;
        } else {
            currentTurnIndex = (currentTurnIndex + 1) % players.length;
        }

        players.forEach((player, idx) => {
            io.to(player.id).emit('turnUpdate', {
                isMyTurn: idx === currentTurnIndex,
                currentTurnNum: players[currentTurnIndex].playerNum
            });
        });
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
