// ============================================================
// 海龟汤联机游戏 - 客户端 (game.js)
// ============================================================
const socket = io();

let playerId = null;
let myNickname = "";
let currentRoomId = null;
let isHost = false;
let isReady = false;
let gameState = "waiting";
let myPlayerId = null;

// 颜色列表
const AVATAR_COLORS = [
  "#ff6b6b", "#ffd93d", "#6bcb77", "#4d96ff",
  "#ff922b", "#cc5de8", "#20c997", "#f06595"
];

// ============================================================
// 页面工具
// ============================================================
function $(id) { return document.getElementById(id); }
function showPage(id) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  $(id).classList.add("active");
  $(id).classList.remove("hidden");
}

function showToast(msg, type = "info") {
  const container = $("toastContainer");
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// 常用 DOM 引用
const nicknameInput = $("nicknameInput");
const roomCodeInput = $("roomCodeInput");
const lobbyError = $("lobbyError");

// ============================================================
// 入口页
// ============================================================
function showJoin() {
  $("joinSection").classList.remove("hidden");
}

function createRoom() {
  const nickname = nicknameInput.value.trim();
  if (!nickname) { lobbyError.textContent = "请输入昵称"; return; }
  lobbyError.textContent = "";

  socket.emit("createRoom", { nickname, totalRounds: 3 }, (res) => {
    if (res.success) {
      myNickname = nickname;
      currentRoomId = res.roomId;
      isHost = true;
      myPlayerId = socket.id;
      enterRoom(res.roomId, res.players);
    } else {
      lobbyError.textContent = res.error;
    }
  });
}

function joinRoom() {
  const nickname = nicknameInput.value.trim();
  const roomId = roomCodeInput.value.trim().toUpperCase();
  if (!nickname) { lobbyError.textContent = "请输入昵称"; return; }
  if (roomId.length !== 4) { lobbyError.textContent = "请输入4位房间码"; return; }
  lobbyError.textContent = "";

  socket.emit("joinRoom", { nickname, roomId }, (res) => {
    if (res.success) {
      myNickname = nickname;
      currentRoomId = res.roomId;
      isHost = false;
      myPlayerId = socket.id;
      enterRoom(res.roomId, res.players);
    } else {
      lobbyError.textContent = res.error;
    }
  });
}

// 回车键加入
nicknameInput.addEventListener("keydown", e => { if (e.key === "Enter") createRoom(); });
roomCodeInput.addEventListener("keydown", e => { if (e.key === "Enter") joinRoom(); });

// ============================================================
// 房间页
// ============================================================
function enterRoom(roomId, players) {
  $("roomCodeDisplay").textContent = roomId;
  updatePlayerList(players);
  showPage("pageRoom");

  if (isHost) {
    $("hostSection").classList.remove("hidden");
    $("readySection").classList.add("hidden");
    $("waitingSection").classList.add("hidden");
  } else {
    $("hostSection").classList.add("hidden");
    $("readySection").classList.remove("hidden");
    $("waitingSection").classList.add("hidden");
  }
}

function updatePlayerList(players) {
  const list = $("playerList");
  list.innerHTML = "";
  $("playerCount").textContent = players.filter(p => p.online !== false).length;

  players.forEach(p => {
    const card = document.createElement("div");
    card.className = "player-card";
    const colorIndex = Math.abs(hashCode(p.id || p.nickname)) % AVATAR_COLORS.length;
    const color = AVATAR_COLORS[colorIndex];

    let badges = "";
    if (p.isHost) badges += '<span class="host-badge">👑 房主</span> ';
    if (p.isReady) badges += '<span class="ready-badge">✅ 已准备</span> ';
    if (!p.online && p.online !== undefined) badges += '<span style="color:#666;font-size:12px;">⛔ 离线</span>';

    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="width:32px;height:32px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;">
          ${p.nickname.charAt(0)}
        </div>
        <span class="name">${escapeHtml(p.nickname)}</span>
      </div>
      <div>${badges || '<span class="not-ready">⏳ 未准备</span>'}</div>
    `;
    list.appendChild(card);
  });
}

function toggleReady() {
  isReady = !isReady;
  $("btnReady").textContent = isReady ? "✅ 已准备" : "✅ 准备";
  $("btnReady").style.background = isReady ? "var(--accent2)" : "";
  socket.emit("toggleReady");
}

function startGame() {
  socket.emit("startGame");
}

// ============================================================
// Socket 事件
// ============================================================

// 房间更新
socket.on("roomUpdated", (data) => {
  updatePlayerList(data.players);
  if (isHost) {
    $("btnStart").disabled = !data.allReady;
    if (data.allReady) {
      $("btnStart").textContent = "🚀 全部已准备，点击开始！";
    } else {
      $("btnStart").textContent = "🚀 开始游戏";
    }
  }
});

// 新的一轮
socket.on("newRound", (data) => {
  gameState = "playing";
  showPage("pageGame");

  $("roundNum").textContent = data.round;
  $("totalRounds").textContent = data.totalRounds;
  $("storyTitle").textContent = data.story.title;
  $("storyBody").textContent = data.story.story;
  $("storyDifficulty").textContent = "★".repeat(data.story.difficulty) + "☆".repeat(5 - data.story.difficulty);
  $("storyTags").innerHTML = (data.story.tags || []).map(t => `<span>${t}</span>`).join("");
  $("logList").innerHTML = '<div class="log-empty">问题会显示在这里...</div>';
  $("logCount").textContent = "0 条";
  $("questionInput").value = "";

  // 更新玩家头像
  updateGameAvatars(data.players);

  // 更新回合
  updateTurn(data.currentTurn);
});

// 游戏玩家头像
function updateGameAvatars(players) {
  const container = $("gamePlayerAvatars");
  container.innerHTML = "";
  players.forEach(p => {
    const colorIndex = Math.abs(hashCode(p.id || p.nickname)) % AVATAR_COLORS.length;
    const color = AVATAR_COLORS[colorIndex];
    const div = document.createElement("div");
    div.className = "player-avatar";
    div.id = "avatar-" + p.id;
    div.style.background = color;
    div.title = `${p.nickname} (${p.score}分)`;
    div.textContent = p.nickname.charAt(0);
    container.appendChild(div);
  });
}

// 回合更新
function updateTurn(turn) {
  if (!turn) {
    $("turnPlayer").textContent = "回合结束";
    $("questionInput").disabled = true;
    $("btnAsk").disabled = true;
    $("btnPass").disabled = true;
    return;
  }

  const isMyTurn = turn.playerId === socket.id;
  $("turnPlayer").textContent = isMyTurn ? "你的" : turn.nickname;
  $("timerDisplay").textContent = "--";

  $("questionInput").disabled = !isMyTurn;
  $("btnAsk").disabled = !isMyTurn;
  $("btnPass").disabled = !isMyTurn;

  if (isMyTurn) {
    $("questionInput").focus();
  }

  // 高亮当前玩家头像
  document.querySelectorAll(".player-avatar").forEach(el => el.classList.remove("active-turn"));
  const avatar = $("avatar-" + turn.playerId);
  if (avatar) avatar.classList.add("active-turn");
}

// 计时器更新
socket.on("timerUpdate", (data) => {
  $("timerDisplay").textContent = data.timeRemaining + "s";
  const pct = (data.timeRemaining / 60) * 100;
  const fill = $("timerFill");
  fill.style.width = pct + "%";

  const timer = $("timerDisplay");
  timer.className = "timer";
  fill.className = "timer-fill";
  if (data.timeRemaining <= 10) {
    timer.classList.add("danger");
    fill.classList.add("danger");
  } else if (data.timeRemaining <= 20) {
    timer.classList.add("warning");
    fill.classList.add("warning");
  }
});

// 新回答
socket.on("newAnswer", (data) => {
  updateLog(data.questionLog);
  if (data.currentTurn) {
    updateTurn(data.currentTurn);
  }
});

// 更新日志
function updateLog(log) {
  const list = $("logList");
  list.innerHTML = "";
  $("logCount").textContent = log.length + " 条";

  log.forEach(item => {
    const div = document.createElement("div");
    div.className = "log-item";

    let aClass = "a";
    if (item.answerType === "no") aClass += " no";
    else if (item.answerType === "irrelevant" || item.answerType === "pass") aClass += " irrelevant";
    else if (item.answerType === "key") aClass += " key";
    else if (item.answerType === "hint") aClass += " hint";

    div.innerHTML = `
      <div class="q"><span class="player-name">${escapeHtml(item.player)}</span>：${escapeHtml(item.question)}</div>
      ${item.answer ? `<div class="${aClass}"> → ${escapeHtml(item.answer)}</div>` : ""}
    `;
    list.appendChild(div);
  });

  list.scrollTop = list.scrollHeight;
}

// 猜答案结果
socket.on("guessResult", (data) => {
  if (data.correct) {
    showToast(`🎉 ${data.player} 猜对了！+${data.bonus}分`, "success");
    // 高亮头像
    const avatar = $("avatar-" + data.player);
    if (avatar) avatar.classList.add("correct");
  } else {
    // 只有提交者看到
  }
});

// 进入揭晓
socket.on("enterReveal", (data) => {
  showPage("pageReveal");
  if (data.correctGuesser) {
    $("revealTitle").textContent = "🎉 真相大白";
    $("revealGuesser").textContent = `👏 ${data.correctGuesser} 猜出了真相！`;
  } else {
    $("revealTitle").textContent = "🔍 真相揭晓";
    $("revealGuesser").textContent = "没有人猜出完整的真相，看看答案吧：";
  }
  $("revealAnswer").textContent = data.answer;
});

// 回合完成
socket.on("roundComplete", (data) => {
  $("questionInput").disabled = true;
  $("btnAsk").disabled = true;
  $("btnPass").disabled = true;
});

// 游戏结束
socket.on("gameOver", (data) => {
  gameState = "finished";
  showPage("pageGameOver");
  const rankings = $("rankings");
  rankings.innerHTML = "";

  data.rankings.forEach((r, i) => {
    const medals = ["🥇", "🥈", "🥉"];
    const card = document.createElement("div");
    card.className = "rank-card";
    card.innerHTML = `
      <div><span class="rank rank-${r.rank}">${medals[i] || "#" + r.rank}</span></div>
      <span class="name">${escapeHtml(r.nickname)}</span>
      <span class="score">${r.score} 分</span>
    `;
    rankings.appendChild(card);
  });
});

// 重新开始
socket.on("gameRestarted", (data) => {
  isReady = false;
  enterRoom(currentRoomId, data.players);
});

// 聊天消息
socket.on("chatMessage", (data) => {
  showToast(`${data.player}: ${data.message}`, "info");
});

// 错误
socket.on("error", (msg) => {
  showToast(msg, "error");
});

// 连接状态
socket.on("connect", () => {
  $("connectionStatus").textContent = "🟢 已连接";
  $("connectionStatus").style.color = "var(--accent2)";
});
socket.on("disconnect", () => {
  $("connectionStatus").textContent = "🔴 已断开";
  $("connectionStatus").style.color = "var(--danger)";
  showToast("与服务器断开连接，尝试重连中...", "error");
});
socket.on("reconnect", () => {
  showToast("已重新连接", "success");
});

// ============================================================
// 游戏操作
// ============================================================
function askQuestion() {
  const input = $("questionInput");
  const question = input.value.trim();
  if (!question) return;
  if (question.length > 200) { showToast("问题太长，最多200字", "error"); return; }

  input.value = "";
  socket.emit("askQuestion", { question }, (res) => {
    if (!res.success) {
      showToast(res.error || "提问失败", "error");
    }
  });
}

function passQuestion() {
  socket.emit("passQuestion");
}

function requestHint() {
  socket.emit("requestHint");
}

function showGuessModal() {
  $("guessModal").classList.remove("hidden");
  $("guessInput").value = "";
  $("guessResult").textContent = "";
}

function hideGuessModal() {
  $("guessModal").classList.add("hidden");
}

function submitGuess() {
  const guess = $("guessInput").value.trim();
  if (guess.length < 5) {
    $("guessResult").textContent = "请写出完整的推理（至少5个字）";
    $("guessResult").style.color = "var(--danger)";
    return;
  }

  socket.emit("guessAnswer", { guess }, (res) => {
    if (res.success) {
      if (res.correct) {
        $("guessResult").innerHTML = `✅ 猜对了！获得 ${res.bonus} 分！<br><br><strong>完整真相：</strong><br>${res.answer}`;
        $("guessResult").style.color = "var(--accent2)";
        // 自动跳转
        setTimeout(() => {
          hideGuessModal();
        }, 2000);
      } else {
        $("guessResult").textContent = "❌ 不太对，继续推理吧！";
        $("guessResult").style.color = "var(--danger)";
        setTimeout(() => { hideGuessModal(); }, 1500);
      }
    } else {
      $("guessResult").textContent = res.error || "提交失败";
      $("guessResult").style.color = "var(--danger)";
    }
  });
}

// 回车提交问题
$("questionInput").addEventListener("keydown", e => {
  if (e.key === "Enter") askQuestion();
});

// 在猜答案弹窗中也支持回车
$("guessInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && e.ctrlKey) submitGuess();
});

function revealAnswer() {
  if (confirm("确定要揭晓答案吗？游戏将继续进行。")) {
    socket.emit("revealAnswer");
  }
}

function nextRound() {
  socket.emit("nextRound");
}

function restartGame() {
  socket.emit("restartGame");
}

// ============================================================
// 工具函数
// ============================================================
function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function hashCode(s) {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const chr = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash;
}
