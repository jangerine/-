const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let maxPlayers = 2;
let players = []; 
let gameState = 'WAITING'; 
let deck = [];
let currentTurnIndex = 0;
let totalPot = 0;
let lastBetAmount = 0;

function createDeck() {
    const newDeck = [];
    for (let month = 1; month <= 10; month++) {
        newDeck.push({ month: month, kwang: (month === 1 || month === 3 || month === 8) });
        newDeck.push({ month: month, kwang: false });
    }
    return newDeck.sort(() => Math.random() - 0.5);
}

function getJokbo(card1, card2) {
    const c1 = card1.month;
    const c2 = card2.month;
    const k1 = card1.kwang;
    const k2 = card2.kwang;

    if ((c1 === 3 && c2 === 8 && k1 && k2) || (c1 === 8 && c2 === 3 && k1 && k2)) {
        return { rank: 100, name: '38광땡' };
    }
    if ((k1 && k2) && ((c1 === 1 && c2 === 8) || (c1 === 8 && c2 === 1) || (c1 === 1 && c2 === 3) || (c1 === 3 && c2 === 1))) {
        return { rank: 90, name: '광땡' };
    }

    if (c1 === c2) {
        return { rank: 80 + c1, name: `${c1}땡` };
    }

    const pair = [c1, c2].sort((a, b) => a - b).join(',');
    if (pair === '1,2') return { rank: 70, name: '알리' };
    if (pair === '1,4') return { rank: 69, name: '독사' };
    if (pair === '1,9') return { rank: 68, name: '구빙' };
    if (pair === '1,10') return { rank: 67, name: '장빙' };
    if (pair === '4,10') return { rank: 66, name: '장사' };
    if (pair === '4,6') return { rank: 65, name: '세륙' };

    const kkut = (c1 + c2) % 10;
    if (kkut === 0) return { rank: 1, name: '망통' };
    return { rank: 10 + kkut, name: `${kkut}끗` };
}

io.on('connection', (socket) => {
    let player = players.find(p => p.id === socket.id);
    if (!player) {
        player = {
            id: socket.id,
            playerNum: players.length + 1,
            money: 100000,
            isReady: false,
            cards: [],
            openCardIndex: 0,
            finalCardIndex: -1, // 마지막 쇼다운용 선택 패 인덱스
            isFolded: false,
            isHost: players.length === 0
        };
        players.push(player);
    }

    socket.emit('init', {
        playerNum: player.playerNum,
        isHost: player.isHost,
        money: player.money
    });

    socket.on('setMaxPlayers', (num) => {
        if (player.isHost && gameState === 'WAITING') {
            maxPlayers = parseInt(num);
            io.emit('updateMaxPlayers', maxPlayers);
            io.emit('status', `방장이 최대 인원을 ${maxPlayers}명으로 변경했습니다.`);
        }
    });

    socket.on('ready', () => {
        player.isReady = true;
        const readyCount = players.filter(p => p.isReady).length;
        
        io.emit('status', `플레이어 (${readyCount}/${maxPlayers}) 준비 완료`);

        if (readyCount === maxPlayers && gameState === 'WAITING') {
            startFirstRound();
        }
    });

    socket.on('selectOpenCard', (cardIndex) => {
        player.openCardIndex = cardIndex;
    });

    socket.on('selectFinalCard', (cardIndex) => {
        // 1차 때 공개한 패는 선택 불가
        if (cardIndex !== player.openCardIndex) {
            player.finalCardIndex = cardIndex;
            
            // 모든 안 죽은 플레이어가 2번째 승부 패 선택 완료했는지 확인
            const activePlayers = players.filter(p => !p.isFolded);
            const allSelected = activePlayers.every(p => p.finalCardIndex !== -1 && p.finalCardIndex !== undefined);
            
            if (allSelected) {
                handleShowdown();
            }
        }
    });

    socket.on('bet', (data) => {
        if (gameState !== 'BETTING1' && gameState !== 'BETTING2') return;
        if (players[currentTurnIndex].id !== socket.id) return;

        const betType = data.type;
        const currentBet = 10000; 

        if (betType === '하프') {
            const addBet = Math.floor(totalPot * 0.5);
            player.money -= (lastBetAmount + addBet);
            totalPot += (lastBetAmount + addBet);
            lastBetAmount += addBet;
        } else if (betType === '콜') {
            player.money -= lastBetAmount;
            totalPot += lastBetAmount;
        } else if (betType === '다이') {
            player.isFolded = true;
        }

        io.emit('updateMoney', { playerNum: player.playerNum, money: player.money });
        io.emit('updatePot', { totalPot: totalPot });
        io.emit('opponentAction', { playerNum: player.playerNum, type: betType });

        const activePlayers = players.filter(p => !p.isFolded);
        if (activePlayers.length === 1) {
            endGame(activePlayers[0]);
            return;
        }

        nextTurn();
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        if (players.length > 0 && !players.some(p => p.isHost)) {
            players[0].isHost = true;
        }
        if (players.length < maxPlayers && gameState !== 'WAITING') {
            gameState = 'WAITING';
            io.emit('status', '플레이어가 퇴장하여 게임이 중단되었습니다.');
        }
    });
});

function startFirstRound() {
    gameState = 'BETTING1';
    deck = createDeck();
    totalPot = 0;
    lastBetAmount = 10000;

    const seedMoney = 10000;
    players.forEach(p => {
        p.money -= seedMoney;
        totalPot += seedMoney;
        p.cards = [deck.pop(), deck.pop()];
        p.isFolded = false;
        p.openCardIndex = 0;
        p.finalCardIndex = -1;
    });

    currentTurnIndex = 0;

    players.forEach((p, idx) => {
        io.to(p.id).emit('gameStart', {
            cards: p.cards,
            money: p.money,
            totalPot: totalPot,
            isMyTurn: idx === currentTurnIndex
        });
    });

    io.emit('status', '게임 시작! 각자 2장의 패를 받았습니다. 1장을 골라 공개해주세요.');
}

function nextTurn() {
    do {
        currentTurnIndex = (currentTurnIndex + 1) % players.length;
    } while (players[currentTurnIndex].isFolded);

    const activePlayers = players.filter(p => !p.isFolded);
    
    if (currentTurnIndex === 0) {
        if (gameState === 'BETTING1') {
            startSecondRound();
            return;
        } else if (gameState === 'BETTING2') {
            startFinalSelection();
            return;
        }
    }

    players.forEach((p, idx) => {
        io.to(p.id).emit('turnUpdate', { isMyTurn: idx === currentTurnIndex });
    });
}

function startSecondRound() {
    gameState = 'BETTING2';

    const openCardsInfo = players.map(p => ({
        playerNum: p.playerNum,
        openCard: p.cards[p.openCardIndex]
    }));
    io.emit('openOneCard', openCardsInfo);

    players.forEach(p => {
        if (!p.isFolded) {
            p.cards.push(deck.pop());
            io.to(p.id).emit('receiveThirdCard', { 
                allCards: p.cards,
                openCardIndex: p.openCardIndex
            });
        }
    });

    io.emit('status', '3번째 패가 지급되었습니다! 2차 베팅을 진행합니다.');

    currentTurnIndex = 0;
    while (players[currentTurnIndex].isFolded) {
        currentTurnIndex = (currentTurnIndex + 1) % players.length;
    }

    players.forEach((p, idx) => {
        io.to(p.id).emit('turnUpdate', { isMyTurn: idx === currentTurnIndex });
    });
}

function startFinalSelection() {
    gameState = 'FINAL_SELECT';
    io.emit('status', '베팅 완료! 승부할 2번째 카드를 선택해주세요. (1차 공개 패 제외)');
    io.emit('requestFinalCardSelect');
}

function handleShowdown() {
    gameState = 'WAITING';

    let winner = null;
    let bestJokbo = { rank: -1, name: '' };
    const showdownData = [];

    players.forEach(p => {
        if (!p.isFolded) {
            // [1차 공개 패] + [최종 선택한 2번째 패] 2개로만 족보 계산
            const card1 = p.cards[p.openCardIndex];
            const card2 = p.cards[p.finalCardIndex];
            const jokbo = getJokbo(card1, card2);

            showdownData.push({
                playerNum: p.playerNum,
                jokboName: jokbo.name
            });

            if (jokbo.rank > bestJokbo.rank) {
                bestJokbo = jokbo;
                winner = p;
            }
        }
    });

    if (winner) {
        winner.money += totalPot;
        io.emit('showdown', {
            winnerNum: winner.playerNum,
            winningPot: totalPot,
            showdownData: showdownData
        });

        players.forEach(p => {
            p.isReady = false;
            if (p.money <= 0) {
                p.money = 100000;
                io.to(p.id).emit('refillMoney', { money: p.money, refilledAmount: 100000 });
            } else {
                io.to(p.id).emit('updateMoney', { money: p.money });
            }
        });
    }
}

function endGame(winner) {
    gameState = 'WAITING';
    winner.money += totalPot;

    io.emit('showdown', {
        winnerNum: winner.playerNum,
        winningPot: totalPot,
        showdownData: [{ playerNum: winner.playerNum, jokboName: '상대 기권 승리' }]
    });

    players.forEach(p => {
        p.isReady = false;
        if (p.money <= 0) {
            p.money = 100000;
            io.to(p.id).emit('refillMoney', { money: p.money, refilledAmount: 100000 });
        } else {
            io.to(p.id).emit('updateMoney', { money: p.money });
        }
    });
}

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`섯다 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
