import { useState, useRef, useEffect, useCallback } from 'react';
import {
  ref,
  onValue,
  set,
  update,
  get,
  runTransaction,
  onDisconnect,
} from 'firebase/database';
import { db } from './firebase';
import './Page12.css';

// 0: 빈 면(Blank), 1: X 문양(선공), 2: O 문양(후공)
type CubeFace = 0 | 1 | 2;
type PushDirection = 'TOP' | 'BOTTOM' | 'LEFT' | 'RIGHT';

interface QuixoPlayer {
  id: string;
  name: string;
  symbol: 1 | 2; // 1: X, 2: O
  chips: number;
  wins: number;
  currentBet: number;
  isEliminated: boolean;
}

interface WaitlistPlayer {
  id: string;
  name: string;
}

interface SpectatorPlayer {
  id: string;
  name: string;
}

interface NetQuixoRoomData {
  roomId: number;
  status: 'EMPTY' | 'WAITING' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER';
  players: QuixoPlayer[];
  pot: number;
  waitlist: WaitlistPlayer[];
  spectators: SpectatorPlayer[];
  baseTimeout: number;
  anteBet: number;
  roundNumber: number;
  board: CubeFace[]; // 25칸 (5x5) 1차원 배열
  currentTurn: 1 | 2;
  selectedIdx: number | null; // 현재 집어 든 외곽 큐브 인덱스
  lastInsertedIdx: number | null; // 방금 밀어 넣어진 큐브 위치
  shiftedIndices: number[]; // 밀려서 이동한 큐브 인덱스들
  turnDeadline: number | null;
  turnNotice: string;
  winnerAnnouncement: string;
  roundWinnerId: string | null;
  waitingSince?: number | null;
}

interface HallOfFameRecord {
  id: string;
  name: string;
  scoreOrLevel: string;
  date: string;
}

interface ChipFlyEffect {
  id: number;
  playerName: string;
  amount: number;
  color: string;
}

const WOOD_BG_THEMES = [
  'radial-gradient(circle at top, #5d4037 0%, #3e2723 60%, #261612 100%)',
  'radial-gradient(circle at top, #4e342e 0%, #321f1a 60%, #1f120e 100%)',
];

const INITIAL_CHIPS = 10000;
const DEFAULT_TIMEOUT_SEC = 60;

const WIN_LINES: readonly number[][] = [
  // 가로 5줄
  [0, 1, 2, 3, 4],
  [5, 6, 7, 8, 9],
  [10, 11, 12, 13, 14],
  [15, 16, 17, 18, 19],
  [20, 21, 22, 23, 24],
  // 세로 5줄
  [0, 5, 10, 15, 20],
  [1, 6, 11, 16, 21],
  [2, 7, 12, 17, 22],
  [3, 8, 13, 18, 23],
  [4, 9, 14, 19, 24],
  // 대각선 2줄
  [0, 6, 12, 18, 24],
  [4, 8, 12, 16, 20],
];

/**
 * Quixo 초기 5x5 (25칸) 빈 원목 큐브 보드 생성
 */
function createInitialQuixoBoard(): CubeFace[] {
  return Array<CubeFace>(25).fill(0);
}

/**
 * 5x5 보드 외곽(테두리) 칸 여부 판별
 */
function isPerimeterCell(idx: number): boolean {
  if (idx < 0 || idx >= 25) return false;
  const r = Math.floor(idx / 5);
  const c = idx % 5;
  return r === 0 || r === 4 || c === 0 || c === 4;
}

/**
 * 현재 차례(symbol)가 집어 들 수 있는 유효 외곽 큐브 목록 (빈 큐브 또는 자기 문양)
 */
function getSelectableIndices(board: CubeFace[], symbol: 1 | 2): number[] {
  const indices: number[] = [];
  for (let i = 0; i < 25; i++) {
    if (isPerimeterCell(i) && (board[i] === 0 || board[i] === symbol)) {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * 선택한 외곽 큐브(idx)를 제거한 뒤 밀어 넣을 수 있는 방향 목록 반환
 * (자기 자리에 그대로 되돌려 놓는 방향 제외)
 */
function getValidPushDirections(idx: number): PushDirection[] {
  if (!isPerimeterCell(idx)) return [];
  const r = Math.floor(idx / 5);
  const c = idx % 5;
  const dirs: PushDirection[] = [];

  if (r > 0) dirs.push('TOP'); // 위쪽에서 아래로 밀어 넣기
  if (r < 4) dirs.push('BOTTOM'); // 아래쪽에서 위로 밀어 넣기
  if (c > 0) dirs.push('LEFT'); // 왼쪽에서 오른쪽으로 밀어 넣기
  if (c < 4) dirs.push('RIGHT'); // 오른쪽에서 왼쪽으로 밀어 넣기

  return dirs;
}

/**
 * 특정 방향(dir)으로 밀어 넣었을 때 보드 상태 및 이동/삽입 인덱스 계산
 */
function applyQuixoMove(
  board: CubeFace[],
  selectedIdx: number,
  dir: PushDirection,
  symbol: 1 | 2
): {
  nextBoard: CubeFace[];
  insertedIdx: number;
  shiftedIndices: number[];
} {
  const nextBoard = [...board];
  const r = Math.floor(selectedIdx / 5);
  const c = selectedIdx % 5;
  const shiftedIndices: number[] = [];
  let insertedIdx = selectedIdx;

  if (dir === 'TOP') {
    // r행 c열을 비우고, 0 ~ r-1행을 한 칸씩 아래로 내린 뒤 (0, c)에 삽입
    for (let row = r; row > 0; row--) {
      const target = row * 5 + c;
      nextBoard[target] = nextBoard[(row - 1) * 5 + c];
      shiftedIndices.push(target);
    }
    insertedIdx = 0 * 5 + c;
    nextBoard[insertedIdx] = symbol;
  } else if (dir === 'BOTTOM') {
    // r행 c열을 비우고, r+1 ~ 4행을 한 칸씩 위로 올린 뒤 (4, c)에 삽입
    for (let row = r; row < 4; row++) {
      const target = row * 5 + c;
      nextBoard[target] = nextBoard[(row + 1) * 5 + c];
      shiftedIndices.push(target);
    }
    insertedIdx = 4 * 5 + c;
    nextBoard[insertedIdx] = symbol;
  } else if (dir === 'LEFT') {
    // r행 c열을 비우고, 0 ~ c-1열을 오른쪽으로 한 칸씩 민 뒤 (r, 0)에 삽입
    for (let col = c; col > 0; col--) {
      const target = r * 5 + col;
      nextBoard[target] = nextBoard[r * 5 + (col - 1)];
      shiftedIndices.push(target);
    }
    insertedIdx = r * 5 + 0;
    nextBoard[insertedIdx] = symbol;
  } else if (dir === 'RIGHT') {
    // r행 c열을 비우고, c+1 ~ 4열을 왼쪽으로 한 칸씩 민 뒤 (r, 4)에 삽입
    for (let col = c; col < 4; col++) {
      const target = r * 5 + col;
      nextBoard[target] = nextBoard[r * 5 + (col + 1)];
      shiftedIndices.push(target);
    }
    insertedIdx = r * 5 + 4;
    nextBoard[insertedIdx] = symbol;
  }

  return { nextBoard, insertedIdx, shiftedIndices };
}

/**
 * 5줄 완성 여부 및 승자 판정
 * Quixo 공식 규칙: 두 플레이어 모두 5줄이 동시에 완성되면, 수를 둔 쪽이 아닌 상대방 승리
 */
function checkQuixoWinner(
  board: CubeFace[],
  moverSymbol: 1 | 2
): { winner: 1 | 2 | null; winningLine: number[] } {
  let xLine: number[] | null = null;
  let oLine: number[] | null = null;

  for (const line of WIN_LINES) {
    const first = board[line[0]];
    if (first !== 0 && line.every((idx) => board[idx] === first)) {
      if (first === 1 && !xLine) xLine = line;
      if (first === 2 && !oLine) oLine = line;
    }
  }

  if (xLine && oLine) {
    const opponent: 1 | 2 = moverSymbol === 1 ? 2 : 1;
    return {
      winner: opponent,
      winningLine: opponent === 1 ? xLine : oLine,
    };
  }

  if (xLine) return { winner: 1, winningLine: xLine };
  if (oLine) return { winner: 2, winningLine: oLine };
  return { winner: null, winningLine: [] };
}

/**
 * 보드 위 X / O 큐브 개수 집계
 */
function countCubeFaces(board: CubeFace[]): { xCount: number; oCount: number; blankCount: number } {
  let xCount = 0;
  let oCount = 0;
  let blankCount = 0;
  for (const cell of board) {
    if (cell === 1) xCount++;
    else if (cell === 2) oCount++;
    else blankCount++;
  }
  return { xCount, oCount, blankCount };
}

function formatCoord(idx: number): string {
  const colChar = String.fromCharCode(65 + (idx % 5));
  const rowNum = Math.floor(idx / 5) + 1;
  return `${colChar}${rowNum}`;
}

function getPushDirectionLabel(dir: PushDirection): string {
  switch (dir) {
    case 'TOP':
      return '위에서 아래로 ↓';
    case 'BOTTOM':
      return '아래에서 위로 ↑';
    case 'LEFT':
      return '왼쪽에서 오른쪽으로 →';
    case 'RIGHT':
      return '오른쪽에서 왼쪽으로 ←';
  }
}

function createDefaultQuixoRoom(roomId: number): NetQuixoRoomData {
  return {
    roomId,
    status: 'EMPTY',
    players: [],
    pot: 0,
    waitlist: [],
    spectators: [],
    baseTimeout: DEFAULT_TIMEOUT_SEC,
    anteBet: 1000,
    roundNumber: 1,
    board: createInitialQuixoBoard(),
    currentTurn: 1,
    selectedIdx: null,
    lastInsertedIdx: null,
    shiftedIndices: [],
    turnDeadline: null,
    turnNotice: '',
    winnerAnnouncement: '',
    roundWinnerId: null,
    waitingSince: null,
  };
}

export default function Page12() {
  const [appMode, setAppMode] = useState<
    'HOME' | 'SOLO' | 'NET_LOBBY' | 'NET_ROOM' | 'HALL_OF_FAME'
  >('HOME');

  const [mySessionId] = useState<string>(() => {
    const saved = sessionStorage.getItem('quixo_net_uid');
    if (saved) return saved;
    const generated = `qxo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('quixo_net_uid', generated);
    return generated;
  });

  // 넷게임 상태
  const [rooms, setRooms] = useState<NetQuixoRoomData[]>(
    [1, 2, 3, 4].map(createDefaultQuixoRoom)
  );
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [joinModalRoom, setJoinModalRoom] = useState<NetQuixoRoomData | null>(null);
  const [joinPlayerName, setJoinPlayerName] = useState<string>('');
  const [remainingSeconds, setRemainingSeconds] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [waitingCountdownSec, setWaitingCountdownSec] = useState<number>(420);
  const timeoutHandledRef = useRef<number | null>(null);
  const lastSpokenNoticeRef = useRef<string>('');
  const lastCountdownSpokenRef = useRef<number | null>(null);

  // 단독게임(SOLO) 상태
  const [gameState, setGameState] = useState<
    'SETUP' | 'READY' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER'
  >('SETUP');
  const [soloPlayers, setSoloPlayers] = useState<QuixoPlayer[]>([
    {
      id: '1',
      name: '엑스마스터',
      symbol: 1,
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
    },
    {
      id: '2',
      name: '오챌린저',
      symbol: 2,
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
    },
  ]);

  const [soloName1, setSoloName1] = useState('엑스마스터');
  const [soloName2, setSoloName2] = useState('오챌린저');
  const [soloAnteBet, setSoloAnteBet] = useState<number>(1000);
  const [soloTimeoutSec, setSoloTimeoutSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRemainingSec, setSoloRemainingSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRoundNum, setSoloRoundNum] = useState<number>(1);
  const [soloPot, setSoloPot] = useState<number>(0);

  const [soloBoard, setSoloBoard] = useState<CubeFace[]>(createInitialQuixoBoard());
  const [soloTurn, setSoloTurn] = useState<1 | 2>(1);
  const [soloSelectedIdx, setSoloSelectedIdx] = useState<number | null>(null);
  const [soloLastInsertedIdx, setSoloLastInsertedIdx] = useState<number | null>(null);
  const [soloShiftedIndices, setSoloShiftedIndices] = useState<number[]>([]);
  const [soloWinningLine, setSoloWinningLine] = useState<number[]>([]);
  const [showValidHints, setShowValidHints] = useState<boolean>(true);
  const [turnNotice, setTurnNotice] = useState<string>('');
  const [winnerAnnouncement, setWinnerAnnouncement] = useState<string>('');
  const [showFireworks, setShowFireworks] = useState<boolean>(false);
  const [chipFlyEffects, setChipFlyEffects] = useState<ChipFlyEffect[]>([]);

  const [toast, setToast] = useState<{
    id: number;
    text: string;
    type: 'info' | 'success' | 'danger' | 'celebrate';
  } | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);

  const showToast = (
    text: string,
    type: 'info' | 'success' | 'danger' | 'celebrate' = 'info'
  ) => {
    setToast({ id: Date.now(), text, type });
  };

  const speakKorean = (text: string, interrupt = true) => {
    if (!text || !('speechSynthesis' in window)) return;
    const cleanText = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
    if (!cleanText) return;
    if (interrupt) {
      window.speechSynthesis.cancel();
    }
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.1;
    utterance.pitch = 1.05;
    window.speechSynthesis.speak(utterance);
  };

  /**
   * 원목 큐브 픽업 / 슬라이딩 사운드
   */
  const playSound = (kind: 'pick' | 'push' | 'chip' | 'win' | 'tick') => {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioCtx();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      const notesMap: Record<typeof kind, number[]> = {
        pick: [293.66, 392.0], // 원목 큐브 집어 들기
        push: [220, 261.63, 196.0], // 나무 블록 밀어 넣기
        chip: [880, 1174.66],
        win: [523.25, 659.25, 783.99, 1046.5, 1318.5],
        tick: [987.77],
      };

      notesMap[kind].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === 'push' ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.05);
        gain.gain.setValueAtTime(kind === 'push' ? 0.24 : 0.15, ctx.currentTime + idx * 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.05 + 0.18);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.05);
        osc.stop(ctx.currentTime + idx * 0.05 + 0.18);
      });
    } catch {
      // 오디오 차단 예외 무시
    }
  };

  const triggerChipAnimation = (playerName: string, amount: number, color: string) => {
    playSound('chip');
    const id = Date.now() + Math.random();
    setChipFlyEffects((prev) => [...prev, { id, playerName, amount, color }]);
    window.setTimeout(() => {
      setChipFlyEffects((prev) => prev.filter((item) => item.id !== id));
    }, 1050);
  };

  const triggerFireworksCelebration = (announcementText: string) => {
    playSound('win');
    speakKorean(announcementText);
    setShowFireworks(true);
    window.setTimeout(() => {
      setShowFireworks(false);
    }, 4500);
  };

  const handleCountdownCue = (secLeft: number) => {
    if (lastCountdownSpokenRef.current === secLeft) return;
    lastCountdownSpokenRef.current = secLeft;

    if (secLeft === 10) {
      playSound('tick');
      speakKorean('10초 남았습니다.', false);
    } else if (secLeft >= 1 && secLeft <= 5) {
      playSound('tick');
      speakKorean(String(secLeft), false);
    }
  };

  const saveHallOfFameRecord = (
    type: 'SOLO' | 'NET',
    record: { name: string; scoreOrLevel: string }
  ) => {
    const key = type === 'SOLO' ? 'quixo_hof_solo' : 'quixo_hof_net';
    try {
      const existing: HallOfFameRecord[] = JSON.parse(localStorage.getItem(key) || '[]');
      const newEntry: HallOfFameRecord = {
        id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        name: record.name,
        scoreOrLevel: record.scoreOrLevel,
        date: new Date().toLocaleDateString(),
      };
      const updated = [newEntry, ...existing].slice(0, 10);
      localStorage.setItem(key, JSON.stringify(updated));
    } catch (e) {
      console.error(e);
    }
  };

  const getHallOfFameRecords = (type: 'SOLO' | 'NET'): HallOfFameRecord[] => {
    const key = type === 'SOLO' ? 'quixo_hof_solo' : 'quixo_hof_net';
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      return [];
    }
  };

  // =========================================================================
  // 방 나가기 공통 처리
  // =========================================================================
  const leaveRoomById = useCallback(
    async (roomIdToLeave: number) => {
      const roomRef = ref(db, `quixo_rooms/room_${roomIdToLeave}`);
      try {
        await runTransaction(roomRef, (roomData) => {
          if (!roomData) return roomData;
          const room = roomData as NetQuixoRoomData;
          const filteredPlayers = (room.players || []).filter((p) => p.id !== mySessionId);
          const filteredWaitlist = (room.waitlist || []).filter((w) => w.id !== mySessionId);
          const filteredSpectators = (room.spectators || []).filter((s) => s.id !== mySessionId);

          if (filteredPlayers.length === 0 && filteredSpectators.length === 0) {
            return createDefaultQuixoRoom(room.roomId);
          }

          room.players = filteredPlayers.map((p, idx) => ({
            ...p,
            symbol: idx === 0 ? 1 : 2,
          }));
          room.waitlist = filteredWaitlist;
          room.spectators = filteredSpectators;

          if (filteredPlayers.length < 2 && room.status === 'PLAYING') {
            room.status = 'WAITING';
            room.selectedIdx = null;
            room.turnNotice = '⚠️ 상대방이 퇴장하여 대기 상태로 전환되었습니다.';
          }

          return room;
        });
      } catch (err) {
        console.error('방 퇴장 트랜잭션 오류:', err);
      }
    },
    [mySessionId]
  );

  useEffect(() => {
    if (appMode !== 'NET_ROOM' || !selectedRoomId) return;

    const presenceRef = ref(db, `quixo_presence/room_${selectedRoomId}/${mySessionId}`);
    set(presenceRef, { online: true, joinedAt: Date.now() });
    const disconnectHook = onDisconnect(presenceRef);
    disconnectHook.remove();

    const handleWindowClose = () => {
      void leaveRoomById(selectedRoomId);
    };

    window.addEventListener('beforeunload', handleWindowClose);
    window.addEventListener('pagehide', handleWindowClose);

    return () => {
      window.removeEventListener('beforeunload', handleWindowClose);
      window.removeEventListener('pagehide', handleWindowClose);
      disconnectHook.cancel();
    };
  }, [appMode, selectedRoomId, mySessionId, leaveRoomById]);

  // =========================================================================
  // Firebase 실시간 넷게임 동기화
  // =========================================================================
  useEffect(() => {
    if (appMode !== 'NET_LOBBY' && appMode !== 'NET_ROOM') return;

    const ensureRoomsExist = async () => {
      for (const id of [1, 2, 3, 4]) {
        const roomRef = ref(db, `quixo_rooms/room_${id}`);
        const snap = await get(roomRef);
        if (!snap.exists()) {
          await set(roomRef, createDefaultQuixoRoom(id));
        }
      }
    };
    ensureRoomsExist();

    const roomsRef = ref(db, 'quixo_rooms');
    const unsubscribe = onValue(roomsRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      const loadedRooms: NetQuixoRoomData[] = [1, 2, 3, 4].map((id) => {
        const rData = data[`room_${id}`];
        const def = createDefaultQuixoRoom(id);
        if (!rData) return def;

        const normalizedBoard: CubeFace[] = Array.from({ length: 25 }, (_, i) => {
          const val = rData.board?.[i];
          return val === 1 || val === 2 ? val : 0;
        });

        return {
          ...def,
          ...rData,
          players: (rData.players || []).map((p: QuixoPlayer, idx: number) => ({
            ...p,
            symbol: p.symbol === 2 ? 2 : idx === 0 ? 1 : 2,
            chips: typeof p.chips === 'number' ? p.chips : INITIAL_CHIPS,
            wins: typeof p.wins === 'number' ? p.wins : 0,
            currentBet: typeof p.currentBet === 'number' ? p.currentBet : 0,
            isEliminated: Boolean(p.isEliminated),
          })),
          pot: typeof rData.pot === 'number' ? rData.pot : 0,
          waitlist: rData.waitlist || [],
          spectators: rData.spectators || [],
          board: normalizedBoard,
          currentTurn: rData.currentTurn === 2 ? 2 : 1,
          selectedIdx: typeof rData.selectedIdx === 'number' ? rData.selectedIdx : null,
          lastInsertedIdx: typeof rData.lastInsertedIdx === 'number' ? rData.lastInsertedIdx : null,
          shiftedIndices: Array.isArray(rData.shiftedIndices) ? rData.shiftedIndices : [],
        };
      });
      setRooms(loadedRooms);
    });

    return () => unsubscribe();
  }, [appMode]);

  const activeNetRoom =
    appMode === 'NET_ROOM' && selectedRoomId
      ? rooms.find((r) => r.roomId === selectedRoomId) || null
      : null;

  useEffect(() => {
    if (appMode !== 'NET_ROOM' || !activeNetRoom) return;

    if (
      (activeNetRoom.status === 'ROUND_OVER' || activeNetRoom.status === 'MATCH_OVER') &&
      activeNetRoom.winnerAnnouncement &&
      lastSpokenNoticeRef.current !== activeNetRoom.winnerAnnouncement
    ) {
      lastSpokenNoticeRef.current = activeNetRoom.winnerAnnouncement;
      triggerFireworksCelebration(activeNetRoom.winnerAnnouncement);
      return;
    }

    if (activeNetRoom.turnNotice && lastSpokenNoticeRef.current !== activeNetRoom.turnNotice) {
      lastSpokenNoticeRef.current = activeNetRoom.turnNotice;
      speakKorean(activeNetRoom.turnNotice);
    }
  }, [
    appMode,
    activeNetRoom?.turnNotice,
    activeNetRoom?.status,
    activeNetRoom?.winnerAnnouncement,
  ]);

  useEffect(() => {
    if (appMode !== 'NET_ROOM' || !activeNetRoom) {
      setRemainingSeconds(DEFAULT_TIMEOUT_SEC);
      setWaitingCountdownSec(420);
      return;
    }

    const timer = window.setInterval(async () => {
      const now = Date.now();

      if (activeNetRoom.status === 'WAITING' && activeNetRoom.waitingSince) {
        const elapsedSec = (now - activeNetRoom.waitingSince) / 1000;
        const leftSec = Math.max(0, 420 - Math.floor(elapsedSec));
        setWaitingCountdownSec(leftSec);

        if (elapsedSec >= 425) {
          const roomRef = ref(db, `quixo_rooms/room_${activeNetRoom.roomId}`);
          await set(roomRef, createDefaultQuixoRoom(activeNetRoom.roomId));
          showToast('⏳ 대기 시간이 7분을 초과하여 방이 초기화되었습니다.', 'info');
          setSelectedRoomId(null);
          setAppMode('NET_LOBBY');
          return;
        }
      }

      if (activeNetRoom.status === 'PLAYING' && activeNetRoom.turnDeadline) {
        const diff = Math.max(0, Math.ceil((activeNetRoom.turnDeadline - now) / 1000));
        setRemainingSeconds(diff);
        handleCountdownCue(diff);

        if (diff === 0 && timeoutHandledRef.current !== activeNetRoom.turnDeadline) {
          timeoutHandledRef.current = activeNetRoom.turnDeadline;
          handleNetTurnTimeout(activeNetRoom);
        }
      }
    }, 300);

    return () => window.clearInterval(timer);
  }, [appMode, activeNetRoom]);

  // 단독게임(SOLO) 타이머
  useEffect(() => {
    if (appMode !== 'SOLO' || gameState !== 'PLAYING') {
      return;
    }

    const timer = window.setInterval(() => {
      setSoloRemainingSec((prev) => {
        const next = Math.max(0, prev - 1);
        handleCountdownCue(next);
        if (next === 0) {
          const candidates =
            soloSelectedIdx !== null ? [soloSelectedIdx] : getSelectableIndices(soloBoard, soloTurn);
          if (candidates.length > 0) {
            const pickIdx = candidates[Math.floor(Math.random() * candidates.length)];
            const dirs = getValidPushDirections(pickIdx);
            const randomDir = dirs[Math.floor(Math.random() * dirs.length)];
            executeSoloPushMove(pickIdx, randomDir, true);
          }
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [appMode, gameState, soloBoard, soloTurn, soloSelectedIdx, soloTimeoutSec]);

  const handleEnterRoomSubmit = async (asSpectator = false) => {
    if (!joinModalRoom) return;
    const trimmedName = joinPlayerName ? joinPlayerName.trim() : '';
    if (!trimmedName) {
      alert('참가할 이름을 입력해주세요!');
      return;
    }

    const roomRef = ref(db, `quixo_rooms/room_${joinModalRoom.roomId}`);

    try {
      let joinResultType = 'PLAYER';

      await runTransaction(roomRef, (roomData) => {
        const room: NetQuixoRoomData = roomData || createDefaultQuixoRoom(joinModalRoom.roomId);
        if (!room.players) room.players = [];
        if (!room.waitlist) room.waitlist = [];
        if (!room.spectators) room.spectators = [];

        if (asSpectator) {
          room.spectators.push({ id: mySessionId, name: trimmedName });
          joinResultType = 'SPECTATOR';
          return room;
        }

        if (
          room.players.some((p) => p.id === mySessionId) ||
          room.waitlist.some((w) => w.id === mySessionId) ||
          room.spectators.some((s) => s.id === mySessionId)
        ) {
          joinResultType = 'REJOIN';
          return room;
        }

        if ((room.status === 'EMPTY' || room.status === 'WAITING') && room.players.length < 2) {
          const symbol: 1 | 2 = room.players.length === 0 ? 1 : 2;
          const newPlayer: QuixoPlayer = {
            id: mySessionId,
            name: trimmedName,
            symbol,
            chips: INITIAL_CHIPS,
            wins: 0,
            currentBet: 0,
            isEliminated: false,
          };

          room.status = 'WAITING';
          room.players.push(newPlayer);
          if (!room.waitingSince) {
            room.waitingSince = Date.now();
          }
          joinResultType = 'PLAYER';
        } else {
          room.waitlist.push({ id: mySessionId, name: trimmedName });
          joinResultType = 'WAITLIST';
        }
        return room;
      });

      setSelectedRoomId(joinModalRoom.roomId);
      setJoinModalRoom(null);
      setJoinPlayerName('');
      setAppMode('NET_ROOM');

      if (joinResultType === 'SPECTATOR') {
        showToast('👀 관전 모드로 입장했습니다!', 'info');
      } else if (joinResultType === 'WAITLIST') {
        showToast('⏳ 다음 판 예약자로 등록되었습니다!', 'info');
      }
    } catch (err) {
      console.error(err);
      alert('방 입장 중 오류가 발생했습니다.');
    }
  };

  const updateRoomSettings = async (newAnteBet: number, newTimeout: number) => {
    if (!activeNetRoom) return;
    const clampedTimeout = Math.min(180, Math.max(20, newTimeout));
    const roomRef = ref(db, `quixo_rooms/room_${activeNetRoom.roomId}`);
    await update(roomRef, {
      anteBet: newAnteBet,
      baseTimeout: clampedTimeout,
      waitingSince: Date.now(),
    });
  };

  /**
   * 넷게임 라운드 시작 (X / O 선공 교대 배정 및 동일 판돈 베팅)
   */
  const handleStartNetRound = async (isNextRound = false) => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `quixo_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetQuixoRoomData;
      if (!room.players) room.players = [];
      if (!room.waitlist) room.waitlist = [];

      const isNewMatch = room.status === 'MATCH_OVER' || !isNextRound;
      const nextRound = isNewMatch ? 1 : (room.roundNumber || 1) + 1;
      const ante = room.anteBet || 1000;

      const basePlayers = isNewMatch
        ? room.players.map((p) => ({
            ...p,
            chips: INITIAL_CHIPS,
            wins: 0,
            isEliminated: false,
          }))
        : room.players.map((p) => ({
            ...p,
            isEliminated: p.isEliminated || p.chips <= 0,
          }));

      const survivingPlayers = basePlayers.filter((p) => !p.isEliminated);
      const waitlist = [...room.waitlist];
      const nextActive: QuixoPlayer[] = [...survivingPlayers];
      const remainingWaitlist: WaitlistPlayer[] = [];

      for (const w of waitlist) {
        if (nextActive.length < 2) {
          nextActive.push({
            id: w.id,
            name: w.name,
            symbol: 2,
            chips: INITIAL_CHIPS,
            wins: 0,
            currentBet: 0,
            isEliminated: false,
          });
        } else {
          remainingWaitlist.push(w);
        }
      }

      if (nextActive.length < 2) {
        room.status = nextActive.length === 0 ? 'EMPTY' : 'WAITING';
        room.players = nextActive;
        room.waitlist = remainingWaitlist;
        return room;
      }

      const orderedActive =
        isNextRound && !isNewMatch ? [nextActive[1], nextActive[0]] : nextActive;

      const equalStake = Math.min(ante, ...orderedActive.map((p) => p.chips));
      let collectedPot = isNewMatch ? 0 : room.pot || 0;

      const preparedPlayers: QuixoPlayer[] = orderedActive.map((p, idx) => {
        collectedPot += equalStake;
        return {
          ...p,
          symbol: idx === 0 ? 1 : 2,
          chips: p.chips - equalStake,
          currentBet: equalStake,
          isEliminated: false,
        };
      });

      room.status = 'PLAYING';
      room.roundNumber = nextRound;
      room.players = preparedPlayers;
      room.pot = collectedPot;
      room.waitlist = remainingWaitlist;
      room.board = createInitialQuixoBoard();
      room.currentTurn = 1; // X 선공
      room.selectedIdx = null;
      room.lastInsertedIdx = null;
      room.shiftedIndices = [];
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.winnerAnnouncement = '';
      room.roundWinnerId = null;
      room.turnNotice = `🪵 [${nextRound}국] 동일 판돈 ${equalStake.toLocaleString()}칩 베팅! ✖️ [X] ${preparedPlayers[0].name}님 선공입니다.`;
      room.waitingSince = null;

      return room;
    });

    triggerChipAnimation('전원', activeNetRoom.anteBet, '#8d6e63');
  };

  /**
   * 넷게임 라운드 승리 정산
   */
  const settleNetQuixoRound = (room: NetQuixoRoomData, winnerSymbol: 1 | 2) => {
    const winner =
      room.players.find((p) => p.symbol === winnerSymbol) ||
      (winnerSymbol === 1 ? room.players[0] : room.players[1]);
    const wonPot = room.pot || 0;

    room.players = room.players.map((p) => {
      const isWinner = p.id === winner.id;
      const updatedChips = isWinner ? p.chips + wonPot : p.chips;
      return {
        ...p,
        chips: updatedChips,
        wins: isWinner ? (p.wins || 0) + 1 : p.wins || 0,
        isEliminated: updatedChips <= 0,
      };
    });

    const winnerObj = room.players.find((p) => p.id === winner.id)!;
    const anyBusted = room.players.some((p) => p.isEliminated);
    const symbolMark = winnerSymbol === 1 ? '✖️ [X]' : '⭕ [O]';

    room.pot = 0;
    room.selectedIdx = null;
    room.turnDeadline = null;
    room.turnNotice = '';
    room.roundWinnerId = winner.id;

    if (anyBusted) {
      room.status = 'MATCH_OVER';
      room.winnerAnnouncement = `👑 최종 우승! ${symbolMark} ${winner.name}님이 5줄을 완성하며 상대 판돈을 모두 획득했습니다!`;
    } else {
      room.status = 'ROUND_OVER';
      room.winnerAnnouncement = `🎊 ${symbolMark} ${winner.name}님 5줄 완성 승리! 판돈 ${wonPot.toLocaleString()}칩 독식! (${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}칩)`;
    }

    saveHallOfFameRecord('NET', {
      name: winner.name,
      scoreOrLevel: `${winnerObj.wins}승 · 보유 ${winnerObj.chips.toLocaleString()}칩`,
    });
  };

  /**
   * 넷게임 외곽 큐브 클릭 (집기 / 선택 취소)
   */
  const handleNetCubeClick = async (idx: number) => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const actor = activeNetRoom.players.find((p) => p.symbol === activeNetRoom.currentTurn);
    if (!actor || actor.id !== mySessionId) return;

    if (!isPerimeterCell(idx)) {
      showToast('테두리(외곽)에 있는 큐브만 집어 들 수 있습니다!', 'danger');
      return;
    }

    const face = activeNetRoom.board[idx];
    if (face !== 0 && face !== activeNetRoom.currentTurn) {
      showToast('상대방 문양의 큐브는 집을 수 없습니다!', 'danger');
      return;
    }

    playSound('pick');
    const nextSelected = activeNetRoom.selectedIdx === idx ? null : idx;
    const roomRef = ref(db, `quixo_rooms/room_${activeNetRoom.roomId}`);
    await update(roomRef, {
      selectedIdx: nextSelected,
    });
  };

  /**
   * 넷게임 방향 화살표 클릭 (큐브 밀어 넣기 실행)
   */
  const handleNetPushDirection = async (dir: PushDirection) => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    if (activeNetRoom.selectedIdx === null) return;

    const actor = activeNetRoom.players.find((p) => p.symbol === activeNetRoom.currentTurn);
    if (!actor || actor.id !== mySessionId) return;

    playSound('push');
    const roomRef = ref(db, `quixo_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetQuixoRoomData;
      if (room.status !== 'PLAYING' || room.selectedIdx === null) return room;

      const turnSymbol = room.currentTurn;
      const currentActor = room.players.find((p) => p.symbol === turnSymbol);
      if (!currentActor || currentActor.id !== mySessionId) return room;

      const validDirs = getValidPushDirections(room.selectedIdx);
      if (!validDirs.includes(dir)) return room;

      const boardCopy: CubeFace[] = Array.from({ length: 25 }, (_, i) =>
        room.board?.[i] === 1 || room.board?.[i] === 2 ? room.board[i] : 0
      );

      const { nextBoard, insertedIdx, shiftedIndices } = applyQuixoMove(
        boardCopy,
        room.selectedIdx,
        dir,
        turnSymbol
      );

      room.board = nextBoard;
      room.selectedIdx = null;
      room.lastInsertedIdx = insertedIdx;
      room.shiftedIndices = shiftedIndices;

      const { winner } = checkQuixoWinner(nextBoard, turnSymbol);
      if (winner) {
        settleNetQuixoRound(room, winner);
        return room;
      }

      const nextSymbol: 1 | 2 = turnSymbol === 1 ? 2 : 1;
      const nextPlayer = room.players.find((p) => p.symbol === nextSymbol);
      room.currentTurn = nextSymbol;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `🪵 ${currentActor.name}님이 ${getPushDirectionLabel(dir)} 밀어 넣기 완료 👉 ${
        nextSymbol === 1 ? '✖️ [X]' : '⭕ [O]'
      } ${nextPlayer?.name}님 차례!`;

      return room;
    });
  };

  /**
   * 넷게임 시간 초과 시 랜덤 외곽 큐브 픽업 후 랜덤 방향으로 자동 밀기
   */
  const handleNetTurnTimeout = async (room: NetQuixoRoomData) => {
    const roomRef = ref(db, `quixo_rooms/room_${room.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const r = roomData as NetQuixoRoomData;
      if (r.status !== 'PLAYING') return r;

      const turnSymbol = r.currentTurn;
      const actor = r.players.find((p) => p.symbol === turnSymbol);
      const boardCopy: CubeFace[] = Array.from({ length: 25 }, (_, i) =>
        r.board?.[i] === 1 || r.board?.[i] === 2 ? r.board[i] : 0
      );

      const candidates =
        r.selectedIdx !== null ? [r.selectedIdx] : getSelectableIndices(boardCopy, turnSymbol);
      if (candidates.length === 0) return r;

      const chosenIdx = candidates[Math.floor(Math.random() * candidates.length)];
      const dirs = getValidPushDirections(chosenIdx);
      const chosenDir = dirs[Math.floor(Math.random() * dirs.length)];

      const { nextBoard, insertedIdx, shiftedIndices } = applyQuixoMove(
        boardCopy,
        chosenIdx,
        chosenDir,
        turnSymbol
      );

      r.board = nextBoard;
      r.selectedIdx = null;
      r.lastInsertedIdx = insertedIdx;
      r.shiftedIndices = shiftedIndices;

      const { winner } = checkQuixoWinner(nextBoard, turnSymbol);
      if (winner) {
        settleNetQuixoRound(r, winner);
        return r;
      }

      const nextSymbol: 1 | 2 = turnSymbol === 1 ? 2 : 1;
      const nextPlayer = r.players.find((p) => p.symbol === nextSymbol);
      r.currentTurn = nextSymbol;
      r.turnDeadline = Date.now() + r.baseTimeout * 1000;
      r.turnNotice = `⏰ 시간 초과로 ${actor?.name}님이 ${formatCoord(chosenIdx)} 큐브를 자동 밀기! 👉 ${nextPlayer?.name}님 차례!`;

      return r;
    });
  };

  const handleLeaveNetRoom = async () => {
    if (selectedRoomId) {
      await leaveRoomById(selectedRoomId);
    }
    setSelectedRoomId(null);
    setAppMode('NET_LOBBY');
  };

  // =========================================================================
  // 단독게임(SOLO) 로직
  // =========================================================================
  const goToSoloReady = () => {
    const p1Name = soloName1.trim() || '엑스마스터';
    const p2Name = soloName2.trim() || '오챌린저';
    setSoloPlayers([
      {
        id: '1',
        name: p1Name,
        symbol: 1,
        chips: INITIAL_CHIPS,
        wins: 0,
        currentBet: 0,
        isEliminated: false,
      },
      {
        id: '2',
        name: p2Name,
        symbol: 2,
        chips: INITIAL_CHIPS,
        wins: 0,
        currentBet: 0,
        isEliminated: false,
      },
    ]);
    setGameState('READY');
  };

  const swapSoloOrder = () => {
    setSoloPlayers((prev) => [
      { ...prev[1], symbol: 1 },
      { ...prev[0], symbol: 2 },
    ]);
  };

  const startSoloRound = (isNextRound = false) => {
    const isFreshMatch = !isNextRound || gameState === 'MATCH_OVER';
    const nextRound = isFreshMatch ? 1 : soloRoundNum + 1;

    const basePlayers = soloPlayers.map((p) => ({
      ...p,
      chips: isFreshMatch ? INITIAL_CHIPS : p.chips,
      wins: isFreshMatch ? 0 : p.wins,
      isEliminated: false,
    }));

    // 다음 판에서는 X / O 선공 자동 교대
    const orderedPlayers =
      isNextRound && !isFreshMatch
        ? [
            { ...basePlayers[1], symbol: 1 as const },
            { ...basePlayers[0], symbol: 2 as const },
          ]
        : [
            { ...basePlayers[0], symbol: 1 as const },
            { ...basePlayers[1], symbol: 2 as const },
          ];

    const equalStake = Math.min(soloAnteBet, ...orderedPlayers.map((p) => p.chips));
    let totalPot = isFreshMatch ? 0 : soloPot;

    const preparedPlayers = orderedPlayers.map((p) => {
      totalPot += equalStake;
      return {
        ...p,
        chips: p.chips - equalStake,
        currentBet: equalStake,
      };
    });

    triggerChipAnimation('전원', equalStake, '#8d6e63');
    const notice = `🪵 [${nextRound}국] 동일 판돈 ${equalStake.toLocaleString()}칩 베팅! ✖️ [X] ${preparedPlayers[0].name}님 선공입니다.`;

    setSoloRoundNum(nextRound);
    setSoloPot(totalPot);
    setSoloPlayers(preparedPlayers);
    setSoloBoard(createInitialQuixoBoard());
    setSoloTurn(1);
    setSoloSelectedIdx(null);
    setSoloLastInsertedIdx(null);
    setSoloShiftedIndices([]);
    setSoloWinningLine([]);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setWinnerAnnouncement('');
    setShowFireworks(false);
    setTurnNotice(notice);
    speakKorean(notice);
    setGameState('PLAYING');
  };

  const settleSoloQuixoRound = (winnerSymbol: 1 | 2, winLine: number[]) => {
    const winner =
      soloPlayers.find((p) => p.symbol === winnerSymbol) ||
      (winnerSymbol === 1 ? soloPlayers[0] : soloPlayers[1]);

    const settledPlayers = soloPlayers.map((p) => {
      const isWinner = p.id === winner.id;
      const updatedChips = isWinner ? p.chips + soloPot : p.chips;
      return {
        ...p,
        chips: updatedChips,
        wins: isWinner ? p.wins + 1 : p.wins,
        isEliminated: updatedChips <= 0,
      };
    });

    const winnerObj = settledPlayers.find((p) => p.id === winner.id)!;
    const anyBusted = settledPlayers.some((p) => p.isEliminated);
    const symbolMark = winnerSymbol === 1 ? '✖️ [X]' : '⭕ [O]';

    const announcement = anyBusted
      ? `👑 최종 우승! ${symbolMark} ${winner.name}님이 5줄을 완성하며 상대 판돈을 모두 획득했습니다!`
      : `🎊 ${symbolMark} ${winner.name}님 5줄 완성 승리! 판돈 ${soloPot.toLocaleString()}칩 독식! (${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}칩)`;

    setSoloPlayers(settledPlayers);
    setSoloPot(0);
    setSoloSelectedIdx(null);
    setSoloWinningLine(winLine);
    setTurnNotice('');
    setWinnerAnnouncement(announcement);
    setGameState(anyBusted ? 'MATCH_OVER' : 'ROUND_OVER');
    triggerFireworksCelebration(announcement);

    saveHallOfFameRecord('SOLO', {
      name: winner.name,
      scoreOrLevel: `${winnerObj.wins}승 · 보유 ${winnerObj.chips.toLocaleString()}칩`,
    });
  };

  const handleSoloCubeClick = (idx: number) => {
    if (gameState !== 'PLAYING') return;

    if (!isPerimeterCell(idx)) {
      showToast('테두리(외곽) 16칸의 큐브만 선택할 수 있습니다!', 'danger');
      return;
    }

    const face = soloBoard[idx];
    if (face !== 0 && face !== soloTurn) {
      showToast('상대방 문양의 큐브는 집어 들 수 없습니다!', 'danger');
      return;
    }

    playSound('pick');
    setSoloSelectedIdx((prev) => (prev === idx ? null : idx));
  };

  const executeSoloPushMove = (pickIdx: number, dir: PushDirection, isAuto = false) => {
    if (gameState !== 'PLAYING') return;
    playSound('push');

    const { nextBoard, insertedIdx, shiftedIndices } = applyQuixoMove(
      soloBoard,
      pickIdx,
      dir,
      soloTurn
    );

    setSoloBoard(nextBoard);
    setSoloSelectedIdx(null);
    setSoloLastInsertedIdx(insertedIdx);
    setSoloShiftedIndices(shiftedIndices);

    const { winner, winningLine } = checkQuixoWinner(nextBoard, soloTurn);
    if (winner) {
      settleSoloQuixoRound(winner, winningLine);
      return;
    }

    const actor = soloPlayers.find((p) => p.symbol === soloTurn)!;
    const nextSymbol: 1 | 2 = soloTurn === 1 ? 2 : 1;
    const nextPlayer = soloPlayers.find((p) => p.symbol === nextSymbol)!;

    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setSoloTurn(nextSymbol);

    const prefix = isAuto ? '⏰ 시간 초과 자동 이동! ' : '🪵 ';
    const notice = `${prefix}${actor.name}님이 ${formatCoord(pickIdx)} 큐브를 ${getPushDirectionLabel(
      dir
    )} 밀어 넣었습니다 👉 ${nextSymbol === 1 ? '✖️ [X]' : '⭕ [O]'} ${nextPlayer.name}님 차례!`;
    setTurnNotice(notice);
    speakKorean(notice);
  };

  // =========================================================================
  // 사진 디자인 재현: 원형 마호가니 트레이 + 5x5 밝은 원목 큐브 + 방향 화살표
  // =========================================================================
  const renderQuixoWoodenBoard = (
    board: CubeFace[],
    activeTurn: 1 | 2,
    canInteract: boolean,
    pickedIdx: number | null,
    lastInsertedIdx: number | null,
    shiftedIndices: number[],
    winningLine: number[],
    onCubeClick: (idx: number) => void,
    onPushDirection: (dir: PushDirection) => void
  ) => {
    const selectableSet = new Set(canInteract ? getSelectableIndices(board, activeTurn) : []);
    const validPushDirs =
      canInteract && pickedIdx !== null ? new Set(getValidPushDirections(pickedIdx)) : new Set();
    const shiftedSet = new Set(shiftedIndices);
    const winSet = new Set(winningLine);

    return (
      <div className="quixo-tray-wrapper">
        {/* 사진 속 둥근 적갈색 마호가니 트레이 */}
        <div className="quixo-round-mahogany-tray">
          {/* 상단(TOP) 밀어 넣기 방향 버튼 */}
          <div className="push-arrow-row top-row">
            {validPushDirs.has('TOP') ? (
              <button
                type="button"
                className="quixo-push-btn"
                onClick={() => onPushDirection('TOP')}
              >
                ⬇️ 위에서 밀어 넣기
              </button>
            ) : (
              <span className="push-placeholder" />
            )}
          </div>

          <div className="quixo-board-middle-band">
            {/* 좌측(LEFT) 밀어 넣기 방향 버튼 */}
            <div className="push-arrow-col left-col">
              {validPushDirs.has('LEFT') && (
                <button
                  type="button"
                  className="quixo-push-btn vertical"
                  onClick={() => onPushDirection('LEFT')}
                  title="왼쪽에서 오른쪽으로 밀어 넣기"
                >
                  ➡️
                </button>
              )}
            </div>

            {/* 5x5 밝은 원목 큐브 배열 */}
            <div className="quixo-cubes-grid">
              {board.map((face, idx) => {
                const isPerimeter = isPerimeterCell(idx);
                const isSelectable = selectableSet.has(idx);
                const isPicked = pickedIdx === idx;
                const isInserted = lastInsertedIdx === idx;
                const isShifted = shiftedSet.has(idx);
                const isWinCell = winSet.has(idx);

                // 집어 든 큐브는 내 문양으로 미리보기 표시
                const displayFace: CubeFace = isPicked ? activeTurn : face;

                return (
                  <button
                    key={idx}
                    type="button"
                    disabled={!isSelectable}
                    onClick={() => onCubeClick(idx)}
                    className={`quixo-wood-cube ${isPerimeter ? 'perimeter-cube' : 'inner-cube'} ${
                      isSelectable ? 'selectable' : ''
                    } ${isPicked ? 'picked-up-cube' : ''} ${
                      isInserted ? 'cube-inserted-anim' : ''
                    } ${isShifted ? 'cube-shifted-anim' : ''} ${
                      isWinCell ? 'winning-cube' : ''
                    }`}
                    aria-label={`${formatCoord(idx)} 원목 큐브`}
                  >
                    {/* 밝은 자작나무/단풍나무 원목 큐브 상판 */}
                    <span className="cube-top-surface">
                      {displayFace === 1 && (
                        <svg
                          viewBox="0 0 100 100"
                          className="engraved-symbol-svg"
                          aria-hidden="true"
                        >
                          <line x1="22" y1="22" x2="78" y2="78" />
                          <line x1="78" y1="22" x2="22" y2="78" />
                        </svg>
                      )}

                      {displayFace === 2 && (
                        <svg
                          viewBox="0 0 100 100"
                          className="engraved-symbol-svg"
                          aria-hidden="true"
                        >
                          <circle cx="50" cy="50" r="30" />
                        </svg>
                      )}

                      {/* 선택 가능한 외곽 큐브 미세 가이드 */}
                      {displayFace === 0 && isSelectable && showValidHints && pickedIdx === null && (
                        <span className="perimeter-hint-ring" />
                      )}

                      {/* 최근 밀어 넣은 큐브 표시 점 */}
                      {isInserted && !isPicked && <span className="last-inserted-dot" />}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* 우측(RIGHT) 밀어 넣기 방향 버튼 */}
            <div className="push-arrow-col right-col">
              {validPushDirs.has('RIGHT') && (
                <button
                  type="button"
                  className="quixo-push-btn vertical"
                  onClick={() => onPushDirection('RIGHT')}
                  title="오른쪽에서 왼쪽으로 밀어 넣기"
                >
                  ⬅️
                </button>
              )}
            </div>
          </div>

          {/* 하단(BOTTOM) 밀어 넣기 방향 버튼 */}
          <div className="push-arrow-row bottom-row">
            {validPushDirs.has('BOTTOM') ? (
              <button
                type="button"
                className="quixo-push-btn"
                onClick={() => onPushDirection('BOTTOM')}
              >
                ⬆️ 아래에서 밀어 넣기
              </button>
            ) : (
              <span className="push-placeholder" />
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderFireworksAndChips = () => (
    <>
      <div className="chip-fly-layer">
        {chipFlyEffects.map((chip) => (
          <div
            key={chip.id}
            className="flying-poker-chip"
            style={{ backgroundColor: chip.color }}
          >
            <div className="chip-inner-ring">
              <span>{chip.playerName}</span>
              <strong>{chip.amount.toLocaleString()}</strong>
            </div>
          </div>
        ))}
      </div>

      {showFireworks && (
        <div className="fireworks-overlay" aria-hidden="true">
          <div className="firework-burst fb-1" />
          <div className="firework-burst fb-2" />
          <div className="firework-burst fb-3" />
          <div className="firework-burst fb-4" />
          <div className="firework-burst fb-5" />
        </div>
      )}
    </>
  );

  // =========================================================================
  // 1. 홈 화면 (HOME)
  // =========================================================================
  if (appMode === 'HOME') {
    return (
      <div className="qxo-container" style={{ background: WOOD_BG_THEMES[0] }}>
        <div className="setup-card home-entry-card">
          <div className="home-castle-icon">✖️🪵⭕</div>
          <h1 className="setup-title">우드 퀵소 (QUIXO)</h1>
          <p className="home-subtitle">
            5×5 원목 큐브 밀어내기 전략 · 5줄 완성 승자 독식 · 승점 &amp; 판돈 누적
          </p>

          <div className="mode-select-grid">
            <button
              type="button"
              className="mode-select-btn solo"
              onClick={() => {
                setGameState('SETUP');
                setAppMode('SOLO');
              }}
            >
              <span className="mode-icon">🎮</span>
              <strong>단독게임</strong>
              <span className="mode-desc">2인 로컬 대국 · 동일 판돈 연승 매치</span>
            </button>

            <button
              type="button"
              className="mode-select-btn net"
              onClick={() => setAppMode('NET_LOBBY')}
            >
              <span className="mode-icon">🌐</span>
              <strong>넷게임</strong>
              <span className="mode-desc">실시간 4개 원목 테이블 대전 &amp; 관망</span>
            </button>
          </div>

          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: '14px', width: '100%' }}
            onClick={() => setAppMode('HALL_OF_FAME')}
          >
            🏅 명예의 전당 보기
          </button>
        </div>
      </div>
    );
  }

  // =========================================================================
  // 2. 명예의 전당 (HALL_OF_FAME)
  // =========================================================================
  if (appMode === 'HALL_OF_FAME') {
    const soloRecords = getHallOfFameRecords('SOLO');
    const netRecords = getHallOfFameRecords('NET');

    return (
      <div className="qxo-container" style={{ background: WOOD_BG_THEMES[0], padding: '16px' }}>
        <div className="setup-card" style={{ maxWidth: '600px', margin: '0 auto' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '12px',
            }}
          >
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, color: '#3e2723' }}>🏅 명예의 전당</h2>
            <div style={{ width: '60px' }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div className="hof-box">
              <h3 className="hof-title solo">🎮 단독 대국 TOP 10</h3>
              {soloRecords.length === 0 ? (
                <p className="hof-empty">기록이 없습니다.</p>
              ) : (
                <div className="hof-list">
                  {soloRecords.map((rec, i) => (
                    <div key={rec.id} className="hof-item">
                      <span>
                        <strong>
                          {i + 1}. {rec.name}
                        </strong>
                      </span>
                      <span style={{ color: '#2e7d32', fontWeight: 800 }}>{rec.scoreOrLevel}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="hof-box">
              <h3 className="hof-title net">🌐 넷대국 TOP 10</h3>
              {netRecords.length === 0 ? (
                <p className="hof-empty">기록이 없습니다.</p>
              ) : (
                <div className="hof-list">
                  {netRecords.map((rec, i) => (
                    <div key={rec.id} className="hof-item">
                      <span>
                        <strong>
                          {i + 1}. {rec.name}
                        </strong>
                      </span>
                      <span style={{ color: '#b45309', fontWeight: 800 }}>{rec.scoreOrLevel}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // 3. 넷게임 4개 방 로비 (NET_LOBBY)
  // =========================================================================
  if (appMode === 'NET_LOBBY') {
    return (
      <div className="qxo-container" style={{ background: WOOD_BG_THEMES[0] }}>
        <div className="net-lobby-container">
          <div className="net-lobby-header">
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, fontSize: '20px', color: '#3e2723' }}>
              🌐 우드 퀵소(QUIXO) 넷게임 (4개 대국실)
            </h2>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: '12px' }}
              onClick={() => setAppMode('HALL_OF_FAME')}
            >
              🏅 명예의전당
            </button>
          </div>

          <div className="net-rooms-grid">
            {rooms.map((room) => {
              const roomPlayers = room.players || [];
              const roomWaitlist = room.waitlist || [];
              const roomSpectators = room.spectators || [];
              const isEmpty = room.status === 'EMPTY' || roomPlayers.length === 0;
              const isWaiting = room.status === 'WAITING' && roomPlayers.length > 0;
              const isPlaying =
                room.status === 'PLAYING' ||
                room.status === 'ROUND_OVER' ||
                room.status === 'MATCH_OVER';
              const isFull = roomPlayers.length >= 2;

              let statusBadgeText = '🟢 빈 대국실';
              let statusClass = 'empty';
              if (isPlaying) {
                statusBadgeText = `🔥 제 ${room.roundNumber}국 진행중`;
                statusClass = 'playing';
              } else if (isWaiting) {
                statusBadgeText = isFull
                  ? `🟠 대기중 (만석 2/2)`
                  : `🟡 대기중 (${roomPlayers.length}/2명)`;
                statusClass = 'waiting';
              }

              return (
                <div
                  key={room.roomId}
                  className={`net-room-card ${statusClass}`}
                  onClick={() => {
                    if (
                      roomPlayers.some((p) => p.id === mySessionId) ||
                      roomWaitlist.some((w) => w.id === mySessionId) ||
                      roomSpectators.some((s) => s.id === mySessionId)
                    ) {
                      setSelectedRoomId(room.roomId);
                      setAppMode('NET_ROOM');
                    } else {
                      setJoinModalRoom(room);
                      setJoinPlayerName('');
                    }
                  }}
                >
                  <div className="room-card-top">
                    <span className="room-number-title">🪵 제 {room.roomId} 퀵소실</span>
                    <span className={`room-status-pill ${statusClass}`}>{statusBadgeText}</span>
                  </div>

                  <div className="room-rules-info">
                    <span>💰 동일 판돈: {room.anteBet.toLocaleString()}칩</span>
                    <span>⏱️ 착수 제한: {room.baseTimeout}초</span>
                  </div>

                  <div className="room-members-box">
                    <div className="room-members-label">대국자 ({roomPlayers.length}/2):</div>
                    <div className="room-members-chips">
                      {roomPlayers.length === 0 ? (
                        <span className="empty-member-text">첫 번째 대국자를 기다리고 있습니다</span>
                      ) : (
                        roomPlayers.map((p) => (
                          <span key={p.id} className="member-chip">
                            <span className="mini-cube-badge">{p.symbol === 1 ? 'X' : 'O'}</span>
                            {p.name} ({p.wins || 0}승 ·{' '}
                            {(p.chips ?? INITIAL_CHIPS).toLocaleString()}칩)
                          </span>
                        ))
                      )}
                    </div>
                  </div>

                  {roomSpectators.length > 0 && (
                    <div
                      className="room-waitlist-box"
                      style={{ color: '#0369a1', background: '#f0f9ff' }}
                    >
                      👀 관전 중 ({roomSpectators.length}명):{' '}
                      {roomSpectators.map((s) => s.name).join(', ')}
                    </div>
                  )}

                  {roomWaitlist.length > 0 && (
                    <div className="room-waitlist-box">
                      ⏳ 다음 판 예약 ({roomWaitlist.length}명):{' '}
                      {roomWaitlist.map((w) => w.name).join(', ')}
                    </div>
                  )}

                  <div className="room-enter-cta">
                    {isEmpty
                      ? '👉 클릭하여 대국실 열기 또는 관전하기'
                      : isPlaying || isFull
                      ? '👉 클릭하여 다음 판 예약 또는 관전하기'
                      : '👉 클릭하여 대국 참가 또는 관전하기'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {joinModalRoom && (
          <div className="modal-overlay" onClick={() => setJoinModalRoom(null)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h2 style={{ margin: '0 0 8px' }}>🪵 제 {joinModalRoom.roomId} 퀵소실 입장</h2>
              <p className="modal-subtext">
                동일 판돈 <strong>{joinModalRoom.anteBet.toLocaleString()}칩</strong>을 걸고 1:1
                대국이 진행됩니다.
              </p>

              <input
                type="text"
                className="player-input"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: '14px' }}
                placeholder="대국자 이름 입력 (예: 엑스마스터)"
                value={joinPlayerName}
                autoFocus
                onChange={(e) => setJoinPlayerName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleEnterRoomSubmit(false)}
              />

              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ flex: 1, background: '#0284c7', color: '#fff' }}
                  onClick={() => handleEnterRoomSubmit(true)}
                >
                  👀 관전하기
                </button>
                <button
                  type="button"
                  className="btn btn-success"
                  style={{ flex: 2 }}
                  onClick={() => handleEnterRoomSubmit(false)}
                >
                  🚀 대국 참가 / 예약
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // =========================================================================
  // 4. 넷게임 방 내부 (NET_ROOM)
  // =========================================================================
  if (appMode === 'NET_ROOM') {
    if (!activeNetRoom) {
      return (
        <div
          className="qxo-container"
          style={{
            background: WOOD_BG_THEMES[0],
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div className="setup-card" style={{ textAlign: 'center' }}>
            <h2>⏳ 대국실 정보를 불러오는 중입니다...</h2>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: '12px' }}
              onClick={() => setAppMode('NET_LOBBY')}
            >
              ⬅️ 로비로 돌아가기
            </button>
          </div>
        </div>
      );
    }

    const roomPlayers = activeNetRoom.players || [];
    const roomWaitlist = activeNetRoom.waitlist || [];
    const roomSpectators = activeNetRoom.spectators || [];
    const isHost = roomPlayers[0]?.id === mySessionId;
    const amIWaitlisted = roomWaitlist.some((w) => w.id === mySessionId);
    const amISpectator = roomSpectators.some((s) => s.id === mySessionId);

    if (activeNetRoom.status === 'WAITING' || activeNetRoom.status === 'EMPTY') {
      const minutes = Math.floor(waitingCountdownSec / 60);
      const seconds = waitingCountdownSec % 60;
      const countdownStr = `${minutes}분 ${seconds < 10 ? '0' : ''}${seconds}초`;

      return (
        <div className="qxo-container" style={{ background: WOOD_BG_THEMES[0] }}>
          <div className="setup-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '6px 12px', fontSize: '13px' }}
                onClick={handleLeaveNetRoom}
              >
                🚪 방 나가기
              </button>
              <span className="room-status-pill waiting">
                제 {activeNetRoom.roomId}실 · 대기 중 (⏱️ {countdownStr})
              </span>
            </div>

            <h1 className="setup-title" style={{ marginTop: '14px' }}>
              🪵 우드 퀵소(QUIXO) 대기실 {amISpectator ? '👀 [관전모드]' : ''}
            </h1>

            <div className="setting-section">
              <label className="setting-label">
                💰 동일 판돈 설정 (초기 10,000칩 · 전원 동일 베팅){' '}
                {isHost ? '(방장 설정 가능)' : '(방장 설정 중)'}
              </label>
              <div className="piece-count-selector">
                {[1000, 2000, 3000, 5000].map((val) => (
                  <button
                    key={val}
                    type="button"
                    disabled={!isHost}
                    className={`count-btn ${activeNetRoom.anteBet === val ? 'active' : ''}`}
                    onClick={() => updateRoomSettings(val, activeNetRoom.baseTimeout)}
                  >
                    {val.toLocaleString()}칩
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-section">
              <label className="setting-label">
                ⏱️ 착수 제한시간: <strong>{activeNetRoom.baseTimeout}초</strong>{' '}
                {isHost ? '(방장 설정 가능)' : ''}
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700 }}>20초</span>
                <input
                  type="range"
                  min={20}
                  max={180}
                  step={10}
                  disabled={!isHost}
                  value={activeNetRoom.baseTimeout}
                  style={{ flex: 1 }}
                  onChange={(e) =>
                    updateRoomSettings(activeNetRoom.anteBet, Number(e.target.value))
                  }
                />
                <span style={{ fontSize: '12px', fontWeight: 700 }}>180초</span>
              </div>
            </div>

            <div className="setting-section">
              <label className="setting-label">🧭 입장한 대국자 (2명 입장 시 시작 가능)</label>
              <div className="player-list">
                {roomPlayers.map((p, idx) => (
                  <div key={p.id} className="player-item-a">
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="mini-cube-badge large">{p.symbol === 1 ? 'X' : 'O'}</span>
                      {p.name} ({p.symbol === 1 ? '✖️ [X] 선공' : '⭕ [O] 후공'}){' '}
                      {idx === 0 && '👑(방장)'} {p.id === mySessionId && '(나)'}
                    </span>
                    <span style={{ fontSize: '12px', color: '#2e7d32' }}>
                      🏆{p.wins || 0}승 · {(p.chips ?? INITIAL_CHIPS).toLocaleString()}칩
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <button
              type="button"
              className="btn btn-success"
              disabled={roomPlayers.length < 2}
              onClick={() => handleStartNetRound(false)}
            >
              🚀 대국 시작! (전원 {activeNetRoom.anteBet.toLocaleString()}칩 동일 베팅)
            </button>
          </div>
        </div>
      );
    }

    const { xCount, oCount } = countCubeFaces(activeNetRoom.board);
    const activeTurnPlayer = roomPlayers.find((p) => p.symbol === activeNetRoom.currentTurn);
    const isMyTurn =
      activeNetRoom.status === 'PLAYING' &&
      activeTurnPlayer?.id === mySessionId &&
      !amISpectator;
    const isRoundEnded =
      activeNetRoom.status === 'ROUND_OVER' || activeNetRoom.status === 'MATCH_OVER';
    const netWinCheck = isRoundEnded
      ? checkQuixoWinner(activeNetRoom.board, activeNetRoom.currentTurn)
      : { winningLine: [] };

    return (
      <div className="qxo-container" style={{ background: WOOD_BG_THEMES[0] }}>
        {renderFireworksAndChips()}

        {toast && (
          <div key={toast.id} className={`qxo-toast ${toast.type}`}>
            {toast.text}
          </div>
        )}

        <div className="play-wrapper compact-tablet-mode">
          {/* 상단 헤더 */}
          <div className="game-header compact-header">
            <div className="net-level-timer-box">
              <span className="net-level-badge">
                제 {activeNetRoom.roundNumber}국 {amISpectator ? '👀[관전]' : ''}
              </span>
              {!isRoundEnded && (
                <span className={`net-timer-badge ${remainingSeconds <= 10 ? 'urgent' : ''}`}>
                  ⏱️ {remainingSeconds}초
                </span>
              )}
            </div>

            <div className="player-status-bar">
              {roomPlayers.map((p) => {
                const isActive =
                  activeNetRoom.status === 'PLAYING' && p.symbol === activeNetRoom.currentTurn;
                const cubeCount = p.symbol === 1 ? xCount : oCount;
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${isActive ? 'active-turn-spotlight' : ''}`}
                  >
                    <div className="player-badge-top">
                      <span className="mini-cube-badge">{p.symbol === 1 ? 'X' : 'O'}</span>
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '>'}
                        {p.name}
                        {p.id === mySessionId ? '(나)' : ''}
                      </strong>
                      <span className="disc-score-pill">{cubeCount}개</span>
                      <span className="win-count-pill">🏆{p.wins || 0}승</span>
                      <span className="badge-score">💰{(p.chips ?? 0).toLocaleString()}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: '4px' }}>
              <button
                type="button"
                className="btn btn-secondary btn-compact-setup"
                onClick={() => setShowValidHints((v) => !v)}
                title="선택 가능 큐브 힌트 켜기/끄기"
              >
                {showValidHints ? '💡' : '🕶️'}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-compact-setup"
                onClick={handleLeaveNetRoom}
                title="방 나가기"
              >
                🚪
              </button>
            </div>
          </div>

          {(amIWaitlisted || roomWaitlist.length > 0) && !amISpectator && (
            <div className="net-waitlist-strip">
              {amIWaitlisted
                ? '⏳ 현재 다음 판 예약 대기 중입니다!'
                : `⏳ 다음 판 예약자 (${roomWaitlist.length}명): ${roomWaitlist
                    .map((w) => w.name)
                    .join(', ')}`}
            </div>
          )}

          {/* 중앙 원목 테이블 영역 */}
          <div className="qxo-table-board">
            {isRoundEnded ? (
              <div className="winner-celebration-top-bar">
                <div className="winner-celebrate-title">{activeNetRoom.winnerAnnouncement}</div>
                <div className="winner-celebrate-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ padding: '6px 14px', fontSize: '13px' }}
                    onClick={handleLeaveNetRoom}
                  >
                    🚪 방 나가기
                  </button>
                  <button
                    type="button"
                    className="btn btn-success"
                    style={{ width: 'auto', padding: '6px 18px', fontSize: '14px' }}
                    onClick={() => handleStartNetRound(activeNetRoom.status === 'ROUND_OVER')}
                  >
                    {activeNetRoom.status === 'MATCH_OVER'
                      ? '🔄 새 매치 시작 (10,000칩 초기화)'
                      : `🔥 다음 대국 시작 (X/O 교대 · ${activeNetRoom.anteBet.toLocaleString()}칩)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={activeNetRoom.turnNotice} className="qxo-notice-banner">
                {activeNetRoom.turnNotice}
              </div>
            )}

            {/* 판돈 및 실시간 X / O 큐브 개수 카운터 */}
            <div className="qxo-scoreboard-strip">
              <div className="score-side">
                <span className="mini-cube-badge large">X</span>
                <span>X 큐브</span>
                <strong>{xCount}</strong>
              </div>

              <div className="center-pot-box">
                <span className="pot-label">💰 누적 POT</span>
                <strong className="pot-amount">
                  {(activeNetRoom.pot || 0).toLocaleString()} 칩
                </strong>
              </div>

              <div className="score-side">
                <strong>{oCount}</strong>
                <span>O 큐브</span>
                <span className="mini-cube-badge large">O</span>
              </div>
            </div>

            {/* 사진 디자인: 원형 마호가니 받침판 위 5x5 원목 큐브 보드 */}
            <div className="board-center-stage">
              {renderQuixoWoodenBoard(
                activeNetRoom.board,
                activeNetRoom.currentTurn,
                isMyTurn,
                activeNetRoom.selectedIdx,
                activeNetRoom.lastInsertedIdx,
                activeNetRoom.shiftedIndices,
                netWinCheck.winningLine,
                handleNetCubeClick,
                handleNetPushDirection
              )}
            </div>
          </div>

          {/* 하단 상태 도크 */}
          <div className="qxo-bottom-dock">
            <div className="dock-top-status">
              {amISpectator ? (
                <span className="waiting-dock-msg">👀 관전 모드로 대국을 지켜보고 있습니다.</span>
              ) : isRoundEnded ? (
                <span className="waiting-dock-msg">
                  🏆 대국 종료! 상단의 <strong>[다음 대국 시작]</strong> 버튼으로 승수와 판돈을
                  이어가세요!
                </span>
              ) : (
                <span className="turn-owner-pill large-turn-pill">
                  {activeNetRoom.currentTurn === 1 ? '✖️ [X]' : '⭕ [O]'}{' '}
                  {activeTurnPlayer?.name}님 차례
                  {isMyTurn
                    ? activeNetRoom.selectedIdx !== null
                      ? ' · 화살표를 눌러 큐브를 밀어 넣으세요! (다시 누르면 선택 취소)'
                      : ' · 테두리의 빈 큐브 또는 내 큐브를 선택하세요!'
                    : ' · 상대방 수 고민 중...'}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // 5. 단독게임(SOLO) - 2인 로컬 우드 퀵소 연승 매치
  // =========================================================================
  const { xCount: soloX, oCount: soloO } = countCubeFaces(soloBoard);
  const currentSoloPlayer =
    soloPlayers.find((p) => p.symbol === soloTurn) || soloPlayers[0];
  const isSoloEnded = gameState === 'ROUND_OVER' || gameState === 'MATCH_OVER';

  return (
    <div className="qxo-container" style={{ background: WOOD_BG_THEMES[0] }}>
      {renderFireworksAndChips()}

      {toast && (
        <div key={toast.id} className={`qxo-toast ${toast.type}`}>
          {toast.text}
        </div>
      )}

      {gameState === 'SETUP' && (
        <div className="setup-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: '6px 12px', fontSize: '12px' }}
              onClick={() => setAppMode('HOME')}
            >
              ⬅️ 홈으로
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: '6px 12px', fontSize: '12px' }}
              onClick={() => setAppMode('HALL_OF_FAME')}
            >
              🏅 명예의 전당
            </button>
          </div>
          <h1 className="setup-title">🪵 우드 퀵소 QUIXO (단독게임 설정)</h1>

          <div className="setting-section">
            <label className="setting-label">
              💰 매 대국 동일 판돈 설정 (초기 지급 10,000칩)
            </label>
            <div className="piece-count-selector">
              {[1000, 2000, 3000, 5000].map((val) => (
                <button
                  key={val}
                  type="button"
                  className={`count-btn ${soloAnteBet === val ? 'active' : ''}`}
                  onClick={() => setSoloAnteBet(val)}
                >
                  {val.toLocaleString()}칩
                </button>
              ))}
            </div>
          </div>

          <div className="setting-section">
            <label className="setting-label">
              ⏱️ 턴 제한시간 설정: <strong>{soloTimeoutSec}초</strong>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '12px', fontWeight: 700 }}>20초</span>
              <input
                type="range"
                min={20}
                max={180}
                step={10}
                value={soloTimeoutSec}
                style={{ flex: 1 }}
                onChange={(e) => setSoloTimeoutSec(Number(e.target.value))}
              />
              <span style={{ fontSize: '12px', fontWeight: 700 }}>180초</span>
            </div>
          </div>

          <div className="setting-section">
            <label className="setting-label">🧭 대국자 이름 설정 (2인 대전)</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="player-item-a">
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="mini-cube-badge large">X</span>
                  <span>선공 [X]</span>
                </span>
                <input
                  type="text"
                  className="player-input"
                  style={{ maxWidth: '220px', padding: '6px 10px' }}
                  value={soloName1}
                  onChange={(e) => setSoloName1(e.target.value)}
                  placeholder="1번 플레이어 이름"
                />
              </div>

              <div className="player-item-a">
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="mini-cube-badge large">O</span>
                  <span>후공 [O]</span>
                </span>
                <input
                  type="text"
                  className="player-input"
                  style={{ maxWidth: '220px', padding: '6px 10px' }}
                  value={soloName2}
                  onChange={(e) => setSoloName2(e.target.value)}
                  placeholder="2번 플레이어 이름"
                />
              </div>
            </div>
          </div>

          <button type="button" className="btn btn-success" onClick={goToSoloReady}>
            ➡️ X / O 선공 확인하러 가기
          </button>
        </div>
      )}

      {gameState === 'READY' && (
        <div className="order-panel">
          <div className="order-header">
            <h2 style={{ margin: 0, fontSize: '20px', color: '#3e2723' }}>
              📋 X / O 문양 배정을 확인하세요
            </h2>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: '8px 14px', fontSize: '13px' }}
              onClick={swapSoloOrder}
            >
              🔄 X / O 맞바꾸기
            </button>
          </div>

          <div className="order-list">
            {soloPlayers.map((player) => (
              <div key={player.id} className="order-item">
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span className="mini-cube-badge large">{player.symbol === 1 ? 'X' : 'O'}</span>
                  <strong>{player.symbol === 1 ? '선공 (✖️ X)' : '후공 (⭕ O)'}</strong>
                  <span>{player.name}</span>
                </span>
                <span style={{ fontSize: '13px', color: '#5d4037', fontWeight: 800 }}>
                  초기 {player.chips.toLocaleString()}칩
                </span>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setGameState('SETUP')}
            >
              ⬅️ 설정으로
            </button>
            <button type="button" className="btn btn-success" onClick={() => startSoloRound(false)}>
              🚀 대국 시작! (전원 {soloAnteBet.toLocaleString()}칩 동일 베팅)
            </button>
          </div>
        </div>
      )}

      {(gameState === 'PLAYING' || gameState === 'ROUND_OVER' || gameState === 'MATCH_OVER') && (
        <div className="play-wrapper compact-tablet-mode">
          {/* 상단 헤더 */}
          <div className="game-header compact-header">
            <div className="net-level-timer-box">
              <span className="net-level-badge">제 {soloRoundNum}국</span>
              {!isSoloEnded && (
                <span className={`net-timer-badge ${soloRemainingSec <= 10 ? 'urgent' : ''}`}>
                  ⏱️ {soloRemainingSec}초
                </span>
              )}
            </div>

            <div className="player-status-bar">
              {soloPlayers.map((p) => {
                const isActive = !isSoloEnded && p.symbol === soloTurn;
                const cubeCount = p.symbol === 1 ? soloX : soloO;
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${
                      isActive ? 'active-turn-spotlight' : 'active-turn-unlight'
                    }`}
                  >
                    <div className="player-badge-top">
                      <span className="mini-cube-badge">{p.symbol === 1 ? 'X' : 'O'}</span>
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '>'}
                        {p.name}
                      </strong>
                      <span className="disc-score-pill">{cubeCount}개</span>
                      <span className="win-count-pill">🏆{p.wins}승</span>
                      <span className="badge-score">💰{p.chips.toLocaleString()}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: '4px' }}>
              <button
                type="button"
                className="btn btn-secondary btn-compact-setup"
                onClick={() => setShowValidHints((v) => !v)}
                title="선택 가능 큐브 힌트 켜기/끄기"
              >
                {showValidHints ? '💡' : '🕶️'}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-compact-setup"
                onClick={() => setGameState('SETUP')}
                title="설정/나가기"
              >
                🚪
              </button>
            </div>
          </div>

          {/* 중앙 원목 테이블 보드 */}
          <div className="qxo-table-board">
            {isSoloEnded ? (
              <div className="winner-celebration-top-bar">
                <div className="winner-celebrate-title">{winnerAnnouncement}</div>
                <div className="winner-celebrate-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ padding: '6px 14px', fontSize: '13px' }}
                    onClick={() => setGameState('SETUP')}
                  >
                    ⚙️ 설정 변경
                  </button>
                  <button
                    type="button"
                    className="btn btn-success"
                    style={{ width: 'auto', padding: '6px 18px', fontSize: '14px' }}
                    onClick={() => startSoloRound(gameState === 'ROUND_OVER')}
                  >
                    {gameState === 'MATCH_OVER'
                      ? '🔄 새 매치 시작 (10,000칩 초기화)'
                      : `🔥 다음 대국 시작 (X/O 교대 · ${soloAnteBet.toLocaleString()}칩)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={turnNotice} className="qxo-notice-banner">
                {turnNotice}
              </div>
            )}

            {/* 판돈 및 실시간 X / O 큐브 카운터 */}
            <div className="qxo-scoreboard-strip">
              <div className="score-side">
                <span className="mini-cube-badge large">X</span>
                <span>X 큐브</span>
                <strong>{soloX}</strong>
              </div>

              <div className="center-pot-box">
                <span className="pot-label">💰 누적 POT</span>
                <strong className="pot-amount">{soloPot.toLocaleString()} 칩</strong>
              </div>

              <div className="score-side">
                <strong>{soloO}</strong>
                <span>O 큐브</span>
                <span className="mini-cube-badge large">O</span>
              </div>
            </div>

            {/* 사진 디자인: 원형 마호가니 트레이 위 5x5 원목 큐브 보드 */}
            <div className="board-center-stage">
              {renderQuixoWoodenBoard(
                soloBoard,
                soloTurn,
                gameState === 'PLAYING',
                soloSelectedIdx,
                soloLastInsertedIdx,
                soloShiftedIndices,
                soloWinningLine,
                handleSoloCubeClick,
                (dir) => {
                  if (soloSelectedIdx !== null) {
                    executeSoloPushMove(soloSelectedIdx, dir, false);
                  }
                }
              )}
            </div>
          </div>

          {/* 하단 상태 도크 */}
          <div className="qxo-bottom-dock">
            <div className="dock-top-status">
              {isSoloEnded ? (
                <span className="waiting-dock-msg">
                  🎉 대국 종료! <strong>[다음 대국 시작]</strong>을 눌러 X/O를 교대해 계속
                  대국하세요!
                </span>
              ) : (
                <span className="turn-owner-pill large-turn-pill">
                  {soloTurn === 1 ? '✖️ [X]' : '⭕ [O]'} {currentSoloPlayer.name}님 차례 ·{' '}
                  {soloSelectedIdx !== null
                    ? '화살표를 눌러 밀어 넣으세요!'
                    : '외곽 큐브를 선택하세요!'}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}