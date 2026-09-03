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
            openCardIndex: -1,
            finalCardIndex: -1,
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

    // [2단계] 1차 카드 공개
    socket.on('selectOpenCard', (cardIndex) => {
        if (gameState !== 'OPEN_STEP_1') return;
        player.openCardIndex = cardIndex;

        const activePlayers = players.filter(p => !p.isFolded);
        const allSelected = activePlayers.every(p => p.openCardIndex !== -1);

        if (allSelected) {
            // 모든 인원이 1장을 깐 후 -> 3번째 카드 지급 후 2차 공개 단계로 이동
            startSecondOpenStep();
        }
    });

    // [3단계] 2차 카드 공개 (이미 낸 패는 불가능)
    socket.on('selectFinalCard', (cardIndex) => {
        if (gameState !== 'OPEN_STEP_2') return;

        // 버그 방지: 1차 공개 카드 재선택 금지
        if (cardIndex !== player.openCardIndex) {
            player.finalCardIndex = cardIndex;

            const activePlayers = players.filter(p => !p.isFolded);
            const allSelected = activePlayers.every(p => p.finalCardIndex !== -1);

            if (allSelected) {
                // 모두 2장 공개 완료 -> 최종 정산
                handleShowdown();
            }
        }
    });

    // 베팅 처리 (음수 돈 방지 유효성 검사)
    socket.on('bet', (data) => {
        if (gameState !== 'BETTING') return;
        if (players[currentTurnIndex].id !== socket.id) return;

        const betType = data.type;
        let requiredBet = 0;

        if (betType === '하프') {
            const addBet = Math.floor(totalPot * 0.5);
            requiredBet = lastBetAmount + addBet;
            
            // 돈 마이너스 버그 방지 예외 처리
            if (player.money < requiredBet) {
                socket.emit('status', '⚠️ 소지금이 부족하여 하프를 할 수 없습니다.');
                return;
            }
            player.money -= requiredBet;
            totalPot += requiredBet;
            lastBetAmount = requiredBet;

        } else if (betType === '콜') {
            requiredBet = lastBetAmount;
            if (player.money < requiredBet) {
                // 잔액 부족 시 올인 처리
                requiredBet = player.money;
            }
            player.money -= requiredBet;
            totalPot += requiredBet;

        } else if (betType === '다이') {
            player.isFolded = true;
        }

        // 잔액이 음수로 떨어지지 않도록 마지노선 0원 처리
        if (player.money < 0) player.money = 0;

        io.emit('updateMoney', { playerNum: player.playerNum, money: player.money });
        io.emit('updatePot', { totalPot: totalPot });
        io.emit('opponentAction', { playerNum: player.playerNum, type: betType });

        const activePlayers = players.filter(p => !p.isFolded);
        if (activePlayers.length === 1) {
            endGame(activePlayers[0]);
            return;
        }

        nextBetTurn();
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

// 1단계: 2장씩 받고 시작
function startFirstRound() {
    gameState = 'BETTING';
    deck = createDeck();
    totalPot = 0;
    lastBetAmount = 10000;

    const seedMoney = 10000;
    players.forEach(p => {
        // 음수 잔액 시작 방지
        if (p.money < seedMoney) p.money = seedMoney;
        
        p.money -= seedMoney;
        totalPot += seedMoney;
        p.cards = [deck.pop(), deck.pop()];
        p.isFolded = false;
        p.openCardIndex = -1;
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

    io.emit('status', '게임 시작! 판돈 차감 후 2장의 패를 받았습니다. 베팅을 시작합니다.');
}

function nextBetTurn() {
    do {
        currentTurnIndex = (currentTurnIndex + 1) % players.length;
    } while (players[currentTurnIndex].isFolded);

    if (currentTurnIndex === 0) {
        // 베팅이 종료되었으면 2단계(1장 까기) 진행
        startFirstOpenStep();
        return;
    }

    players.forEach((p, idx) => {
        io.to(p.id).emit('turnUpdate', { isMyTurn: idx === currentTurnIndex });
    });
}

// 2단계: 턴으로 돌아가며 1장씩 공개
function startFirstOpenStep() {
    gameState = 'OPEN_STEP_1';
    io.emit('status', '베팅 완료! 2장 중 공개할 1번째 카드를 선택해서 까주세요.');
    io.emit('requestFirstCardSelect');
}

// 3단계: 1장 보충 후 낸 패 제외 1장 추가 공개
function startSecondOpenStep() {
    gameState = 'OPEN_STEP_2';

    // 상대방에게 1차 공개한 카드가 무엇인지 브로드캐스트
    const openCardsInfo = players.map(p => ({
        playerNum: p.playerNum,
        openCard: p.cards[p.openCardIndex]
    }));
    io.emit('openOneCard', openCardsInfo);

    // 1장 더 지급해서 손패 3장으로 만듦
    players.forEach(p => {
        if (!p.isFolded) {
            p.cards.push(deck.pop());
            io.to(p.id).emit('receiveThirdCard', { 
                allCards: p.cards,
                openCardIndex: p.openCardIndex
            });
        }
    });

    io.emit('status', '3번째 패를 받았습니다! 이미 낸 카드를 제외하고 승부할 2번째 카드를 고르세요.');
    io.emit('requestSecondCardSelect');
}

// 4단계: 다 깠으니 최종 족보 판정 및 베팅금 정산
function handleShowdown() {
    gameState = 'WAITING';

    let winner = null;
    let bestJokbo = { rank: -1, name: '' };
    const showdownData = [];

    players.forEach(p => {
        if (!p.isFolded) {
            // [1차 깐 카드 1장] + [2차 깐 카드 1장] 총 2장으로 판정
            const card1 = p.cards[p.openCardIndex];
            const card2 = p.cards[p.finalCardIndex];
            const jokbo = getJokbo(card1, card2);

            showdownData.push({
                playerNum: p.playerNum,
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
        winner.money += totalPot;
        io.emit('showdown', {
            winnerNum: winner.playerNum,
            winningPot: totalPot,
            showdownData: showdownData
        });

        players.forEach(p => {
            p.isReady = false;
            // 돈이 다 떨어졌을 때 파산 구제
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
