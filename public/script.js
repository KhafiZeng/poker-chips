 let socket;
 let playerId = null;
 let connected = false;
 let isHost = false;
 let currentState = null;
 
 // ---------- Socket ----------
 function connectSocket() {
   socket = io();
 
   socket.on('connect', () => { connected = true; });
   socket.on('disconnect', () => { connected = false; });
 
   socket.on('room_created', ({ code, playerId: pid }) => {
     isHost = true;
    if (pid) playerId = pid;
     showRoomLobby(code);
   });
 
   socket.on('room_joined', ({ playerId: pid }) => {
     playerId = pid;
   });
 
   socket.on('room_state', (state) => {
     currentState = state;
     if (!playerId) {
       // Find our id
       const me = state.players.find(p => p.id === socket.id);
       if (me) playerId = me.id;
     }
     isHost = state.hostId === socket.id;
     render(state);
   });
 
   socket.on('error', (msg) => {
     document.getElementById('lobbyError').textContent = msg;
   });
 }
 
 // ---------- Screen Navigation ----------
 function showScreen(id) {
   document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
   document.getElementById(id).classList.add('active');
 }
 
 function showRoomLobby(code) {
   showScreen('roomLobby');
   document.getElementById('roomCodeDisplay').textContent = code;
   // Build connection address
   const addr = window.location.host;
   document.getElementById('connAddress').textContent = `${addr} 房号: ${code}`;
 }
 
 // ---------- Render ----------
 function render(state) {
   if (!state.gameStarted) {
     renderRoomLobby(state);
     return;
   }
   renderTable(state);
 }
 
 function renderRoomLobby(state) {
   showScreen('roomLobby');
   const list = document.getElementById('playerList');
   list.innerHTML = state.players.map(p =>
     `<li>${p.name}${p.id === state.hostId ? ' <span class="host-badge">👑</span>' : ''} ${p.connected ? '' : '<span style="color:#e74c3c">(已断开)</span>'}</li>`
   ).join('');
   document.getElementById('playerCount').textContent = state.players.length;
   document.getElementById('setSb').value = state.sb;
   document.getElementById('setBb').value = state.bb;
   document.getElementById('setStartingChips').value = state.startingChips;
   document.getElementById('btnStartGame').style.display = isHost ? '' : 'none';
   document.getElementById('btnUpdateSettings').style.display = isHost ? '' : 'none';
   document.querySelectorAll('.settings-grid input').forEach(el => el.disabled = !isHost);
 }
 
 function renderTable(state) {
   showScreen('game');
 
   // Blind info
   document.getElementById('blindInfo').textContent = `盲注 ${state.sb}/${state.bb}`;
 
   // Street indicator
   const streetEl = document.getElementById('streetIndicator');
   const streetMap = {
     'pre-flop': '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌',
     '': state.handInProgress ? '进行中' : (state.gameStarted ? '等待新一局' : '等待开始')
   };
   streetEl.textContent = streetMap[state.street] || state.street;
 
   // Pot
   document.getElementById('potAmount').textContent = state.pot;

  // Pool balance & borrow UI updates
  const _poolBal = document.getElementById("poolBalance");
  if (_poolBal && state.chipPool !== undefined) _poolBal.textContent = state.chipPool;
  const _lender = document.getElementById("borrowLender");
  if (_lender && state.players) {
    const _myId = playerId;
    _lender.innerHTML = state.players
      .filter(p => p.id !== _myId && p.connected)
      .map(p => "<option value=\"" + p.id + "\">" + p.name + " (💰" + p.chips + ")</option>")
      .join("");
  }

 
   // Community card slots
   const slotCounts = { 'pre-flop': 0, flop: 3, turn: 4, river: 5, showdown: 5 };
   const nSlots = slotCounts[state.street] || 0;
   document.querySelectorAll('.card-slot').forEach((el, i) => {
     el.classList.toggle('filled', i < nSlots);
   });
 
   // Players
   renderPlayers(state);
 
   // Action buttons
   renderActions(state);
 
   // Winner panel (host only)
   renderWinnerPanel(state);
 
   // Game info
   const info = document.getElementById('gameInfo');
   if (state.waitingWinner) info.textContent = '🏆 等待指定赢家 (房主操作)';
   else if (state.handInProgress) info.textContent = `当前行动: ${state.players[state.nextPlayerIndex]?.name || '-'}`;
   else info.textContent = '等待下一局';
  if (state.chipPool !== undefined) info.textContent += " | 🏦" + state.chipPool;

 
   // "Next hand" button (host only)
   document.getElementById('btnNextHand').style.display = isHost && !state.handInProgress ? '' : 'none';
 
   // Hand log
   const logEl = document.getElementById('handLog');
   logEl.innerHTML = state.handLog.map(m => `<div>${m}</div>`).join('');
   logEl.scrollTop = logEl.scrollHeight;

  const summary = document.getElementById('gameSummary');
  if (state.gameEnded && state.gameSummary) {
    renderSummary(state.gameSummary);
    summary.classList.remove('hidden');
  } else if (l.type === "player") {
    summary.classList.add('hidden');
  }

  const endBtn = document.getElementById('btnEndGame');
  if (endBtn) endBtn.style.display = isHost && state.gameStarted && !state.gameEnded ? '' : 'none';

// ---------- Borrow & Loan Records ----------




 }
 
 function renderPlayers(state) {
   const container = document.getElementById('playerSeats');
   container.innerHTML = '';
   const n = state.players.length;
   if (n === 0) return;
 
   state.players.forEach((p, i) => {
     const seat = document.createElement('div');
     seat.className = 'player-seat';
     if (p.folded) seat.classList.add('folded-player');
     if (!p.folded && !p.allIn && state.handInProgress && state.nextPlayerIndex === i) {
       seat.classList.add('active-turn');
     }
 
     // Position around the elliptical table
     // 0 = bottom (6 o'clock), moving clockwise
     // For n players, spread them evenly along the ellipse
     const totalSlots = Math.max(n, 4);
     const angleOffset = -Math.PI / 2; // start from top
     // For poker, the best viewing arrangement puts bottom seats at front
     // Use an arc from about -120deg to +120deg for the bottom half
     // Map seat indices to angles: seat 0 at bottom (-90deg/270deg)
     // We'll spread evenly
     const angleStep = Math.PI / (totalSlots + 1);
     const startAngle = -Math.PI / 2 - (angleStep * (totalSlots - 1) / 2);
     const angle = startAngle + angleStep * i;
 
     const rx = 42; // % of table width
     const ry = 38; // % of table height
     const cx = 50;
     const cy = 50;
     const x = cx + rx * Math.cos(angle);
     const y = cy + ry * Math.sin(angle);
 
     seat.style.left = x + '%';
     seat.style.top = y + '%';
     seat.style.transform = 'translate(-50%, -50%)';
 
     // Avatar
     const avatar = document.createElement('div');
     avatar.className = 'avatar';
     avatar.textContent = p.name.charAt(0);
 
     // Role badge (D, SB, BB)
     if (p.isDealer) {
       const badge = document.createElement('div');
       badge.className = 'role-badge role-dealer';
       badge.textContent = 'D';
       avatar.appendChild(badge);
     } else if (p.isSB) {
       const badge = document.createElement('div');
       badge.className = 'role-badge role-sb';
       badge.textContent = 'SB';
       avatar.appendChild(badge);
     } else if (p.isBB) {
       const badge = document.createElement('div');
       badge.className = 'role-badge role-bb';
       badge.textContent = 'BB';
       avatar.appendChild(badge);
     }
 
     seat.appendChild(avatar);
 
     // Name
     const nameEl = document.createElement('div');
     nameEl.className = 'pname';
     nameEl.textContent = p.name;
     seat.appendChild(nameEl);
 
     // Chips
     const chipsEl = document.createElement('div');
     chipsEl.className = 'chips';
     chipsEl.textContent = '💰' + p.chips;
     seat.appendChild(chipsEl);
 
     // Round bet
     const betEl = document.createElement('div');
     betEl.className = 'bet-display';
     if (p.roundBet > 0) betEl.textContent = '下注 ' + p.roundBet;
     seat.appendChild(betEl);
 
     // Status
     if (p.folded) {
       const tag = document.createElement('div');
       tag.className = 'status-tag status-folded';
       tag.textContent = '弃牌';
       seat.appendChild(tag);
     } else if (p.allIn) {
       const tag = document.createElement('div');
       tag.className = 'status-tag status-allin';
       tag.textContent = 'ALL-IN';
       seat.appendChild(tag);
     } else if (!p.connected) {
       const tag = document.createElement('div');
       tag.className = 'status-tag status-folded';
       tag.textContent = '离线';
       seat.appendChild(tag);
     }
 
     container.appendChild(seat);
   });
 }
 
 function renderActions(state) {
   const row = document.getElementById('actionRow');
   const btns = row.querySelectorAll('button[data-action]');
   const checkBtn = document.getElementById('btnCheck');
   const callBtn = document.getElementById('btnCall');
   const raiseInput = document.getElementById('raiseAmount');
 
   // Enable/disable all action buttons
   const isMyTurn = state.handInProgress && !state.waitingWinner &&
     state.players.some(p => p.id === playerId && !p.folded && !p.allIn && state.players.indexOf(p) === state.nextPlayerIndex);
   const me = state.players.find(p => p.id === playerId);
 
   btns.forEach(b => b.disabled = !isMyTurn);
   raiseInput.disabled = !isMyTurn;
 
   if (!isMyTurn || !me) {
     btns.forEach(b => b.style.display = '');
     checkBtn.style.display = '';
     callBtn.style.display = '';
     return;
   }
 
   const myIdx = state.players.indexOf(me);
   const isMyTurnBool = !me.folded && !me.allIn && state.nextPlayerIndex === myIdx;
 
   if (!isMyTurnBool) { btns.forEach(b => b.disabled = true); return; }
 
   btns.forEach(b => b.disabled = false);
 
   // Check vs Call
   const needToCall = state.currentBet - me.roundBet;
   if (needToCall <= 0 || state.currentBet === 0) {
     // Can check
     checkBtn.style.display = '';
     callBtn.style.display = 'none';
   } else {
     checkBtn.style.display = 'none';
     callBtn.style.display = '';
     callBtn.textContent = needToCall >= me.chips ? `All-in ${me.chips}` : `跟注 ${needToCall}`;
   }
 
   // Raise
   if (raiseInput) {
     const minRaise = Math.max(state.bb, state.currentBet + state.bb - me.roundBet);
     raiseInput.placeholder = `最小 ${minRaise}`;
     raiseInput.value = minRaise;
   }
 }
 
 function renderWinnerPanel(state) {
   const panel = document.getElementById('winnerPanel');
   const options = document.getElementById('winnerOptions');
   if (state.waitingWinner && isHost) {
     panel.classList.remove('hidden');
     const activeForWin = state.players.filter(p => !p.folded && p.connected);
    const pots = state.currentPots || [{amount: state.pot}];
    const unclaimed = pots.filter(p => !p.claimed);
     const nextPot = unclaimed.length > 0 ? unclaimed[0] : null;
     const eligiblePlayers = nextPot && nextPot.eligible ? activeForWin.filter(p => nextPot.eligible.includes(p.id)) : activeForWin;

     const potLabel = nextPot ? '<div style="font-size:.75rem;color:#aaa;margin-bottom:6px">底池 ' + nextPot.amount + ' - 选择赢家</div>' : '';
     options.innerHTML = potLabel + eligiblePlayers.map(p =>
       '<button onclick="selectWinner(\'' + p.id + '\')">' + p.name + '</button>'
     ).join('');
   } else {
     panel.classList.add('hidden');
   }
 }
 
 
function showRebuyHistory() {
  if (!currentState || !currentState.loans) return;
  const panel = document.getElementById("rebuyPanel");
  panel.classList.remove("hidden");
  const list = document.getElementById("rebuyList");
  const rebuys = currentState.loans.filter(l => l.type === "rebuy");
  if (rebuys.length === 0) {
    list.innerHTML = "<div class=\"loan-empty\">暂无购买记录</div>";
    return;
  }
  const total = rebuys.reduce((s, l) => s + l.amount, 0);
  list.innerHTML = "<div style=\"padding:8px 0;border-bottom:1px solid rgba(255,255,255,.1);margin-bottom:8px\"><strong>\u5171\u8d2d\u4e70: " + total + "</strong></div>" +
    rebuys.slice().reverse().map(l => {
      const t = new Date(l.time);
      const ts = t.getHours().toString().padStart(2,"0") + ":" + t.getMinutes().toString().padStart(2,"0");
      return "<div class=\"loan-item\">" + l.playerName + " \u91cd\u8d2d <span class=\"loan-amount\">" + l.amount + "</span><span class=\"loan-time\">" + ts + "</span></div>";
    }).join("");
}

function hideRebuyHistory() {
  document.getElementById("rebuyPanel").classList.add("hidden");
}

// ---------- User Actions ----------
 function renderSummary(data) {
  const body = document.getElementById('summaryBody');
  if (!body || !data) return;
  const rows = data.map(p => {
    const profit = p.netProfit, cls = profit > 0 ? 'pos' : profit < 0 ? 'neg' : 'zero', sign = profit > 0 ? '+' : '';
    return '<tr><td class="pname">' + p.name + '</td><td class="num">' + p.startingChips + '</td><td class="num">' + (p.rebuys||0) + '</td><td class="num">' + (p.borrowed||0) + '</td><td class="num">' + p.currentChips + '</td><td class="num profit ' + cls + '">' + sign + profit + '</td></tr>';
  }).join('');
  body.innerHTML = '<table class="summary-table"><tr><th>\u73a9\u5bb6</th><th class="num">\u521d\u59cb</th><th class="num">\u91cd\u8d2d</th><th class="num">\u501f\u5165</th><th class="num">\u5269\u4f59</th><th class="num">\u76c8\u4e8f</th></tr>' + rows + '</table>';
}

function selectWinner(pid) {
   socket.emit('select_winner', { playerId: pid });
 }
 
 // ---------- Event Listeners ----------
 document.addEventListener('DOMContentLoaded', () => {
   connectSocket();
 
  document.getElementById("btnCreateRoom").addEventListener("click", () => {
    const name = document.getElementById("inputHostName").value.trim();
    if (!name) { document.getElementById("lobbyError").textContent = "请输入昵称"; return; }
    document.getElementById("lobbyError").textContent = "";
    socket.emit("create_room", { name });
  });
 
   document.getElementById('btnJoinRoom').addEventListener('click', () => {
     const code = document.getElementById('inputRoomCode').value.trim().toUpperCase();
     const name = document.getElementById('inputPlayerName').value.trim();
     if (!code || !name) { document.getElementById('lobbyError').textContent = '请填写房号和昵称'; return; }
     document.getElementById('lobbyError').textContent = '';
     socket.emit('join_room', { code, name });
   });
 
   document.getElementById('btnUpdateSettings').addEventListener('click', () => {
     socket.emit('update_settings', {
       sb: parseInt(document.getElementById('setSb').value) || 10,
       bb: parseInt(document.getElementById('setBb').value) || 20,
       startingChips: parseInt(document.getElementById('setStartingChips').value) || 1000,
     });
   });
 
   document.getElementById('btnStartGame').addEventListener('click', () => {
     socket.emit('start_game');
   });
 
   // Action buttons
   document.querySelectorAll('[data-action]').forEach(btn => {
     btn.addEventListener('click', () => {
       const type = btn.dataset.action;
       const amount = parseInt(document.getElementById('raiseAmount')?.value) || 0;
       socket.emit('player_action', { type, amount });
     });
   });
 
   document.getElementById('btnNextHand').addEventListener('click', () => {
     socket.emit('next_hand');
   });

  document.getElementById("btnEndGame").addEventListener("click", () => {
    if (!socket) { console.warn("Socket not ready"); return; }
    if (confirm("确定结束游戏？所有玩家会看到结算结果。")) {
      socket.emit("end_game");
    }
  });

  document.getElementById("btnSummaryClose").addEventListener("click", () => {
    document.getElementById("gameSummary").classList.add("hidden");
  });
  document.getElementById("btnSummaryClose2").addEventListener("click", () => {
    document.getElementById("gameSummary").classList.add("hidden");
  });

  // Restart game after end
  document.getElementById("btnRestartGame").addEventListener("click", () => {
    socket.emit("restart_game");
  });

 
  document.getElementById("btnRebuyHistory").addEventListener("click", showRebuyHistory);
  document.getElementById("btnRebuyClose").addEventListener("click", hideRebuyHistory);

   document.getElementById('btnRebuy').addEventListener('click', () => {
     document.getElementById('rebuyModal').classList.remove('hidden');
   });
 
   document.getElementById('btnRebuyConfirm').addEventListener('click', () => {
     const amount = parseInt(document.getElementById('rebuyAmount').value) || 1000;
     socket.emit('rebuy', { amount });
     document.getElementById('rebuyModal').classList.add('hidden');
   });
 
   document.getElementById('btnRebuyCancel').addEventListener('click', () => {
     document.getElementById('rebuyModal').classList.add('hidden');
   });
 
   document.getElementById('btnLeave').addEventListener('click', () => {

  // -- Borrow modal --
  
  
  // -- Loan records --
    
     if (confirm('确定离开当前游戏？')) {
       window.location.reload();
     }
   });
 
   // Enter key to join
   document.getElementById('inputPlayerName').addEventListener('keydown', (e) => {
     if (e.key === 'Enter') document.getElementById('btnJoinRoom').click();
   });
   document.getElementById('inputRoomCode').addEventListener('keydown', (e) => {
     if (e.key === 'Enter') document.getElementById('btnJoinRoom').click();
   });
 });
