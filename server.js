// server.js
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const path = require('path');
const xlsx = require('xlsx');

// ====== 모듈 불러오기 ======
const { calcConfirmScores } = require('./ConfirmScore');     // 인증점수 계산 및 저장
const { selectVerifiers } = require('./Confirm');            // 인증점수 기반 검증자 선정
const { processClick, recordClick, saveClick } = require('./Click');    // 클릭 기록 처리
const { calcPersonalRelScores } = require('./PRelScore');    // 개인 관계 점수 계산
const { saveNewUser } = require('./name');
const { calcRelPairsScores, savePairScores } = require('./RelScore');            // 클릭 DB 저장

// ====== 서버 초기화 ======
const app = express();
const server = http.createServer(app);
const io = socketio(server);

app.use(express.json());

app.post('/api/registerUser', (req, res) => {
  const { nickname, wallet } = req.body;

  if (!nickname || !wallet) {
    return res.status(400).json({ error: '닉네임과 지갑주소가 필요합니다.' });
  }

  const normalizedWallet = wallet.toLowerCase();

  // 이미 등록된 경우
  if (nameDB.has(normalizedWallet)) {
    const existingNick = nameDB.get(normalizedWallet);
    console.log(`🔍 기존 사용자 불러오기 완료: ${existingNick} (${normalizedWallet})`);
    return res.json({ 
      status: 'existing', 
      message: '불러오기 완료', 
      nickname: existingNick, 
      wallet: normalizedWallet 
    });
  }

  // 신규 사용자 저장 시도
  const saved = saveNewUser({ nickname, wallet: normalizedWallet });
  if (saved) {
    // 서버 메모리 nameDB 갱신
    nameDB.set(normalizedWallet, nickname);
    console.log(`✅ 신규 사용자 저장 완료: ${nickname} (${normalizedWallet})`);
    res.json({ status: 'success', message: '신규 사용자 저장 완료', nickname, wallet: normalizedWallet });
  } else {
    res.status(500).json({ status: 'fail', message: '저장 실패' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));



// ====== 사용자/검증자 소켓 관리 ======
const userSockets = new Map();      // 지갑주소 → socket.id
const validatorSockets = new Map(); // 검증자 지갑주소 → socket.id

// ====== DB 파일 경로 ======
const NAME_DB_PATH = path.join(__dirname, 'db', 'nameDB.xlsx');
const CHAT_LOGS_PATH = path.join(__dirname, 'db', 'chatLogsDB.xlsx');

// ====== 전역 상태 ======
const nameDB = new Map();               // wallet → nickname
const pendingVerifications = {};        // 후보자별 투표 상태
let validators = [];                    // 현재 뽑힌 검증자 목록

//잘됨////////////////////////////////////////////////////////////////
/* ------------------------------------------------------------------ */
/* 📌 1. 유틸: NameDB 로드 */
function loadNameDB() {
  try {
    const wb = xlsx.readFile(NAME_DB_PATH);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(ws, { header: 1 }).slice(1);

    nameDB.clear();
    for (const row of data) {
      const nickname = row[0]?.toString().trim();
      const wallet = row[1]?.toString().toLowerCase().trim();
      if (nickname && wallet) nameDB.set(wallet, nickname);
    }
    console.log('✅ nameDB 로드 완료:', nameDB.size);
  } catch (err) {
    console.error('❌ nameDB 로드 오류:', err);
  }
}
loadNameDB();
//수정완료s///////////////////////////////////////////////////
// 서버 시작될 때 지갑주소를 가진 사용자의 닉네임 조회하게 준비하는 함수
/* ------------------------------------------------------------------ */
/* 📌 2. 유틸: 채팅 로그 읽기/쓰기 */
function loadChatLogs() {
  try {
    const wb = xlsx.readFile(CHAT_LOGS_PATH);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(ws, { header: 1 });
    return data.map(row => ({
      fromUser: row[0],
      link: row[1]   // ✅ B열(row[1])을 link로 읽도록
    }));
  } catch (err) {
    console.error('❌ 채팅 로그 로드 오류:', err);
    return [];
  }
}

function saveChatLog({ fromUser, link }) {
  try {
    if (!fromUser || !link) {
      console.log('fromUser 또는 link 없음');
      return;
    }

    // 기존 파일 읽기
    let logs = [];

    try {
      const wb = xlsx.readFile(CHAT_LOGS_PATH);
      const ws = wb.Sheets[wb.SheetNames[0]];
      logs = xlsx.utils.sheet_to_json(ws, { header: 1 });
    } catch {
      logs = [];
    }

    // 새로운 로그 추가 (최신순)
    logs.unshift([fromUser, link]);

    // 새 워크북/워크시트 생성
    const newWb = xlsx.utils.book_new();
    const newWs = xlsx.utils.aoa_to_sheet(logs);
    xlsx.utils.book_append_sheet(newWb, newWs, 'ChatLogs');

    // 파일 저장 (덮어쓰기)
    xlsx.writeFile(newWb, CHAT_LOGS_PATH);

    console.log(`💾 채팅 로그 저장 완료: ${fromUser} → ${link}`);
  } catch (err) {
    console.error('❌ 채팅 로그 저장 오류:', err);
  }
}
//수정완료f/////////////////////////////////////////////////////////////////////

/* ------------------------------------------------------------------ */
/* 📌 3. REST API */
app.get('/users', (req, res) => {
  res.json(Array.from(userSockets.keys()));
});

app.post('/api/approveUser', (req, res) => {
  const { candidate, nickname, approvers, link } = req.body;
  
  if (!candidate || !nickname || !Array.isArray(approvers) || !link) {
    return res.status(400).json({ error: '잘못된 요청 데이터' });
  }

  processClick(candidate, nickname, 'profileLinkPlaceholder');
  approvers.forEach(validator => recordClick(validator, candidate, link));

  console.log(`사용자 ${candidate} 승인 및 클릭 기록 저장 완료`);
  res.json({ status: 'success' });
});
//잘됨//////////////////////////////////////////////////////////////////////////
/* ------------------------------------------------------------------ */
/* 📌 4. Socket.IO 이벤트 처리 */
io.on('connection', (socket) => {
  console.log(`클라이언트 연결됨: ${socket.id}`);
  const nicknameToWallet = new Map();

  // ==== 4-1. 기존 사용자 등록 ====
  socket.on('registerUser', async ({ walletAddr, nickname }) => {
    const normalizedWallet = walletAddr.toLowerCase();
    const isExistingUser = nameDB.has(normalizedWallet);

    userSockets.set(normalizedWallet, { socketId: socket.id, nickname });
    nicknameToWallet.set(nickname, normalizedWallet);  // 추가

    if (isExistingUser) {
      console.log(`기존 사용자 등록: ${walletAddr} (${nickname})`);
      socket.emit('existingUserConfirmed', { walletAddr: normalizedWallet, nickname });
    } else {
      console.log(`신규 사용자 등록: ${walletAddr} (${nickname}) - DB 저장 시도`);
      const saved = saveNewUser({ wallet: normalizedWallet, nickname });
     if (saved) {
       console.log('✅ 신규 사용자 DB 저장 완료');
       // 서버 메모리 맵 갱신
        nameDB.set(normalizedWallet, nickname);
     } else {
        console.log('❌ 신규 사용자 DB 저장 실패');
      }
    }
  });
//잘됨f//////////////////////////////////////////
 socket.on('registerValidator', ({ walletAddr, nickname }) => {
    const normalizedWallet = walletAddr.toLowerCase();
    validatorSockets.set(normalizedWallet, socket.id);
    console.log(`🔔 검증자 등록됨: ${walletAddr} (${nickname})`);
  });

//수정완료s/////////////////////////////////////////////////////////////////////
  // ==== 4-2. 채팅 ====
  // 기존 채팅 로그 전송

  const logs = loadChatLogs();
  console.log(`202줄`);
  socket.emit('chatLogs', logs);

  // sendMessage 이벤트 핸들러
  socket.on('sendMessage', ({ fromUser, link }) => {
    saveChatLog({ fromUser, link });

    const toSocketInfo = userSockets.get(fromUser);
    if (toSocketInfo) io.to(toSocketInfo.socketId).emit('receiveMessage', { fromUser, link });
    socket.emit('receiveMessage', { fromUser, link });
  });
 
//======================================================================================================//
// ==== 4-3. 링크 업로드 ====
socket.on('newLink', async ({ link, fromUser }) => {
  const prelArray = calcPersonalRelScores();
  const prel = Object.fromEntries(prelArray); // 배열 → 객체
  const userScore = prel[fromUser] || 0;

  if (userScore >= 0.5) {
    // 1) 메시지 브로드캐스트
    io.emit('receiveMessage', { fromUser, link });
    console.log(`✅ 메시지 브로드캐스트: ${fromUser}`);

    // 2) chatLogsDB.xlsx에 기록
    saveChatLog({ fromUser, link });
    console.log(`💾 chatLogsDB 저장: ${fromUser} -> ${link}`);

  } else {
    console.log(`❌ 점수 부족으로 메시지 차단: ${fromUser}`);
  }
});

// ==== 4-4. 링크 클릭 ====
    socket.on('linkClicked', async ({ fromUser, toUser, link }) => {
      console.log(`링크 클릭: ${toUser} -> ${fromUser} | ${link}`);

      const { processClick, recordClick, loadClicks } = require('./Click');
      console.log('fromUser value:', fromUser);
      console.log('fromUser type:', typeof fromUser);


      // 1. calcPersonalRelScores 결과 확인
      const prelArray = calcPersonalRelScores();
      const prel = Object.fromEntries(prelArray);
      const fromUsernickname = fromUser.trim();
      console.log('prelArray:', prelArray);


      console.log('fromUser:', fromUsernickname);
      console.log('prel keys:', Object.keys(prel));


      const score = prel[fromUsernickname] || 0.0;

      // 2. prel에 없으면 PRelScoreDB 확인
      if (!prel[fromUsernickname]) {
      console.log("calcPRel 했을 때 계산해서 안 나옴. 44링크클릭의 2번확인");}

      // 3. toUser socket 정보 가져오기
      console.log('toUser:', toUser);
      console.log('nicknameToWallet:', Array.from(nicknameToWallet.entries()));

      const toWallet = nicknameToWallet.get(toUser);
      console.log('toUser:', toUser);
      console.log('toWallet:', toWallet);

      const toSocketInfo = toWallet ? userSockets.get(toWallet) : null;
      console.log('toSocketInfo:', toSocketInfo);
      
      // 4. 점수에 따라 접근 허용/거부
      if (score >= 0.5) {
          try {
          const { calcRelPairsScores, savePairScores } = require('./RelScore');
          const pairsScores = calcRelPairsScores();
          savePairScores(pairsScores);
          console.log('RelScore.js 관계쌍 점수 계산 및 저장 완료');
        } catch (error) {
          console.error('RelScore.js 처리 중 오류 발생:', error);
        }
        console.log(`✅ 점수 통과 접근 허용: ${toUser} -> ${fromUser}`);
        if (toSocketInfo) {
          console.log(`linkAccessGranted emit: to=${toUser}, from=${fromUser}, link=${link}`);
        } 
      io.to(toSocketInfo.socketId).emit('linkAccessGranted', { fromUser, link }); //--->html에서 linkAccessGranted
        // 클릭 기록
        recordClick(fromUser, toUser, link);
      } else {
        console.log(`❌ 점수 미달 접근 거부: ${toUser} -> ${fromUser}`);
        if (toSocketInfo) {
          console.log(`linkAccessDenied emit: to=${toUser}, from=${fromUser}, link=${link}, reason=점수 미달`);
        } 
      io.to(toSocketInfo.socketId).emit('linkAccessDenied', { fromUser, link, reason: '점수 미달' });  //--->html에서 linkAcessDenied
      }

    });
//수정완료////////////////////////////////////////////////////////////////////////////////

  // ==== 4-5. 신규 사용자 입장 요청 ====
  socket.on('registerUser', async ({ walletAddr, nickname }) => {
  const normalizedWallet = walletAddr.toLowerCase();
  const isExistingUser = nameDB.has(normalizedWallet);

  // 소켓 및 닉네임 매핑
  userSockets.set(normalizedWallet, { socketId: socket.id, nickname });
  nicknameToWallet.set(nickname, normalizedWallet);

  if (isExistingUser) {
    console.log(`기존 사용자 등록: ${walletAddr} (${nickname})`);
    socket.emit('existingUserConfirmed', { walletAddr: normalizedWallet, nickname });
  } else {
    console.log(`신규 사용자 등록: ${walletAddr} (${nickname}) - DB 저장 시도`);
    const saved = saveNewUser({ wallet: normalizedWallet, nickname });
    if (saved) {
      console.log('✅ 신규 사용자 DB 저장 완료');
      nameDB.set(normalizedWallet, nickname);
    } else {
      console.log('❌ 신규 사용자 DB 저장 실패');
    }
  }
});


  // ==== 4-6. 투표 ====
  socket.on('vote', ({ candidate, verifier, approve }) => {
    verifier = verifier.toLowerCase();
    const data = pendingVerifications[candidate];
    if (!data || data.votes[verifier] !== undefined) return;

    data.votes[verifier] = !!approve;
    if (Object.keys(data.votes).length === data.validators.length) {
      finalizeVerification(candidate);
    }
  });
//잘됨///////////////////////////////////////////////////////////////////////
  // ==== 4-7. 연결 종료 ====
  socket.on('disconnect', () => {
    for (const [wallet, info] of userSockets.entries()) {
      if (info.socketId === socket.id) userSockets.delete(wallet);
    }
    for (const [v, id] of validatorSockets.entries()) {
      if (id === socket.id) validatorSockets.delete(v);
    }
    console.log(`클라이언트 해제: ${socket.id}`);
  });
});
////////////////////////////////////////////////////////////////////////////
/* ------------------------------------------------------------------ */
/* 📌 5. 검증 최종 처리 */
function finalizeVerification(candidate) {
    const data = pendingVerifications[candidate];
    if (!data) return;

    const approvals = Object.values(data.votes).filter(v => v).length;
    const total = data.validators.length;
    const approved = approvals * 3 >= total * 2; // 2/3 이상 찬성

    if (approved) console.log(`✅ ${candidate} 승인 (${approvals}/${total})`);
    else console.log(`❌ ${candidate} 거절 (${approvals}/${total})`);

    const socketInfo = userSockets.get(candidate);
    if (socketInfo) io.to(socketInfo.socketId).emit('verificationCompleted', { candidate, approved });

    data.validators.forEach(v => {
        const vId = validatorSockets.get(v.toLowerCase());
        if (vId) io.to(vId).emit('verificationResult', { candidate, approved });
    });

    delete pendingVerifications[candidate];
  }

/* ------------------------------------------------------------------ */
// 서버 실행
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});