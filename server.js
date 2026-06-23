 const express = require('express');
 const http = require('http');
 const { Server } = require('socket.io');
 const os = require('os');
 
 const app = express();
 const server = http.createServer(app);
 const io = new Server(server);
 
 app.use(express.static('public'));
 
 // ---------- Game Room ----------
 const rooms = {};
 
 function genCode() {
   const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
   let code;
   do {
     code = '';
     for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
   } while (rooms[code]);
   return code;
 }
 
 function getNextIndex(players, from, skipFolded = true) {
   const n = players.length;
   for (let i = 1; i <= n; i++) {
     const idx = (from + i) % n;
     if (!skipFolded || (!players[idx].folded && players[idx].connected)) return idx;
   }
   return -1;
 }
 
 class PokerRoom {
   constructor(code, hostId) {
     this.code = code;
     this.hostId = hostId;
     this.players = [];
     this.sb = 10;
     this.bb = 20;
     this.startingChips = 1000;
     this.gameStarted = false;
     this.handInProgress = false;
     this.dealerIndex = -1;
     this.pot = 0;
     this.currentBet = 0;
     this.street = '';         // pre-flop | flop | turn | river | showdown
     this.nextPlayerIndex = -1;
     this.lastRaiserIndex = -1;
     this.actionCount = 0;
     this.handLog = []; this.chipPool = 10000; this.loans = [];
     this.waitingWinner = false;
   }
 
   // ---- helpers ----
   get connectedPlayers() { return this.players.filter(p => p.connected); }
   get activePlayers() { return this.players.filter(p => p.connected && !p.folded && !p.allIn); }
   get handPlayers() { return this.players.filter(p => p.connected && !p.folded); }
   getState() {
     return {
       code: this.code,
       hostId: this.hostId,
       players: this.players.map(p => ({ ...p })),
       sb: this.sb,
       bb: this.bb,
       startingChips: this.startingChips,
       gameStarted: this.gameStarted,
       handInProgress: this.handInProgress,
       dealerIndex: this.dealerIndex,
       pot: this.pot,
       currentBet: this.currentBet,
       street: this.street,
       nextPlayerIndex: this.nextPlayerIndex,
       waitingWinner: this.waitingWinner,
       handLog: this.handLog.slice(-20),
        gameEnded: this.gameEnded,
        gameEnded: this.gameEnded,
       chipPool: this.chipPool,
       loans: this.loans.slice(-50),
       gameSummary: this.gameEnded ? this.getSummary() : null,
        currentPots: this.waitingWinner ? (this._currentPots || this.calculatePots()) : null,
     };
   }
   broadcast() { io.to(this.code).emit('room_state', this.getState()); }
 
   addPlayer(id, name) {
     if (this.gameStarted) {
       const existing = this.players.find(p => p.name === name && !p.connected);
       if (existing) { existing.connected = true; existing.id = id; return existing; }
       return null;
     }
     if (this.players.some(p => p.name === name)) return null;
     if (this.players.length >= 9) return null;
     const seatIdx = this.players.length;
     const player = { id, name, chips: this.startingChips, buyIn: this.startingChips, roundBet: 0, folded: false, allIn: false, connected: true, seatIdx, hasActed: false, isDealer: false, isSB: false, isBB: false };
     this.players.push(player);
     return player;
   }
 
   removePlayer(id) {
     const idx = this.players.findIndex(p => p.id === id);
     if (idx === -1) return;
     this.players.splice(idx, 1);
     if (this.players.length === 0) {
       delete rooms[this.code];
       return;
     }
     this.players.forEach((p, i) => p.seatIdx = i);
     if (this.hostId === id) this.hostId = this.players[0].id;
     if (this.gameStarted && this.handInProgress) this.checkAutoFinish();
   }
 
   updateSettings(sb, bb, startingChips) {
     if (this.gameStarted) return;
     this.sb = sb;
     this.bb = bb;
     this.startingChips = startingChips;
   }
 
   startGame() {
     if (this.connectedPlayers.length < 2) return;
     this.players.forEach(p => { p.chips = this.startingChips; p.folded = false; p.allIn = false; p.connected = true; });
     this.gameStarted = true;
     this.dealerIndex = -1;
     this.startNewHand();
   }
 
   // ---- Hand lifecycle ----
   startNewHand() {
     this.handInProgress = true;
     this.waitingWinner = false;
     this.handLog = [];
 
     // Move dealer button
     const connected = this.players.filter(p => p.connected);
     if (connected.length < 2) { this.handInProgress = false; return; }
     if (connected.length === 2) this.dealerIndex = this.players.indexOf(connected[1]); // headsup: dealer is SB
     else {
       let next = this.dealerIndex;
       do { next = (next + 1) % this.players.length; } while (!this.players[next].connected);
       this.dealerIndex = next;
     }
 
     // Reset hand state
     this.players.forEach(p => { p.roundBet = 0; p.folded = false; p.allIn = false; p.hasActed = false; p.isDealer = false; p.isSB = false; p.isBB = false; p.handBet = 0; });
     this.players[this.dealerIndex].isDealer = true;
     this.pot = 0;
     this.currentBet = 0;
     this.street = 'pre-flop';
     this.lastRaiserIndex = -1;
     this.actionCount = 0;
 
     // Post blinds
     const sbIdx = getNextIndex(this.players, this.dealerIndex, false);
     const bbIdx = getNextIndex(this.players, sbIdx, false);
     this.postBlind(sbIdx, this.sb);
     this.postBlind(bbIdx, this.bb);
     this.players[sbIdx].isSB = true;
     this.players[bbIdx].isBB = true;
     // BB has the option to act last pre-flop – set lastRaiserIndex to BB
     this.players[bbIdx].hasActed = false;
     this.currentBet = this.bb;
     this.lastRaiserIndex = bbIdx;
 
     // First to act pre-flop: UTG (next after BB)
     this.nextPlayerIndex = this.getUtgIndex();
     this.addLog(`新一局开始 盲注 ${this.sb}/${this.bb}`);
     this.broadcast();
   }
 
   postBlind(idx, amount) {
     const p = this.players[idx];
     const actual = Math.min(amount, p.chips);
     p.chips -= actual;
     p.roundBet += actual;
     p.hasActed = true;
     if (p.chips === 0) p.allIn = true;
   }
 
   getUtgIndex() {
     // Find BB first
     const bbIdx = (() => {
       let i = this.dealerIndex;
       do { i = (i + 1) % this.players.length; } while (i !== this.dealerIndex && !this.players[i].isBB);
       return i;
     })();
     return getNextIndex(this.players, bbIdx, false);
   }
 
   // ---- Actions ----
   handleAction(playerId, type, amount) {
     if (!this.handInProgress || this.waitingWinner) return { error: '游戏未在进行中' };
     const p = this.players.find(pl => pl.id === playerId);
     if (!p) return { error: '未找到玩家' };
     if (this.players.indexOf(p) !== this.nextPlayerIndex) return { error: '还不是你的回合' };
     if (p.folded || p.allIn) return { error: '已在弃牌或All-in状态' };
 
     switch (type) {
       case 'fold':
         p.folded = true;
         this.addLog(`${p.name} 弃牌`);
         break;
 
       case 'check':
         if (this.currentBet > p.roundBet) return { error: '当前有下注，不能过牌' };
         p.hasActed = true;
         this.addLog(`${p.name} 过牌`);
         break;
 
       case 'call':
         const callAmount = Math.min(this.currentBet - p.roundBet, p.chips);
         p.chips -= callAmount;
         p.roundBet += callAmount;
         p.hasActed = true;
         if (p.chips === 0) p.allIn = true;
         this.addLog(`${p.name} 跟注 ${callAmount}`);
         break;
 
       case 'raise':
         const minRaise = Math.min(this.currentBet * 2, p.chips + p.roundBet);
         if (amount < this.bb) amount = this.bb;
         if (amount > p.chips + p.roundBet) amount = p.chips + p.roundBet;
         const raiseTotal = Math.max(amount, this.currentBet + this.bb);
         const raiseActual = Math.min(raiseTotal, p.chips + p.roundBet);
         const addAmount = raiseActual - p.roundBet;
         if (addAmount <= 0) return { error: '加注额无效' };
         p.chips -= addAmount;
         p.roundBet = raiseActual;
         p.hasActed = true;
         if (p.chips === 0) p.allIn = true;
         this.currentBet = raiseActual;
         this.lastRaiserIndex = this.players.indexOf(p);
         // Reset others' hasActed
         this.players.forEach(pl => {
           if (pl.id !== p.id && !pl.folded && !pl.allIn && pl.connected) pl.hasActed = false;
         });
         if (p.allIn) this.addLog(`${p.name} All-in ${raiseActual}`);
         else this.addLog(`${p.name} 加注到 ${raiseActual}`);
         break;
 
       case 'allin':
         const allAmt = p.chips;
         p.roundBet += allAmt;
         p.chips = 0;
         p.allIn = true;
         p.hasActed = true;
         // Check if this is effectively a raise
         if (p.roundBet > this.currentBet) {
           this.currentBet = p.roundBet;
           this.lastRaiserIndex = this.players.indexOf(p);
           this.players.forEach(pl => {
             if (pl.id !== p.id && !pl.folded && !pl.allIn && pl.connected) pl.hasActed = false;
           });
         }
         this.addLog(`${p.name} All-in ${p.roundBet}`);
         break;
 
       default: return { error: '无效操作' };
     }
 
     // Collect round bets into pot
     this.collectBets();
 
     // Check if round is done
     if (this.isBettingRoundComplete()) {
       this.advanceStreet();
     } else {
       this.setNextPlayer();
     }
 
     this.broadcast();
     return { ok: true };
   }
 
   collectBets() {
     // Bets stay in roundBet until street advances, then get collected
   }
 
  isBettingRoundComplete() {
    const inHand = this.handPlayers;
    if (inHand.length <= 1) return true;
    const active = this.activePlayers;
    if (active.length === 0) return true;
    return active.every(p => p.hasActed);
  }
 
   setNextPlayer() {
     if (!this.handInProgress) return;
     const next = getNextIndex(this.players, this.nextPlayerIndex);
     if (next === -1) { this.nextPlayerIndex = -1; return; }
     this.nextPlayerIndex = next;
   }
 
   advanceStreet() {
    this.players.forEach(p => { this.pot += p.roundBet; if (!p.handBet) p.handBet = 0; p.handBet += p.roundBet; p.roundBet = 0; p.hasActed = false; });
    this.players.forEach(p => { this.pot += p.roundBet; p.roundBet = 0; p.hasActed = false; });

    const inHand = this.handPlayers;

    // Only award pot if only 1 player remains (others folded)
    if (inHand.length <= 1) {
      const winner = inHand[0];
      if (winner) { this.awardPot(winner.id); this.addLog(winner.name + " 赢得底池 " + this.pot); }
      this.handInProgress = false; this.waitingWinner = false; this.street = ""; this.nextPlayerIndex = -1;
      this.broadcast(); return;
    }

    const streets = ["pre-flop", "flop", "turn", "river", "showdown"];
    const ci = streets.indexOf(this.street);
    if (ci === -1) return;
    this.street = streets[ci + 1];
    this.currentBet = 0;

    this.lastRaiserIndex = -1;

    // If all remaining players are all-in, auto-advance to showdown
    if (this.activePlayers.length === 0 && this.street !== "showdown") {
      while (this.street !== "showdown") {
        const ni = streets.indexOf(this.street) + 1;
        if (ni >= streets.length) break;
        this.street = streets[ni];
      }
      this.addLog("全体All-in，自动翻牌至摊牌");
    }


    if (this.street === "showdown") { this.waitingWinner = true; this._currentPots = this.calculatePots(); this._awardedAll = false; this.addLog("摊牌！请指定赢家"); this.broadcast(); return; }

    // Set first player post-flop: first active after dealer
    this.nextPlayerIndex = getNextIndex(this.players, this.dealerIndex);

    const streetNames = { flop: "翻牌", turn: "转牌", river: "河牌" };
    this.addLog("--- " + (streetNames[this.street] || this.street) + " 底池: " + this.pot + " ---");
  } 
  calculatePots() {
    // Sort ALL players by handBet (including folded)
    const allSorted = [...this.players].sort((a, b) => (a.handBet || 0) - (b.handBet || 0));
    const pots = [];
    let prevLevel = 0;
    for (const p of allSorted) {
      const level = p.handBet || 0;
      if (level <= prevLevel) continue;
      const diff = level - prevLevel;
      // ALL players with handBet >= this level contributed
      const totalContributors = this.players.filter(x => (x.handBet || 0) >= level).length;
      const amount = diff * totalContributors;
      // Only non-folded players with handBet >= level can win
      const eligible = this.players.filter(x => !x.folded && (x.handBet || 0) >= level).map(x => x.id);
      if (amount > 0) {
        if (eligible.length > 0) {
          pots.push({ amount, eligible, level });
        } else if (pots.length > 0) {
          // No one eligible at this level, merge into last pot
          pots[pots.length - 1].amount += amount;
        }
      }
      prevLevel = level;
    }
    return pots;
  }

  awardPot(winnerId) {
    const winner = this.players.find(p => p.id === winnerId);
    if (!winner) return;
    if (this._currentPots && this._currentPots.length > 0 && !this._awardedAll) {
      const unclaimed = this._currentPots.find(p => !p.claimed);
      if (unclaimed) {
        unclaimed.claimed = true;
        unclaimed.winnerId = winnerId;
        this.addLog(winner.name + " 赢得底池 " + unclaimed.amount);
        winner.chips += unclaimed.amount;
        if (this._currentPots.every(p => p.claimed)) {
          this._awardedAll = true;
          this.waitingWinner = false;
          this.handInProgress = false;
          this.street = "";
          this.nextPlayerIndex = -1;
          this.addLog("=== 本局结束 ===");
          this.broadcast();
        } else {
          this.waitingWinner = true;
          this.broadcast();
        }
        return;
      }
    }
    winner.chips += this.pot;
    this.addLog(winner.name + " 赢得底池 " + this.pot);
    this.pot = 0;
    this.waitingWinner = false;
    this.handInProgress = false;
    this.street = "";
    this.nextPlayerIndex = -1;
    this.broadcast();
  }
 
   selectWinner(winnerId) {
    if (!this.waitingWinner) return { error: "不在摊牌阶段" };
    if (!this._currentPots) {
      this._currentPots = this.calculatePots();
      this._awardedAll = false;
    }
    this.awardPot(winnerId);
    return { ok: true };
  }
 
   checkAutoFinish() {
     if (!this.handInProgress) return;
     const connected = this.players.filter(p => p.connected);
     if (connected.length < 2) {
       this.handInProgress = false;
       this.waitingWinner = false;
       this.street = '';
       this.nextPlayerIndex = -1;
       this.broadcast();
     }
   }
 
   addLog(msg) {
     this.handLog.push(msg);
   }
 
   rebuy(playerId, amount) {
     const p = this.players.find(pl => pl.id === playerId);
     if (!p) return { error: '未找到玩家' };
     p.chips += amount;
    if (p.buyIn === undefined) p.buyIn = this.startingChips;
    p.buyIn += amount;
    this.loans.push({ type: "rebuy", playerId, playerName: p.name, amount, time: Date.now() });
     this.addLog(`${p.name} 重购 ${amount} 筹码`);
     this.broadcast();
     return { ok: true };
  }

  borrowFromPool(playerId, amount) {
    const p = this.players.find(pl => pl.id === playerId);
    if (!p) return { error: "未找到玩家" };
    if (amount <= 0 || amount > this.chipPool) return { error: "无效金额或筹码池不足" };
    this.chipPool -= amount;
    p.chips += amount;
    this.loans.push({ type: "pool", playerId, playerName: p.name, amount, time: Date.now() });
    this.addLog(p.name + " 从筹码池借入 " + amount);
    this.broadcast();
    return { ok: true };
  }

  borrowFromPlayer(borrowerId, lenderId, amount) {
    const b = this.players.find(p => p.id === borrowerId);
    const l = this.players.find(p => p.id === lenderId);
    if (!b || !l) return { error: "未找到玩家" };
    if (amount <= 0 || l.chips < amount) return { error: "无效金额或该玩家筹码不足" };
    l.chips -= amount;
    b.chips += amount;
    this.loans.push({ type: "player", fromId: lenderId, fromName: l.name, toId: borrowerId, toName: b.name, amount, time: Date.now() });
    this.addLog(b.name + " 向 " + l.name + " 借入 " + amount);
    this.broadcast();
    return { ok: true };
  }

  getSummary() {
    return this.players.map(p => {
      const r = this.loans.filter(l => l.type === 'rebuy' && l.playerId === p.id).reduce((s, l) => s + l.amount, 0);
      const bp = this.loans.filter(l => l.type === 'pool' && l.playerId === p.id).reduce((s, l) => s + l.amount, 0);
      const bf = this.loans.filter(l => l.type === 'player' && l.toId === p.id).reduce((s, l) => s + l.amount, 0);
      const lt = this.loans.filter(l => l.type === 'player' && l.fromId === p.id).reduce((s, l) => s + l.amount, 0);
      const bi = (p.buyIn || this.startingChips);
      return { name: p.name, startingChips: this.startingChips, rebuys: r, borrowed: bp + bf, lent: lt, currentChips: p.chips, netProfit: p.chips - bi - bp - bf + lt };
    });
  }

  endGame() {
    if (!this.gameStarted) return { error: "游戏未开始" };
    this.gameEnded = true;
    this._currentPots = null;
    this.gameSummary = this.getSummary();
    this.handInProgress = false;
    this.street = "";
    this.nextPlayerIndex = -1;
    this.waitingWinner = false;
    this.addLog("=== 游戏结束 ===");
    this.broadcast();
    return { ok: true };
  }

  restartGame() {
    if (!this.gameStarted) return { error: "游戏未开始" };
    this.players.forEach(p => {
      p.chips = this.startingChips; p.buyIn = this.startingChips;
      p.folded = false; p.allIn = false; p.connected = true;
      p.roundBet = 0; p.handBet = 0;
    });
    this.chipPool = 10000;
    this.loans = [];
    this.handLog = [];
    this.gameEnded = false;
    this.gameSummary = null;
    this.pot = 0;
    this.dealerIndex = -1;
    this._currentPots = null;
    this.startNewHand();
    return { ok: true };
  }
  }

// ---------- Socket.IO ----------
 io.on('connection', (socket) => {
 
    socket.on('create_room', ({ name }) => {
      const code = genCode();
      const room = new PokerRoom(code, socket.id);
      rooms[code] = room;
      socket.join(code);
      room.addPlayer(socket.id, name || '房主');
      socket.emit('room_created', { code, playerId: socket.id });
      room.broadcast();
    });
 
   socket.on('join_room', ({ code, name }) => {
     const room = rooms[code];
     if (!room) { socket.emit('error', '房间不存在'); return; }
     if (!name || name.trim() === '') { socket.emit('error', '请输入昵称'); return; }
     name = name.trim();
     const player = room.addPlayer(socket.id, name);
     if (!player) { socket.emit('error', '加入失败（昵称重复/房间已满/游戏已开始）'); return; }
     socket.join(code);
     socket.emit('room_joined', { playerId: socket.id });
     room.broadcast();
   });
 
   socket.on('update_settings', ({ sb, bb, startingChips }) => {
     const room = findRoom(socket);
     if (!room || room.hostId !== socket.id) return;
     room.updateSettings(sb, bb, startingChips);
     room.broadcast();
   });
 
   socket.on('start_game', () => {
     const room = findRoom(socket);
     if (!room || room.hostId !== socket.id) return;
     room.startGame();
   });
 
   socket.on('player_action', ({ type, amount }) => {
     const room = findRoom(socket);
     if (!room) return;
     const result = room.handleAction(socket.id, type, amount);
     if (result.error) socket.emit('error', result.error);
   });
 
   socket.on('select_winner', ({ playerId }) => {
     const room = findRoom(socket);
     if (!room || room.hostId !== socket.id) return;
     room.selectWinner(playerId);
   });
 
   socket.on('next_hand', () => {
     const room = findRoom(socket);
     if (!room || room.hostId !== socket.id) return;
     if (room.handInProgress) return;
     room.startNewHand();
   });
 
   socket.on('rebuy', ({ amount }) => {
     const room = findRoom(socket);
     if (!room) return;
     room.rebuy(socket.id, amount);
   });

  socket.on("borrow_from_pool", ({ amount }) => {
    const room = findRoom(socket);
    if (!room) return;
    room.borrowFromPool(socket.id, amount);
  });

  socket.on("borrow_from_player", ({ lenderId, amount }) => {
    const room = findRoom(socket);
    if (!room) return;
    room.borrowFromPlayer(socket.id, lenderId, amount);
  });

  socket.on("end_game", () => {
    const room = findRoom(socket);
    if (!room || room.hostId !== socket.id) return;
    room.endGame();
  });

  socket.on("restart_game", () => {
    const room = findRoom(socket);
    if (!room || room.hostId !== socket.id) return;
    room.restartGame();
  });

 
   socket.on('disconnect', () => {
     for (const code in rooms) {
       const room = rooms[code];
       const p = room.players.find(pl => pl.id === socket.id);
       if (p) {
         p.connected = false;
         if (room.gameStarted && room.handInProgress) room.checkAutoFinish();
         room.broadcast();
         // Clean empty rooms
         if (room.connectedPlayers.length === 0) delete rooms[code];
         break;
       }
     }
   });
 });
 
 function findRoom(socket) {
   for (const code in rooms) {
     if (socket.rooms.has(code)) return rooms[code];
   }
   return null;
 }
 
 function getLocalIP() {
   const interfaces = os.networkInterfaces();
   for (const name of Object.keys(interfaces)) {
     for (const iface of interfaces[name]) {
       if (iface.family === 'IPv4' && !iface.internal) return iface.address;
     }
   }
   return '127.0.0.1';
 }
 
 const PORT = process.env.PORT || 3000;
 server.listen(PORT, '0.0.0.0', () => {
   console.log(`\n  🃏 德州扑克筹码模拟器已启动`);
   console.log(`  📡 本机地址: http://${getLocalIP()}:${PORT}`);
   console.log(`  🏠 本机访问: http://127.0.0.1:${PORT}\n`);
 });
