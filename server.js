// ============================================================
// 海龟汤联机游戏 - 服务器 (server.js)
// ============================================================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const stories = require("./stories");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// 游戏房间管理
// ============================================================
const rooms = new Map(); // roomId -> Room

class Player {
  constructor(socketId, nickname, isHost = false) {
    this.id = socketId;
    this.nickname = nickname;
    this.score = 0;
    this.isHost = isHost;
    this.questionsAsked = 0;
    this.hasGuessed = false;
    this.isReady = false;
    this.online = true;
  }
}

class Room {
  constructor(id, hostId) {
    this.id = id;
    this.players = new Map();
    this.hostId = hostId;
    this.state = "waiting"; // waiting | playing | finished
    this.currentStory = null;
    this.currentRound = 0;
    this.totalRounds = 3;
    this.questionLog = [];
    this.usedStoryIds = new Set();
    this.turnIndex = -1;
    this.timerInterval = null;
    this.questionTimeLimit = 60; // 每人每轮提问限时60秒
    this.timeRemaining = 0;
    this.answeredInRound = new Set(); // 本轮已作答的玩家
    this.activeQuestioner = null;
    this.revealPhase = false; // 是否在揭秘阶段
    this.firstClueGiven = false;
    this.secondClueGiven = false;
    this.thirdClueGiven = false;
  }

  addPlayer(socketId, nickname) {
    const isHost = this.players.size === 0;
    const player = new Player(socketId, nickname, isHost);
    this.players.set(socketId, player);
    return player;
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    if (this.players.size === 0) {
      return true; // 房间空，可销毁
    }
    // 如果房主离开，转让房主
    if (this.hostId === socketId) {
      const nextHost = this.players.entries().next();
      if (nextHost) {
        this.hostId = nextHost[0];
        nextHost[1].isHost = true;
      }
    }
    return false;
  }

  getPlayerList() {
    return Array.from(this.players.values()).map(p => ({
      id: p.id,
      nickname: p.nickname,
      score: p.score,
      isHost: p.isHost,
      isReady: p.isReady,
      online: p.online
    }));
  }

  allReady() {
    if (this.players.size < 3) return false;
    return Array.from(this.players.values()).every(p => p.isReady);
  }

  getNextTurn() {
    const playerIds = Array.from(this.players.keys());
    this.turnIndex = (this.turnIndex + 1) % playerIds.length;
    return playerIds[this.turnIndex];
  }

  resetForNewRound() {
    this.answeredInRound.clear();
    this.activeQuestioner = null;
    this.revealPhase = false;
    this.firstClueGiven = false;
    this.secondClueGiven = false;
    this.thirdClueGiven = false;
    this.turnIndex = -1;
  }
}

// ============================================================
// Socket.IO 事件处理
// ============================================================
io.on("connection", (socket) => {
  console.log(`玩家连接: ${socket.id}`);

  let currentRoomId = null;
  let currentPlayerId = socket.id;

  // ---------- 创建房间 ----------
  socket.on("createRoom", (data, callback) => {
    try {
      const { nickname, totalRounds } = data;
      const roomId = generateRoomCode();
      const room = new Room(roomId, socket.id);
      room.totalRounds = totalRounds || 3;
      room.addPlayer(socket.id, nickname);
      rooms.set(roomId, room);
      currentRoomId = roomId;

      socket.join(roomId);

      callback({
        success: true,
        roomId,
        players: room.getPlayerList()
      });

      io.to(roomId).emit("roomUpdated", {
        players: room.getPlayerList(),
        state: room.state
      });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ---------- 加入房间 ----------
  socket.on("joinRoom", (data, callback) => {
    try {
      const { roomId, nickname } = data;
      const room = rooms.get(roomId.toUpperCase());

      if (!room) {
        callback({ success: false, error: "房间不存在" });
        return;
      }
      if (room.state !== "waiting") {
        callback({ success: false, error: "游戏已开始，无法加入" });
        return;
      }
      if (room.players.size >= 5) {
        callback({ success: false, error: "房间已满（最多5人）" });
        return;
      }
      // 检查昵称重复
      const exists = Array.from(room.players.values()).some(
        p => p.nickname === nickname
      );
      if (exists) {
        callback({ success: false, error: "该昵称已被使用" });
        return;
      }

      room.addPlayer(socket.id, nickname);
      currentRoomId = roomId;
      socket.join(roomId);

      callback({
        success: true,
        roomId,
        players: room.getPlayerList()
      });

      io.to(roomId).emit("roomUpdated", {
        players: room.getPlayerList(),
        state: room.state
      });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ---------- 准备/取消准备 ----------
  socket.on("toggleReady", () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    player.isReady = !player.isReady;

    io.to(currentRoomId).emit("roomUpdated", {
      players: room.getPlayerList(),
      state: room.state,
      allReady: room.allReady()
    });
  });

  // ---------- 开始游戏 ----------
  socket.on("startGame", () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.players.size < 3) {
      socket.emit("error", "至少需要3名玩家才能开始");
      return;
    }

    room.state = "playing";
    room.currentRound = 0;
    room.usedStoryIds.clear();
    startNewRound(room);
  });

  // ---------- 提问 ----------
  socket.on("askQuestion", (data, callback) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.state !== "playing") return;

    // 检查是否轮到该玩家
    const playerIds = Array.from(room.players.keys());
    const currentTurnPlayerId = playerIds[room.turnIndex];
    if (socket.id !== currentTurnPlayerId) {
      callback({ success: false, error: "还没轮到你提问" });
      return;
    }

    const question = (data.question || "").trim();
    if (!question) {
      callback({ success: false, error: "问题不能为空" });
      return;
    }
    if (question.length > 200) {
      callback({ success: false, error: "问题太长（最多200字）" });
      return;
    }

    // 检查问问题超时
    if (room.timeRemaining <= 0 && room.activeQuestioner === socket.id) {
      callback({ success: false, error: "提问时间已到" });
      return;
    }

    const player = room.players.get(socket.id);
    player.questionsAsked++;

    // 用故事逻辑回答
    const answer = getAnswerForQuestion(room.currentStory, question);
    const answerType = answer.type; // "yes" | "no" | "irrelevant" | "key"

    room.questionLog.push({
      player: player.nickname,
      question,
      answer: answer.text,
      answerType,
      round: room.currentRound + 1
    });

    // 记录本轮已回答
    room.answeredInRound.add(socket.id);
    room.activeQuestioner = null;

    // 回答后自动切换到下一个玩家
    scheduleNextTurn(room);

    callback({ success: true });

    // 广播问题和回答
    io.to(currentRoomId).emit("newAnswer", {
      player: player.nickname,
      question,
      answer: answer.text,
      answerType,
      questionLog: room.questionLog,
      currentTurn: getCurrentTurnInfo(room)
    });

    // 检查是否所有人都问过，自动轮换到下一轮
    checkRoundComplete(room);
  });

  // ---------- 跳过提问 ----------
  socket.on("passQuestion", () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.state !== "playing") return;

    const playerIds = Array.from(room.players.keys());
    const currentTurnPlayerId = playerIds[room.turnIndex];
    if (socket.id !== currentTurnPlayerId) return;

    const player = room.players.get(socket.id);
    room.questionLog.push({
      player: player.nickname,
      question: "【跳过】",
      answer: "",
      answerType: "pass"
    });
    room.answeredInRound.add(socket.id);
    room.activeQuestioner = null;

    scheduleNextTurn(room);

    io.to(currentRoomId).emit("newAnswer", {
      player: player.nickname,
      question: "【跳过本轮提问】",
      answer: "",
      answerType: "pass",
      questionLog: room.questionLog,
      currentTurn: getCurrentTurnInfo(room)
    });

    checkRoundComplete(room);
  });

  // ---------- 猜测真相 ----------
  socket.on("guessAnswer", (data, callback) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.state !== "playing") return;

    const guess = (data.guess || "").trim();
    if (!guess || guess.length < 5) {
      callback({ success: false, error: "请写出完整的推理" });
      return;
    }

    const player = room.players.get(socket.id);
    player.hasGuessed = true;

    // 判断猜测的相似度（关键词匹配）
    const similarity = evaluateGuess(guess, room.currentStory.answer);
    const isCorrect = similarity >= 0.6;

    if (isCorrect) {
      const bonus = Math.max(10, 100 - room.questionLog.length * 3);
      player.score += bonus;

      // 告诉猜对的玩家
      callback({
        success: true,
        correct: true,
        bonus,
        totalScore: player.score,
        answer: room.currentStory.answer
      });

      // 广播有人猜对了
      io.to(currentRoomId).emit("guessResult", {
        player: player.nickname,
        correct: true,
        score: player.score
      });

      // 进入揭秘阶段
      room.revealPhase = true;
      clearTimeout(room.timerInterval);
      io.to(currentRoomId).emit("enterReveal", {
        correctGuesser: player.nickname,
        answer: room.currentStory.answer
      });
    } else {
      callback({
        success: true,
        correct: false,
        message: "不太对，继续推理吧！"
      });
      io.to(currentRoomId).emit("guessResult", {
        player: player.nickname,
        correct: false
      });
    }
  });

  // ---------- 要求提示 ----------
  socket.on("requestHint", () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.state !== "playing") return;
    if (!room.currentStory.hints || room.currentStory.hints.length === 0) return;

    const story = room.currentStory;
    let hintIndex = -1;
    if (!room.firstClueGiven) {
      hintIndex = 0;
      room.firstClueGiven = true;
    } else if (!room.secondClueGiven) {
      hintIndex = Math.min(1, story.hints.length - 1);
      room.secondClueGiven = true;
    } else if (!room.thirdClueGiven) {
      hintIndex = Math.min(2, story.hints.length - 1);
      room.thirdClueGiven = true;
    } else {
      socket.emit("error", "提示已全部给出");
      return;
    }

    const hint = story.hints[hintIndex];
    room.questionLog.push({
      player: "🎯 系统",
      question: "💡 系统提示",
      answer: hint,
      answerType: "hint"
    });

    io.to(currentRoomId).emit("newAnswer", {
      player: "🎯 系统",
      question: `💡 提示 ${hintIndex + 1}/${story.hints.length}`,
      answer: hint,
      answerType: "hint",
      questionLog: room.questionLog,
      currentTurn: getCurrentTurnInfo(room)
    });
  });

  // ---------- 强制揭晓答案 ----------
  socket.on("revealAnswer", () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.state !== "playing") return;
    if (room.hostId !== socket.id) return;

    room.revealPhase = true;
    clearTimeout(room.timerInterval);
    io.to(currentRoomId).emit("enterReveal", {
      correctGuesser: null,
      answer: room.currentStory.answer
    });
  });

  // ---------- 下一轮 ----------
  socket.on("nextRound", () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (room.hostId !== socket.id) return;

    if (room.currentRound >= room.totalRounds) {
      endGame(room);
      return;
    }

    startNewRound(room);
  });

  // ---------- 重新开始 ----------
  socket.on("restartGame", () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (room.hostId !== socket.id) return;

    // 重置所有玩家状态
    room.players.forEach(p => {
      p.score = 0;
      p.hasGuessed = false;
      p.isReady = false;
    });
    room.usedStoryIds.clear();
    room.state = "waiting";
    room.currentRound = 0;

    io.to(currentRoomId).emit("gameRestarted", {
      players: room.getPlayerList()
    });
  });

  // ---------- 断线重连 ----------
  socket.on("disconnect", () => {
    console.log(`玩家断开: ${socket.id}`);
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (player) {
      player.online = false;
    }

    const empty = room.removePlayer(socket.id);
    if (empty) {
      rooms.delete(currentRoomId);
      return;
    }

    io.to(currentRoomId).emit("roomUpdated", {
      players: room.getPlayerList(),
      state: room.state
    });

    // 如果断线的是当前回合玩家，自动跳过
    if (room.state === "playing") {
      const playerIds = Array.from(room.players.keys());
      const currentTurnPlayerId = playerIds[room.turnIndex];
      if (socket.id === currentTurnPlayerId) {
        room.answeredInRound.add(socket.id);
        scheduleNextTurn(room);
        io.to(currentRoomId).emit("newAnswer", {
          player: player?.nickname || "离开的玩家",
          question: "【玩家断线，自动跳过】",
          answer: "",
          answerType: "pass",
          questionLog: room.questionLog,
          currentTurn: getCurrentTurnInfo(room)
        });
      }
    }
  });

  // ---------- 聊天消息 ----------
  socket.on("chatMessage", (data) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    io.to(currentRoomId).emit("chatMessage", {
      player: player.nickname,
      message: (data.message || "").slice(0, 500),
      time: new Date().toLocaleTimeString()
    });
  });
});

// ============================================================
// 游戏逻辑函数
// ============================================================

// 生成房间码（4位大写字母）
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

// 开始新一轮
function startNewRound(room) {
  room.currentRound++;
  room.resetForNewRound();

  // 选一个没用过的故事
  const available = stories.filter(s => !room.usedStoryIds.has(s.id));
  if (available.length === 0) {
    room.usedStoryIds.clear();
    const allAvailable = stories;
    room.currentStory = allAvailable[Math.floor(Math.random() * allAvailable.length)];
  } else {
    room.currentStory = available[Math.floor(Math.random() * available.length)];
  }
  room.usedStoryIds.add(room.currentStory.id);

  // 清空问题日志
  room.questionLog = [];
  
  // 所有玩家重置猜测状态
  room.players.forEach(p => { p.hasGuessed = false; });

  // 开始第一回合
  const playerIds = Array.from(room.players.keys());
  room.turnIndex = 0;
  const firstTurnPlayerId = playerIds[0];

  // 广播新一轮开始
  io.to(room.id).emit("newRound", {
    round: room.currentRound,
    totalRounds: room.totalRounds,
    story: {
      title: room.currentStory.title,
      story: room.currentStory.story,
      difficulty: room.currentStory.difficulty,
      tags: room.currentStory.tags
    },
    currentTurn: getCurrentTurnInfo(room),
    players: room.getPlayerList()
  });

  // 设置第一个玩家的计时器
  startTurnTimer(room, firstTurnPlayerId);
}

// 设置回合计时器
function startTurnTimer(room, playerId) {
  clearTimeout(room.timerInterval);
  room.timeRemaining = room.questionTimeLimit;
  room.activeQuestioner = playerId;

  const player = room.players.get(playerId);
  if (!player) return;

  io.to(room.id).emit("timerUpdate", {
    timeRemaining: room.timeRemaining,
    activePlayer: playerId,
    activeNickname: player.nickname
  });

  room.timerInterval = setInterval(() => {
    room.timeRemaining--;
    io.to(room.id).emit("timerUpdate", {
      timeRemaining: room.timeRemaining,
      activePlayer: playerId,
      activeNickname: player.nickname
    });

    if (room.timeRemaining <= 0) {
      clearInterval(room.timerInterval);
      // 超时自动跳过
      room.answeredInRound.add(playerId);
      room.activeQuestioner = null;
      room.questionLog.push({
        player: player.nickname,
        question: "【超时跳过】",
        answer: "",
        answerType: "pass"
      });
      io.to(room.id).emit("newAnswer", {
        player: player.nickname,
        question: "⏰ 超时，自动跳过",
        answer: "",
        answerType: "pass",
        questionLog: room.questionLog,
        currentTurn: null
      });
      scheduleNextTurn(room);
      checkRoundComplete(room);
    }
  }, 1000);
}

// 安排下一位玩家
function scheduleNextTurn(room) {
  clearTimeout(room.timerInterval);
  const playerIds = Array.from(room.players.keys());

  // 找下一个未回答的在线玩家
  let nextIndex = (room.turnIndex + 1) % playerIds.length;
  let attempts = 0;
  while (attempts < playerIds.length) {
    const candidatePlayer = room.players.get(playerIds[nextIndex]);
    if (!room.answeredInRound.has(playerIds[nextIndex]) && candidatePlayer?.online) {
      room.turnIndex = nextIndex;
      startTurnTimer(room, playerIds[nextIndex]);
      return;
    }
    nextIndex = (nextIndex + 1) % playerIds.length;
    attempts++;
  }

  // 所有人都已回答
  io.to(room.id).emit("currentTurn", { currentTurn: null });
}

// 检查本轮是否结束
function checkRoundComplete(room) {
  const playerIds = Array.from(room.players.keys());
  const onlinePlayers = playerIds.filter(id => {
    const p = room.players.get(id);
    return p && p.online;
  });

  const allAnswered = onlinePlayers.every(id => room.answeredInRound.has(id));
  if (allAnswered && !room.revealPhase) {
    clearTimeout(room.timerInterval);
    io.to(room.id).emit("roundComplete", {
      round: room.currentRound,
      questionLog: room.questionLog
    });
  }
}

// 获取当前回合信息
function getCurrentTurnInfo(room) {
  const playerIds = Array.from(room.players.keys());
  const currentId = playerIds[room.turnIndex];
  if (!currentId) return null;
  const player = room.players.get(currentId);
  if (!player) return null;
  return {
    playerId: currentId,
    nickname: player.nickname,
    timeRemaining: room.timeRemaining
  };
}

// AI 主持人对问题的回答逻辑
function getAnswerForQuestion(story, question) {
  const q = question.toLowerCase().trim();
  const answer = story.answer.toLowerCase();

  // 关键词匹配判断
  const yesKeywords = [
    "是不是", "是否", "对吗", "正确", "存在", "有没", "这是不是",
    "他是不是", "她是不是", "是不是在", "是不是因为", "凶手",
    "死者", "房间", "门", "窗", "钥匙", "电话", "酒", "食物",
    "毒", "刀", "枪", "绳", "枕头", "安眠药", "烟", "冰",
    "晚上", "白天", "早上", "中午", "深夜", "凌晨", "在家",
    "外面", "办公室", "车里", "餐厅", "酒店", "船上", "电梯",
    "认识", "陌生", "朋友", "家人", "妻子", "丈夫", "孩子",
    "同事", "邻居", "医生", "律师", "老师", "学生", "警察",
    "男的", "女的", "老人", "年轻"
  ];

  const noKeywords = [
    "不是", "没有", "错", "不正确", "意外", "事故", "自然死亡",
    "自杀", "心脏病", "突发", "随机", "正好", "巧合", "不小心"
  ];

  // 检查是否包含故事答案中的关键信息
  function hasKeyInfo(text, q) {
    // 提取答案中的关键实体词
    const keySentences = text.split(/[。！？\n]/);
    for (const sentence of keySentences) {
      const s = sentence.trim().toLowerCase();
      if (!s || s.length < 4) continue;
      // 如果问题中的核心词出现在同一关键句里
      const questionWords = q.split(/[\s,，、。？?！!的了吗呢吧]/).filter(w => w.length >= 2);
      const matchCount = questionWords.filter(w => s.includes(w)).length;
      if (matchCount >= 3) return true;
    }
    return false;
  }

  // 核心匹配逻辑
  const hasKey = hasKeyInfo(answer, q);

  // 判断问题类型
  const isYesQuestion = yesKeywords.some(kw => q.includes(kw));
  const isNoDirected = noKeywords.some(kw => q.includes(kw)) && !q.includes("不是");

  // 拒绝回答引导性问题
  const bannedPatterns = [
    "直接告诉我", "说出答案", "真相是", "答案是什么",
    "直接说", "告诉我答案"
  ];
  if (bannedPatterns.some(p => q.includes(p))) {
    return {
      text: "🤖 主持人：我不能直接告诉你答案，请通过提问来推理！",
      type: "irrelevant"
    };
  }

  // 问候语
  if (/^(你好|嗨|hi|hello|hey|大家好)/i.test(q)) {
    return {
      text: "🤖 主持人：你好！请围绕故事提问。",
      type: "irrelevant"
    };
  }

  // 基于关键信息匹配判断
  if (hasKey) {
    return {
      text: "🤖 主持人：是的，这很重要。",
      type: "yes"
    };
  }

  if (isYesQuestion) {
    if (isNoDirected) {
      return {
        text: "🤖 主持人：不是。",
        type: "no"
      };
    }
    // 随机"是"或"关键"，增加难度
    const r = Math.random();
    if (r < 0.15) {
      return {
        text: "🤖 主持人：这个信息很关键。",
        type: "key"
      };
    }
    return {
      text: "🤖 主持人：是。",
      type: "yes"
    };
  }

  // 默认回答
  const irrelevantResponses = [
    "🤖 主持人：这与故事无关。",
    "🤖 主持人：对这个故事来说不重要。",
    "🤖 主持人：无关。",
    "🤖 主持人：这个问题对解开谜题没有帮助。"
  ];
  return {
    text: irrelevantResponses[Math.floor(Math.random() * irrelevantResponses.length)],
    type: "irrelevant"
  };
}

// 评估猜测与正确答案的匹配度
function evaluateGuess(guess, answer) {
  const g = guess.toLowerCase();
  const a = answer.toLowerCase();

  // 提取关键词
  const stopWords = new Set(["的", "了", "是", "在", "和", "就", "也", "都", "要", "把",
    "被", "让", "给", "从", "到", "这", "那", "它", "他", "她", "们",
    "有", "没", "不", "很", "会", "能", "可", "以", "为", "与"]);
  const answerWords = a.split(/[\s，。！？、：；""''（）\n,.!?:;()]/)
    .filter(w => w.length >= 2 && !stopWords.has(w));
  const guessWords = g.split(/[\s，。！？、：；""''（）\n,.!?:;()]/)
    .filter(w => w.length >= 2 && !stopWords.has(w));

  if (answerWords.length === 0 || guessWords.length === 0) return 0;

  // 计算交集
  let matchCount = 0;
  for (const gw of guessWords) {
    if (answerWords.some(aw => aw.includes(gw) || gw.includes(aw))) {
      matchCount++;
    }
  }

  // 同时检查核心逻辑要素
  const logicElements = [
    "凶手", "杀了", "谋杀", "伪装", "密室", "诡计", "下毒",
    "替换", "冒充", "跟踪", "恐惧", "心理", "计划", "预谋",
    "意外", "失手", "误会", "巧合", "误解"
  ];
  const hasLogic = logicElements.some(e => g.includes(e) && a.includes(e));

  const baseScore = matchCount / Math.max(answerWords.length, guessWords.length);
  const logicBonus = hasLogic ? 0.15 : 0;
  return Math.min(baseScore + logicBonus, 0.95);
}

// 结束游戏
function endGame(room) {
  room.state = "finished";
  clearTimeout(room.timerInterval);

  const rankings = Array.from(room.players.values())
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({
      rank: i + 1,
      nickname: p.nickname,
      score: p.score
    }));

  io.to(room.id).emit("gameOver", { rankings });
}

// ============================================================
// 启动服务器
// ============================================================
const PORT = process.env.PORT || 3800;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🦞 海龟汤游戏服务器运行中`);
  console.log(`   局域网访问: http://192.168.x.x:${PORT}`);
  console.log(`   本机访问:   http://localhost:${PORT}`);
  console.log(`   （请替换 x.x 为你的局域网 IP 地址）`);
});
