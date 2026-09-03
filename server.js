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
let bettingRound = 1; // 1차 베팅 / 2차 베팅 구분
let betCountInRound = 0; // 해당 라운드 베팅 진행 횟수

// 족보 점수 계산 함수
function getJokboScore(cards) {
    if (!cards || cards.length < 2) return { score: 0, name: '노족보' };

    const c1 = cards[0];
    const c2 = cards[1];

    // 삼광 (3, 8 광)
    if ((c1.month === 3 && c1.kwang && c2.month === 8 && c2.kwang) ||
        (c1.month === 8 && c1.kwang && c2.month === 3 && c2.kwang)) {
        return { score: 1000, name: '38광땡' };
    }
    // 광땡 (1,3 또는 1,8 광)
    if ((c1.kwang && c2.kwang) && (c1.month === 1 || c2.month === 1)) {
        return { score: 900, name: '광땡' };
    }
    // 땡 (같은 월)
    if (c1.month === c2.month) {
        return { score: 800 + c1.month, name: `${c1.month}땡` };
    }
    // 알리 (1, 2)
    if ((c1.month === 1 && c2.month === 2) || (c1.month === 2 && c2.month === 1)) return { score: 700, name: '알리' };
    // 독사 (1, 4)
    if ((c1.month === 1 && c2.month === 4) || (c1.month === 4 && c2.month === 1)) return { score: 690, name: '독사' };
    // 구빙 (1, 9)
    if ((c1.month === 1 && c2.month === 9) || (c1.month === 9 && c2.month === 1)) return { score: 680, name: '구빙' };
    // 장빙 (1, 10)
    if ((c1.month === 1 && c2.month === 10) || (c1.month === 10 && c2.month === 1)) return { score: 670, name: '장빙' };
    // 장사 (4, 10)
    if ((c1.month === 4 && c2.month === 10) || (c1.month === 10 && c2.month === 4)) return { score: 660, name: '장사' };
    // 세륙 (4, 6)
    if ((c1.month === 4 && c2.month === 6) || (c1.month === 6 && c2.month === 4)) return { score: 650, name: '세륙' };

    // 끗 계산
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
        selectedCards: [],
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
                player.selectedCards = [];
                totalPot += BASE_BET;
                player.cards = [shuffled[idx * 3], shuffled[idx * 3 + 1], shuffled[idx * 3 + 2]];
                
                io.to(player.id).emit('gameStart', {
                    cards: player.cards,
                    money: player.money,
                    totalPot: totalPot,
                    isMyTurn: idx === currentTurnIndex
                });
            });

            io.emit('status', `🎴 게임 시작! 2장을 선택 후 1차 베팅을 시작하세요.`);
            readyPlayers.clear();
        }
    });

    // 플레이어가 승부에 쓸 2장 선택 완료 시
    socket.on('selectCards', (indices) => {
        const p = players.find(player => player.id === socket.id);
        if (!p) return;
        p.selectedCards = [p.cards[indices[0]], p.cards[indices[1]]];
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

        // 1차 베팅 종료 시 -> 패 1장 공개
        if (bettingRound === 1 && betCountInRound >= players.length) {
            bettingRound = 2;
            betCountInRound = 0;
            currentTurnIndex = 0;

            // 각 유저의 2장 중 1장만 공개 정보 전달
            const openCardsInfo = players.map(p => ({
                playerNum: p.playerNum,
                openCard: p.selectedCards[0] || p.cards[0]
            }));

            io.emit('openOneCard', openCardsInfo);
            io.emit('status', `📢 1차 베팅 완료! 오픈된 패 1장을 확인하고 2차(최종) 베팅을 시작합니다.`);
        } 
        // 2차 베팅 종료 시 -> 최종 승부 (쇼다운)
        else if (bettingRound === 2 && betCountInRound >= players.length) {
            let activePlayers = players.filter(p => !p.isFolded);
            
            // 모든 플레이어 선택패 기본 세팅 보장
            activePlayers.forEach(p => {
                if (p.selectedCards.length < 2) p.selectedCards = [p.cards[0], p.cards[1]];
            });

            let winner = activePlayers[0];
            let bestJokbo = getJokboScore(winner.selectedCards);

            for (let i = 1; i < activePlayers.length; i++) {
                let currentJokbo = getJokboScore(activePlayers[i].selectedCards);
                if (currentJokbo.score > bestJokbo.score) {
                    winner = activePlayers[i];
                    bestJokbo = currentJokbo;
                }
            }

            winner.money += totalPot;
            io.to(winner.id).emit('updateMoney', { money: winner.money });

            const showdownData = players.map(p => ({
                playerNum: p.playerNum,
                cards: p.selectedCards.length === 2 ? p.selectedCards : [p.cards[0], p.cards[1]],
                jokboName: getJokboScore(p.selectedCards.length === 2 ? p.selectedCards : [p.cards[0], p.cards[1]]).name
            }));

            io.emit('showdown', {
                winnerNum: winner.playerNum,
                winningPot: totalPot,
                showdownData: showdownData
            });

            return;
        } else {
            // 다음 턴 넘기기
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
