const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// 방 관리 객체
const rooms = {};

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

    if ((c1 === 3 && c2 === 8 && k1 && k2) || (c1 === 8 && c2 === 3 && k1 && k2)) return { rank: 100, name: '38광땡' };
    if ((k1 && k2) && ((c1 === 1 && c2 === 8) || (c1 === 8 && c2 === 1) || (c1 === 1 && c2 === 3) || (c1 === 3 && c2 === 1))) return { rank: 90, name: '광땡' };
    if (c1 === c2) return { rank: 80 + c1, name: `${c1}땡` };

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

    // 1. 방 만들기
    socket.on('createRoom', ({ nickname, maxPlayers }) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        
        rooms[roomId] = {
            id: roomId,
            maxPlayers: parseInt(maxPlayers),
            hostId: socket.id,
            gameState: 'WAITING',
            players: [],
            deck: [],
            currentTurnIndex: 0,
            totalPot: 0,
            lastBetAmount: 0
        };

        const player = {
            id: socket.id,
            nickname: nickname || '방장',
            playerNum: 1,
            money: 100000,
            cards: [],
            openCardIndex: -1,
            finalCardIndex: -1,
            isFolded: false,
            isHost: true
        };

        rooms[roomId].players.push(player);
        socket.join(roomId);
        socket.roomId = roomId;

        socket.emit('roomJoined', {
            roomId,
            isHost: true,
            playerNum: 1,
            money: player.money,
            players: rooms[roomId].players
        });
    });

    // 2. 방 참여하기
    socket.on('joinRoom', ({ nickname, roomId }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('errorMsg', '존재하지 않는 방 코드입니다.');
            return;
        }
        if (room.gameState !== 'WAITING') {
            socket.emit('errorMsg', '이미 게임이 진행 중인 방입니다.');
            return;
        }
        if (room.players.length >= room.maxPlayers) {
            socket.emit('errorMsg', '방이 가득 찼습니다.');
            return;
        }

        const player = {
            id: socket.id,
            nickname: nickname || `플레이어${room.players.length + 1}`,
            playerNum: room.players.length + 1,
            money: 100000,
            cards: [],
            openCardIndex: -1,
            finalCardIndex: -1,
            isFolded: false,
            isHost: false
        };

        room.players.push(player);
        socket.join(roomId);
        socket.roomId = roomId;

        socket.emit('roomJoined', {
            roomId,
            isHost: false,
            playerNum: player.playerNum,
            money: player.money,
            players: room.players
        });

        io.to(roomId).emit('updatePlayerList', room.players);
        io.to(roomId).emit('status', `${player.nickname}님이 입장하셨습니다.`);
    });

    // 3. 방장의 게임 시작 요청
    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room || room.hostId !== socket.id) return;
        if (room.players.length < 2) {
            socket.emit('errorMsg', '최소 2명 이상 모여야 게임을 시작할 수 있습니다.');
            return;
        }

        startFirstRound(room);
    });

    // [2단계] 1차 카드 공개
    socket.on('selectOpenCard', (cardIndex) => {
        const room = rooms[socket.roomId];
        if (!room || room.gameState !== 'OPEN_STEP_1') return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) player.openCardIndex = cardIndex;

        const activePlayers = room.players.filter(p => !p.isFolded);
        if (activePlayers.every(p => p.openCardIndex !== -1)) {
            startSecondOpenStep(room);
        }
    });

    // [3단계] 2차 카드 공개 (1차 카드 재선택 불가)
    socket.on('selectFinalCard', (cardIndex) => {
        const room = rooms[socket.roomId];
        if (!room || room.gameState !== 'OPEN_STEP_2') return;

        const player = room.players.find(p => p.id === socket.id);
        if (player && cardIndex !== player.openCardIndex) {
            player.finalCardIndex = cardIndex;

            const activePlayers = room.players.filter(p => !p.isFolded);
            if (activePlayers.every(p => p.finalCardIndex !== -1)) {
                handleShowdown(room);
            }
        }
    });

    // 베팅 처리 (음수 돈 방지 유효성 검사)
    socket.on('bet', (data) => {
        const room = rooms[socket.roomId];
        if (!room || room.gameState !== 'BETTING') return;
        
        const currentPlayer = room.players[room.currentTurnIndex];
        if (currentPlayer.id !== socket.id) return;

        const betType = data.type;
        let requiredBet = 0;

        if (betType === '하프') {
            const addBet = Math.floor(room.totalPot * 0.5);
            requiredBet = room.lastBetAmount + addBet;
            
            if (currentPlayer.money < requiredBet) {
                socket.emit('status', '⚠️ 소지금이 부족하여 하프를 할 수 없습니다.');
                return;
            }
            currentPlayer.money -= requiredBet;
            room.totalPot += requiredBet;
            room.lastBetAmount = requiredBet;

        } else if (betType === '콜') {
            requiredBet = room.lastBetAmount;
            if (currentPlayer.money < requiredBet) requiredBet = currentPlayer.money;
            
            currentPlayer.money -= requiredBet;
            room.totalPot += requiredBet;

        } else if (betType === '다이') {
            currentPlayer.isFolded = true;
        }

        if (currentPlayer.money < 0) currentPlayer.money = 0;

        io.to(room.id).emit('updateMoney', { playerNum: currentPlayer.playerNum, money: currentPlayer.money });
        io.to(room.id).emit('updatePot', { totalPot: room.totalPot });
        io.to(room.id).emit('opponentAction', { nickname: currentPlayer.nickname, type: betType });

        const activePlayers = room.players.filter(p => !p.isFolded);
        if (activePlayers.length === 1) {
            endGame(room, activePlayers[0]);
            return;
        }

        nextBetTurn(room);
    });

    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        room.players = room.players.filter(p => p.id !== socket.id);

        if (room.players.length === 0) {
            delete rooms[roomId];
        } else {
            if (room.hostId === socket.id) {
                room.hostId = room.players[0].id;
                room.players[0].isHost = true;
                io.to(room.players[0].id).emit('grantHost');
            }
            io.to(roomId).emit('updatePlayerList', room.players);
            io.to(roomId).emit('status', '플레이어가 퇴장하였습니다.');
        }
    });
});

function startFirstRound(room) {
    room.gameState = 'BETTING';
    room.deck = createDeck();
    room.totalPot = 0;
    room.lastBetAmount = 10000;

    const seedMoney = 10000;
    room.players.forEach(p => {
        if (p.money < seedMoney) p.money = seedMoney;
        p.money -= seedMoney;
        room.totalPot += seedMoney;
        p.cards = [room.deck.pop(), room.deck.pop()];
        p.isFolded = false;
        p.openCardIndex = -1;
        p.finalCardIndex = -1;
    });

    room.currentTurnIndex = 0;

    room.players.forEach((p, idx) => {
        io.to(p.id).emit('gameStart', {
            cards: p.cards,
            money: p.money,
            totalPot: room.totalPot,
            isMyTurn: idx === room.currentTurnIndex
        });
    });

    io.to(room.id).emit('status', '게임 시작! 2장의 패를 받았습니다. 베팅을 시작합니다.');
}

function nextBetTurn(room) {
    do {
        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
    } while (room.players[room.currentTurnIndex].isFolded);

    if (room.currentTurnIndex === 0) {
        startFirstOpenStep(room);
        return;
    }

    room.players.forEach((p, idx) => {
        io.to(p.id).emit('turnUpdate', { isMyTurn: idx === room.currentTurnIndex });
    });
}

function startFirstOpenStep(room) {
    room.gameState = 'OPEN_STEP_1';
    io.to(room.id).emit('status', '베팅 완료! 2장 중 공개할 1번째 카드를 선택하세요.');
    io.to(room.id).emit('requestFirstCardSelect');
}

function startSecondOpenStep(room) {
    room.gameState = 'OPEN_STEP_2';

    const openCardsInfo = room.players.map(p => ({
        playerNum: p.playerNum,
        nickname: p.nickname,
        openCard: p.cards[p.openCardIndex]
    }));
    io.to(room.id).emit('openOneCard', openCardsInfo);

    room.players.forEach(p => {
        if (!p.isFolded) {
            p.cards.push(room.deck.pop());
            io.to(p.id).emit('receiveThirdCard', { 
                allCards: p.cards,
                openCardIndex: p.openCardIndex
            });
        }
    });

    io.to(room.id).emit('status', '3번째 패를 받았습니다! 이미 낸 카드를 제외하고 승부할 2번째 카드를 고르세요.');
    io.to(room.id).emit('requestSecondCardSelect');
}

function handleShowdown(room) {
    room.gameState = 'WAITING';

    let winner = null;
    let bestJokbo = { rank: -1, name: '' };
    const showdownData = [];

    room.players.forEach(p => {
        if (!p.isFolded) {
            const card1 = p.cards[p.openCardIndex];
            const card2 = p.cards[p.finalCardIndex];
            const jokbo = getJokbo(card1, card2);

            showdownData.push({
                nickname: p.nickname,
                jokboName: jokbo.name,
                cards: [card1, card2]
            });

            if (jokbo.rank > bestJokbo.rank) {
                bestJokbo = jokbo;
                winner = p;
            }
        }
    });

    if (winner) {
        winner.money += room.totalPot;
        io.to(room.id).emit('showdown', {
            winnerName: winner.nickname,
            winningPot: room.totalPot,
            showdownData: showdownData
        });

        room.players.forEach(p => {
            if (p.money <= 0) {
                p.money = 100000;
                io.to(p.id).emit('refillMoney', { money: p.money });
            } else {
                io.to(p.id).emit('updateMoney', { money: p.money });
            }
        });
    }
}

function endGame(room, winner) {
    room.gameState = 'WAITING';
    winner.money += room.totalPot;

    io.to(room.id).emit('showdown', {
        winnerName: winner.nickname,
        winningPot: room.totalPot,
        showdownData: [{ nickname: winner.nickname, jokboName: '상대 기권 승리' }]
    });

    room.players.forEach(p => {
        if (p.money <= 0) {
            p.money = 100000;
            io.to(p.id).emit('refillMoney', { money: p.money });
        } else {
            io.to(p.id).emit('updateMoney', { money: p.money });
        }
    });
}

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`섯다 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
