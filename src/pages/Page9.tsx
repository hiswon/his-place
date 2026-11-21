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
import './Page9.css';

// 0: 빈 칸, 1: 흑돌(선공), 2: 백돌(후공)
type DiscColor = 0 | 1 | 2;

interface OthelloPlayer {
  id: string;
  name: string;
  discColor: 1 | 2;
  chips: number; // 보유 머니(칩)
  wins: number; // 누적 승수
  currentBet: number; // 이번 판 판돈
  isEliminated: boolean; // 파산 아웃 여부
}

interface WaitlistPlayer {
  id: string;
  name: string;
}

interface SpectatorPlayer {
  id: string;
  name: string;
}

interface NetOthelloRoomData {
  roomId: number;
  status: 'EMPTY' | 'WAITING' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER';
  players: OthelloPlayer[];
  pot: number;
  waitlist: WaitlistPlayer[];
  spectators: SpectatorPlayer[];
  baseTimeout: number;
  anteBet: number;
  roundNumber: number;
  board: DiscColor[]; // 64칸 1차원 배열 (Firebase 배열 안정성 보장)
  currentTurn: 1 | 2; // 1: 흑돌 차례, 2: 백돌 차례
  lastMoveIdx: number | null;
  flippedIndices: number[];
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

const DIRECTIONS: readonly [number, number][] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];


/**
 * 오델로 초기 8x8 (64칸) 보드 생성
 */
function createInitialOthelloBoard(): DiscColor[] {
  const board: DiscColor[] = Array(64).fill(0);
  // 중앙 4칸: (3,3)=백(2), (3,4)=흑(1), (4,3)=흑(1), (4,4)=백(2)
  board[3 * 8 + 3] = 2;
  board[3 * 8 + 4] = 1;
  board[4 * 8 + 3] = 1;
  board[4 * 8 + 4] = 2;
  return board;
}

/**
 * 특정 위치(idx)에 color(1 또는 2)를 놓았을 때 뒤집히는 상대 돌들의 인덱스 배열 반환
 */
function getFlippableIndices(board: DiscColor[], idx: number, color: 1 | 2): number[] {
  if (idx < 0 || idx >= 64 || board[idx] !== 0) return [];

  const opponent: 1 | 2 = color === 1 ? 2 : 1;
  const row = Math.floor(idx / 8);
  const col = idx % 8;
  const allFlips: number[] = [];

  for (const [dr, dc] of DIRECTIONS) {
    let r = row + dr;
    let c = col + dc;
    const lineFlips: number[] = [];

    while (r >= 0 && r < 8 && c >= 0 && c < 8) {
      const targetIdx = r * 8 + c;
      const cell = board[targetIdx];
      if (cell === opponent) {
        lineFlips.push(targetIdx);
      } else if (cell === color) {
        if (lineFlips.length > 0) {
          allFlips.push(...lineFlips);
        }
        break;
      } else {
        break;
      }
      r += dr;
      c += dc;
    }
  }

  return allFlips;
}

/**
 * 현재 차례(color)가 착수 가능한 모든 유효 칸 인덱스 목록 반환
 */
function getValidMoves(board: DiscColor[], color: 1 | 2): number[] {
  const moves: number[] = [];
  for (let i = 0; i < 64; i++) {
    if (board[i] === 0 && getFlippableIndices(board, i, color).length > 0) {
      moves.push(i);
    }
  }
  return moves;
}

/**
 * 흑돌 / 백돌 개수 집계
 */
function countDiscs(board: DiscColor[]): { black: number; white: number; empty: number } {
  let black = 0;
  let white = 0;
  let empty = 0;
  for (const cell of board) {
    if (cell === 1) black++;
    else if (cell === 2) white++;
    else empty++;
  }
  return { black, white, empty };
}

/**
 * 좌표 표기 (예: D3)
 */
function formatCoord(idx: number): string {
  const colChar = String.fromCharCode(65 + (idx % 8));
  const rowNum = Math.floor(idx / 8) + 1;
  return `${colChar}${rowNum}`;
}

function createDefaultOthelloRoom(roomId: number): NetOthelloRoomData {
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
    board: createInitialOthelloBoard(),
    currentTurn: 1,
    lastMoveIdx: null,
    flippedIndices: [],
    turnDeadline: null,
    turnNotice: '',
    winnerAnnouncement: '',
    roundWinnerId: null,
    waitingSince: null,
  };
}

export default function Page9() {
  const [appMode, setAppMode] = useState<
    'HOME' | 'SOLO' | 'NET_LOBBY' | 'NET_ROOM' | 'HALL_OF_FAME'
  >('HOME');

  const [mySessionId] = useState<string>(() => {
    const saved = sessionStorage.getItem('othello_net_uid');
    if (saved) return saved;
    const generated = `oth_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('othello_net_uid', generated);
    return generated;
  });

  // 넷게임 상태
  const [rooms, setRooms] = useState<NetOthelloRoomData[]>(
    [1, 2, 3, 4].map(createDefaultOthelloRoom)
  );
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [joinModalRoom, setJoinModalRoom] = useState<NetOthelloRoomData | null>(null);
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
  const [soloPlayers, setSoloPlayers] = useState<OthelloPlayer[]>([
    {
      id: '1',
      name: '흑기사',
      discColor: 1,
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
    },
    {
      id: '2',
      name: '백작',
      discColor: 2,
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
    },
  ]);

  const [soloName1, setSoloName1] = useState('흑기사');
  const [soloName2, setSoloName2] = useState('백작');
  const [soloAnteBet, setSoloAnteBet] = useState<number>(1000);
  const [soloTimeoutSec, setSoloTimeoutSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRemainingSec, setSoloRemainingSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRoundNum, setSoloRoundNum] = useState<number>(1);
  const [soloPot, setSoloPot] = useState<number>(0);

  const [soloBoard, setSoloBoard] = useState<DiscColor[]>(createInitialOthelloBoard());
  const [soloTurn, setSoloTurn] = useState<1 | 2>(1);
  const [soloLastMoveIdx, setSoloLastMoveIdx] = useState<number | null>(null);
  const [soloFlippedIndices, setSoloFlippedIndices] = useState<number[]>([]);
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
   * 원목 보드판 위 나무 돌 착수음 & 뒤집기 사운드
   */
  const playSound = (kind: 'place' | 'flip' | 'chip' | 'win' | 'tick') => {
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
        place: [220, 146.83], // 묵직한 나무 착수음
        flip: [330, 440, 554.37], // 경쾌한 돌 뒤집기
        chip: [880, 1174.66],
        win: [523.25, 659.25, 783.99, 1046.5, 1318.5],
        tick: [987.77],
      };

      notesMap[kind].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === 'place' ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.055);
        gain.gain.setValueAtTime(kind === 'place' ? 0.24 : 0.14, ctx.currentTime + idx * 0.055);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.055 + 0.18);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.055);
        osc.stop(ctx.currentTime + idx * 0.055 + 0.18);
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
    const key = type === 'SOLO' ? 'othello_hof_solo' : 'othello_hof_net';
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
    const key = type === 'SOLO' ? 'othello_hof_solo' : 'othello_hof_net';
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      return [];
    }
  };

  // =========================================================================
  // 방 나가기 공통 처리 함수 (버튼 클릭 및 인터넷 창 닫기 시 공용)
  // =========================================================================
  const leaveRoomById = useCallback(
    async (roomIdToLeave: number) => {
      const roomRef = ref(db, `othello_rooms/room_${roomIdToLeave}`);
      try {
        await runTransaction(roomRef, (roomData) => {
          if (!roomData) return roomData;
          const room = roomData as NetOthelloRoomData;
          const filteredPlayers = (room.players || []).filter((p) => p.id !== mySessionId);
          const filteredWaitlist = (room.waitlist || []).filter((w) => w.id !== mySessionId);
          const filteredSpectators = (room.spectators || []).filter((s) => s.id !== mySessionId);

          if (filteredPlayers.length === 0 && filteredSpectators.length === 0) {
            return createDefaultOthelloRoom(room.roomId);
          }

          room.players = filteredPlayers.map((p, idx) => ({
            ...p,
            discColor: idx === 0 ? 1 : 2,
          }));
          room.waitlist = filteredWaitlist;
          room.spectators = filteredSpectators;

          if (filteredPlayers.length < 2 && room.status === 'PLAYING') {
            room.status = 'WAITING';
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

  // =========================================================================
  // 인터넷 창/탭 닫기 시 해당 방에서 즉시 나가기 처리
  // =========================================================================
  useEffect(() => {
    if (appMode !== 'NET_ROOM' || !selectedRoomId) return;

    const presenceRef = ref(db, `othello_presence/room_${selectedRoomId}/${mySessionId}`);
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
        const roomRef = ref(db, `othello_rooms/room_${id}`);
        const snap = await get(roomRef);
        if (!snap.exists()) {
          await set(roomRef, createDefaultOthelloRoom(id));
        }
      }
    };
    ensureRoomsExist();

    const roomsRef = ref(db, 'othello_rooms');
    const unsubscribe = onValue(roomsRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      const loadedRooms: NetOthelloRoomData[] = [1, 2, 3, 4].map((id) => {
        const rData = data[`room_${id}`];
        const def = createDefaultOthelloRoom(id);
        if (!rData) return def;

        const normalizedBoard: DiscColor[] = Array.from({ length: 64 }, (_, i) => {
          const val = rData.board?.[i];
          return val === 1 || val === 2 ? val : 0;
        });

        return {
          ...def,
          ...rData,
          players: (rData.players || []).map((p: OthelloPlayer, idx: number) => ({
            ...p,
            discColor: p.discColor === 2 ? 2 : idx === 0 ? 1 : 2,
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
          lastMoveIdx: typeof rData.lastMoveIdx === 'number' ? rData.lastMoveIdx : null,
          flippedIndices: Array.isArray(rData.flippedIndices) ? rData.flippedIndices : [],
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
          const roomRef = ref(db, `othello_rooms/room_${activeNetRoom.roomId}`);
          await set(roomRef, createDefaultOthelloRoom(activeNetRoom.roomId));
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
          const validMoves = getValidMoves(soloBoard, soloTurn);
          if (validMoves.length > 0) {
            const randomIdx = validMoves[Math.floor(Math.random() * validMoves.length)];
            handleSoloCellClick(randomIdx, true);
          }
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [appMode, gameState, soloBoard, soloTurn, soloTimeoutSec]);

  const handleEnterRoomSubmit = async (asSpectator = false) => {
    if (!joinModalRoom) return;
    const trimmedName = joinPlayerName ? joinPlayerName.trim() : '';
    if (!trimmedName) {
      alert('참가할 이름을 입력해주세요!');
      return;
    }

    const roomRef = ref(db, `othello_rooms/room_${joinModalRoom.roomId}`);

    try {
      let joinResultType = 'PLAYER';

      await runTransaction(roomRef, (roomData) => {
        const room: NetOthelloRoomData = roomData || createDefaultOthelloRoom(joinModalRoom.roomId);
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
          const discColor: 1 | 2 = room.players.length === 0 ? 1 : 2;
          const newPlayer: OthelloPlayer = {
            id: mySessionId,
            name: trimmedName,
            discColor,
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
        showToast('👀 관망모드로 입장했습니다!', 'info');
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
    const roomRef = ref(db, `othello_rooms/room_${activeNetRoom.roomId}`);
    await update(roomRef, {
      anteBet: newAnteBet,
      baseTimeout: clampedTimeout,
      waitingSince: Date.now(),
    });
  };

  /**
   * 넷게임 라운드 시작 (흑/백 교대 배정 및 동일 판돈 베팅)
   */
  const handleStartNetRound = async (isNextRound = false) => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `othello_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetOthelloRoomData;
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
      const nextActive: OthelloPlayer[] = [...survivingPlayers];
      const remainingWaitlist: WaitlistPlayer[] = [];

      for (const w of waitlist) {
        if (nextActive.length < 2) {
          nextActive.push({
            id: w.id,
            name: w.name,
            discColor: 2,
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

      // 다음 라운드에서는 흑/백 선공 교대
      const orderedActive =
        isNextRound && !isNewMatch ? [nextActive[1], nextActive[0]] : nextActive;

      const equalStake = Math.min(ante, ...orderedActive.map((p) => p.chips));
      let collectedPot = isNewMatch ? 0 : room.pot || 0;

      const preparedPlayers: OthelloPlayer[] = orderedActive.map((p, idx) => {
        collectedPot += equalStake;
        return {
          ...p,
          discColor: idx === 0 ? 1 : 2,
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
      room.board = createInitialOthelloBoard();
      room.currentTurn = 1; // 흑돌 선공
      room.lastMoveIdx = null;
      room.flippedIndices = [];
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.winnerAnnouncement = '';
      room.roundWinnerId = null;
      room.turnNotice = `🪵 [${nextRound}국] 동일 판돈 ${equalStake.toLocaleString()}칩 베팅! ⚫흑돌 ${preparedPlayers[0].name}님 선공입니다.`;
      room.waitingSince = null;

      return room;
    });

    triggerChipAnimation('전원', activeNetRoom.anteBet, '#8d6e63');
  };

  /**
   * 넷게임 라운드 종료 정산
   */
  const settleNetOthelloRound = (room: NetOthelloRoomData, finalBoard: DiscColor[]) => {
    const { black, white } = countDiscs(finalBoard);
    const blackPlayer = room.players.find((p) => p.discColor === 1) || room.players[0];
    const whitePlayer = room.players.find((p) => p.discColor === 2) || room.players[1];
    const wonPot = room.pot || 0;

    if (black === white) {
      // 무승부 시 판돈 반분 반환
      const halfPot = Math.floor(wonPot / 2);
      room.players = room.players.map((p) => ({
        ...p,
        chips: p.chips + halfPot,
      }));
      room.pot = 0;
      room.status = 'ROUND_OVER';
      room.turnDeadline = null;
      room.turnNotice = '';
      room.roundWinnerId = null;
      room.winnerAnnouncement = `🤝 무승부! (⚫ ${black} : ⚪ ${white}) 판돈 ${wonPot.toLocaleString()}칩을 반씩 나누어 가집니다!`;
      return;
    }

    const winner = black > white ? blackPlayer : whitePlayer;
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

    room.pot = 0;
    room.turnDeadline = null;
    room.turnNotice = '';
    room.roundWinnerId = winner.id;

    if (anyBusted) {
      room.status = 'MATCH_OVER';
      room.winnerAnnouncement = `👑 최종 우승! ${winner.name}님이 ⚫${black} : ⚪${white}로 승리하며 상대 판돈을 모두 소진시켰습니다!`;
    } else {
      room.status = 'ROUND_OVER';
      room.winnerAnnouncement = `🎊 ${winner.name}님 승리! (⚫ ${black} : ⚪ ${white}) 판돈 ${wonPot.toLocaleString()}칩 독식! (${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}칩)`;
    }

    saveHallOfFameRecord('NET', {
      name: winner.name,
      scoreOrLevel: `${winnerObj.wins}승 · 보유 ${winnerObj.chips.toLocaleString()}칩`,
    });
  };

  /**
   * 넷게임 보드 칸 클릭 착수 처리
   */
  const handleNetCellClick = async (idx: number) => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const actor = activeNetRoom.players.find((p) => p.discColor === activeNetRoom.currentTurn);
    if (!actor || actor.id !== mySessionId) return;

    const flips = getFlippableIndices(activeNetRoom.board, idx, activeNetRoom.currentTurn);
    if (flips.length === 0) {
      showToast('그 위치에는 돌을 놓을 수 없습니다!', 'danger');
      return;
    }

    playSound('place');
    const roomRef = ref(db, `othello_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetOthelloRoomData;
      if (room.status !== 'PLAYING') return room;

      const turnColor = room.currentTurn;
      const currentActor = room.players.find((p) => p.discColor === turnColor);
      if (!currentActor || currentActor.id !== mySessionId) return room;

      const boardCopy: DiscColor[] = Array.from({ length: 64 }, (_, i) =>
        room.board?.[i] === 1 || room.board?.[i] === 2 ? room.board[i] : 0
      );
      const validFlips = getFlippableIndices(boardCopy, idx, turnColor);
      if (validFlips.length === 0) return room;

      boardCopy[idx] = turnColor;
      for (const fIdx of validFlips) {
        boardCopy[fIdx] = turnColor;
      }

      room.board = boardCopy;
      room.lastMoveIdx = idx;
      room.flippedIndices = validFlips;

      const nextColor: 1 | 2 = turnColor === 1 ? 2 : 1;
      const nextValid = getValidMoves(boardCopy, nextColor);
      const currValidAgain = getValidMoves(boardCopy, turnColor);

      if (nextValid.length === 0 && currValidAgain.length === 0) {
        settleNetOthelloRound(room, boardCopy);
        return room;
      }

      if (nextValid.length === 0) {
        const skippedPlayer = room.players.find((p) => p.discColor === nextColor);
        room.currentTurn = turnColor;
        room.turnDeadline = Date.now() + room.baseTimeout * 1000;
        room.turnNotice = `⚠️ ${skippedPlayer?.name ?? '상대'}님이 놓을 곳이 없어 자동 패스! ${currentActor.name}님이 한 번 더 둡니다.`;
      } else {
        const nextPlayer = room.players.find((p) => p.discColor === nextColor);
        room.currentTurn = nextColor;
        room.turnDeadline = Date.now() + room.baseTimeout * 1000;
        room.turnNotice = `🪵 ${currentActor.name}님이 ${formatCoord(idx)}에 착수 (${validFlips.length}개 뒤집기) 👉 ${nextPlayer?.name}님 차례!`;
      }

      return room;
    });
  };

  /**
   * 넷게임 턴 시간 초과 시 유효한 수 중 랜덤 자동 착수
   */
  const handleNetTurnTimeout = async (room: NetOthelloRoomData) => {
    const roomRef = ref(db, `othello_rooms/room_${room.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const r = roomData as NetOthelloRoomData;
      if (r.status !== 'PLAYING') return r;

      const turnColor = r.currentTurn;
      const actor = r.players.find((p) => p.discColor === turnColor);
      const boardCopy: DiscColor[] = Array.from({ length: 64 }, (_, i) =>
        r.board?.[i] === 1 || r.board?.[i] === 2 ? r.board[i] : 0
      );

      const moves = getValidMoves(boardCopy, turnColor);
      if (moves.length === 0) {
        settleNetOthelloRound(r, boardCopy);
        return r;
      }

      const chosenIdx = moves[Math.floor(Math.random() * moves.length)];
      const flips = getFlippableIndices(boardCopy, chosenIdx, turnColor);
      boardCopy[chosenIdx] = turnColor;
      for (const fIdx of flips) {
        boardCopy[fIdx] = turnColor;
      }

      r.board = boardCopy;
      r.lastMoveIdx = chosenIdx;
      r.flippedIndices = flips;

      const nextColor: 1 | 2 = turnColor === 1 ? 2 : 1;
      const nextValid = getValidMoves(boardCopy, nextColor);
      const currValidAgain = getValidMoves(boardCopy, turnColor);

      if (nextValid.length === 0 && currValidAgain.length === 0) {
        settleNetOthelloRound(r, boardCopy);
        return r;
      }

      if (nextValid.length === 0) {
        r.currentTurn = turnColor;
        r.turnDeadline = Date.now() + r.baseTimeout * 1000;
        r.turnNotice = `⏰ 시간 초과 자동 착수(${formatCoord(chosenIdx)})! 상대 둘 곳 없어 ${actor?.name}님 연속 차례!`;
      } else {
        const nextPlayer = r.players.find((p) => p.discColor === nextColor);
        r.currentTurn = nextColor;
        r.turnDeadline = Date.now() + r.baseTimeout * 1000;
        r.turnNotice = `⏰ 시간 초과로 ${actor?.name}님이 ${formatCoord(chosenIdx)}에 자동 착수! 👉 ${nextPlayer?.name}님 차례!`;
      }
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
    const p1Name = soloName1.trim() || '흑기사';
    const p2Name = soloName2.trim() || '백작';
    setSoloPlayers([
      {
        id: '1',
        name: p1Name,
        discColor: 1,
        chips: INITIAL_CHIPS,
        wins: 0,
        currentBet: 0,
        isEliminated: false,
      },
      {
        id: '2',
        name: p2Name,
        discColor: 2,
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
      { ...prev[1], discColor: 1 },
      { ...prev[0], discColor: 2 },
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

    // 다음 판에서는 흑/백 선공 자동 교대
    const orderedPlayers =
      isNextRound && !isFreshMatch
        ? [
            { ...basePlayers[1], discColor: 1 as const },
            { ...basePlayers[0], discColor: 2 as const },
          ]
        : [
            { ...basePlayers[0], discColor: 1 as const },
            { ...basePlayers[1], discColor: 2 as const },
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
    const notice = `🪵 [${nextRound}국] 동일 판돈 ${equalStake.toLocaleString()}칩 베팅! ⚫흑돌 ${preparedPlayers[0].name}님 선공입니다.`;

    setSoloRoundNum(nextRound);
    setSoloPot(totalPot);
    setSoloPlayers(preparedPlayers);
    setSoloBoard(createInitialOthelloBoard());
    setSoloTurn(1);
    setSoloLastMoveIdx(null);
    setSoloFlippedIndices([]);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setWinnerAnnouncement('');
    setShowFireworks(false);
    setTurnNotice(notice);
    speakKorean(notice);
    setGameState('PLAYING');
  };

  const settleSoloOthelloRound = (finalBoard: DiscColor[]) => {
    const { black, white } = countDiscs(finalBoard);
    const blackPlayer = soloPlayers.find((p) => p.discColor === 1) || soloPlayers[0];
    const whitePlayer = soloPlayers.find((p) => p.discColor === 2) || soloPlayers[1];

    if (black === white) {
      const halfPot = Math.floor(soloPot / 2);
      const tiedPlayers = soloPlayers.map((p) => ({
        ...p,
        chips: p.chips + halfPot,
      }));
      const msg = `🤝 무승부! (⚫ ${black} : ⚪ ${white}) 판돈 ${soloPot.toLocaleString()}칩을 반씩 반환합니다.`;
      setSoloPlayers(tiedPlayers);
      setSoloPot(0);
      setTurnNotice('');
      setWinnerAnnouncement(msg);
      setGameState('ROUND_OVER');
      speakKorean(msg);
      return;
    }

    const winner = black > white ? blackPlayer : whitePlayer;
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

    const announcement = anyBusted
      ? `👑 최종 우승! ${winner.name}님이 ⚫${black} : ⚪${white}로 승리하며 상대 판돈을 모두 소진시켰습니다!`
      : `🎊 ${winner.name}님 승리! (⚫ ${black} : ⚪ ${white}) 판돈 ${soloPot.toLocaleString()}칩 독식! (${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}칩)`;

    setSoloPlayers(settledPlayers);
    setSoloPot(0);
    setTurnNotice('');
    setWinnerAnnouncement(announcement);
    setGameState(anyBusted ? 'MATCH_OVER' : 'ROUND_OVER');
    triggerFireworksCelebration(announcement);

    saveHallOfFameRecord('SOLO', {
      name: winner.name,
      scoreOrLevel: `${winnerObj.wins}승 · 보유 ${winnerObj.chips.toLocaleString()}칩`,
    });
  };

  const handleSoloCellClick = (idx: number, isAuto = false) => {
    if (gameState !== 'PLAYING') return;
    const flips = getFlippableIndices(soloBoard, idx, soloTurn);
    if (flips.length === 0) {
      if (!isAuto) showToast('그 칸에는 돌을 놓을 수 없습니다!', 'danger');
      return;
    }

    playSound('place');
    const nextBoard = [...soloBoard];
    nextBoard[idx] = soloTurn;
    for (const fIdx of flips) {
      nextBoard[fIdx] = soloTurn;
    }

    setSoloBoard(nextBoard);
    setSoloLastMoveIdx(idx);
    setSoloFlippedIndices(flips);

    const actor = soloPlayers.find((p) => p.discColor === soloTurn)!;
    const nextColor: 1 | 2 = soloTurn === 1 ? 2 : 1;
    const nextValid = getValidMoves(nextBoard, nextColor);
    const currValidAgain = getValidMoves(nextBoard, soloTurn);

    if (nextValid.length === 0 && currValidAgain.length === 0) {
      settleSoloOthelloRound(nextBoard);
      return;
    }

    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;

    if (nextValid.length === 0) {
      const skippedPlayer = soloPlayers.find((p) => p.discColor === nextColor)!;
      const notice = `⚠️ ${skippedPlayer.name}님이 둘 곳이 없어 자동 패스! ${actor.name}님이 한 번 더 둡니다.`;
      setTurnNotice(notice);
      speakKorean(notice);
    } else {
      const nextPlayer = soloPlayers.find((p) => p.discColor === nextColor)!;
      const prefix = isAuto ? '⏰ 시간 초과 자동 착수! ' : '🪵 ';
      const notice = `${prefix}${actor.name}님이 ${formatCoord(idx)}에 착수 (${flips.length}개 뒤집기) 👉 ${nextPlayer.name}님 차례!`;
      setSoloTurn(nextColor);
      setTurnNotice(notice);
      speakKorean(notice);
    }
  };

  // =========================================================================
  // 공용 UI 렌더링 헬퍼 (원목 8x8 오델로 보드, 폭죽 & 칩 이펙트)
  // =========================================================================
  const renderWoodenOthelloBoard = (
    board: DiscColor[],
    activeTurn: 1 | 2,
    canInteract: boolean,
    lastMoveIdx: number | null,
    flippedIndices: number[],
    onCellClick: (idx: number) => void
  ) => {
    const validMovesSet = new Set(canInteract ? getValidMoves(board, activeTurn) : []);
    const flippedSet = new Set(flippedIndices);

    return (
      <div className="wood-board-outer-frame">
        {/* 상단 열 좌표 A~H */}
        <div className="wood-coord-top">
          <span className="coord-corner" />
          {['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((col) => (
            <span key={col} className="coord-label">
              {col}
            </span>
          ))}
        </div>

        <div className="wood-board-middle-row">
          {/* 좌측 행 좌표 1~8 */}
          <div className="wood-coord-left">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((row) => (
              <span key={row} className="coord-label">
                {row}
              </span>
            ))}
          </div>

          {/* 8x8 원목 격자판 */}
          <div className="wood-grid-surface">
            {board.map((cell, idx) => {
              const isValid = validMovesSet.has(idx);
              const isLast = lastMoveIdx === idx;
              const isFlipped = flippedSet.has(idx);

              return (
                <button
                  key={idx}
                  type="button"
                  disabled={!isValid}
                  onClick={() => onCellClick(idx)}
                  className={`wood-board-cell ${isValid ? 'valid-target' : ''} ${
                    isLast ? 'last-moved-cell' : ''
                  }`}
                  aria-label={`${formatCoord(idx)} 칸`}
                >
                  {/* 사진처럼 나무판에 오목하게 파인 원형 홈 */}
                  <span className="carved-wood-socket">
                    {cell !== 0 && (
                      <span
                        className={`wood-othello-disc ${
                          cell === 1 ? 'black-wood' : 'white-wood'
                        } ${isFlipped ? 'disc-flip-anim' : ''} ${
                          isLast ? 'disc-place-anim' : ''
                        }`}
                      >
                        <i className="disc-wood-grain" />
                        {isLast && <span className="last-move-dot" />}
                      </span>
                    )}

                    {/* 착수 가능 위치 가이드 점 */}
                    {cell === 0 && isValid && showValidHints && (
                      <span
                        className={`valid-hint-marker ${
                          activeTurn === 1 ? 'hint-black' : 'hint-white'
                        }`}
                      />
                    )}
                  </span>
                </button>
              );
            })}
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
      <div className="oth-container" style={{ background: WOOD_BG_THEMES[0] }}>
        <div className="setup-card home-entry-card">
          <div className="home-castle-icon">⚫🪵⚪</div>
          <h1 className="setup-title">우드 오델로 (OTHELLO)</h1>
          <p className="home-subtitle">
            원목 격자판 수싸움 · 동일 판돈 승자 독식 · 승점(1승, 2승…) &amp; 판돈 누적
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
      <div className="oth-container" style={{ background: WOOD_BG_THEMES[0], padding: '16px' }}>
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
      <div className="oth-container" style={{ background: WOOD_BG_THEMES[0] }}>
        <div className="net-lobby-container">
          <div className="net-lobby-header">
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, fontSize: '20px', color: '#3e2723' }}>
              🌐 우드 오델로 넷게임 (4개 대국실)
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
                    <span className="room-number-title">🪵 제 {room.roomId} 오델로실</span>
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
                            <span
                              className={`mini-disc-icon ${
                                p.discColor === 1 ? 'black' : 'white'
                              }`}
                            />
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
              <h2 style={{ margin: '0 0 8px' }}>🪵 제 {joinModalRoom.roomId} 오델로실 입장</h2>
              <p className="modal-subtext">
                동일 판돈 <strong>{joinModalRoom.anteBet.toLocaleString()}칩</strong>을 걸고 1:1
                대국이 진행됩니다.
              </p>

              <input
                type="text"
                className="player-input"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: '14px' }}
                placeholder="대국자 이름 입력 (예: 흑기사)"
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
          className="oth-container"
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
        <div className="oth-container" style={{ background: WOOD_BG_THEMES[0] }}>
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
              🪵 우드 오델로 대기실 {amISpectator ? '👀 [관전모드]' : ''}
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
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px',color: '#575757' }}>
                      <span
                        className={`mini-disc-icon large ${
                          p.discColor === 1 ? 'black' : 'white'
                        }`}
                      />
                      {p.name} ({p.discColor === 1 ? '⚫흑돌' : '⚪백돌'}){' '}
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

    const { black, white } = countDiscs(activeNetRoom.board);
    const activeTurnPlayer = roomPlayers.find((p) => p.discColor === activeNetRoom.currentTurn);
    const isMyTurn =
      activeNetRoom.status === 'PLAYING' &&
      activeTurnPlayer?.id === mySessionId &&
      !amISpectator;
    const isRoundEnded =
      activeNetRoom.status === 'ROUND_OVER' || activeNetRoom.status === 'MATCH_OVER';

    return (
      <div className="oth-container" style={{ background: WOOD_BG_THEMES[0] }}>
        {renderFireworksAndChips()}

        {toast && (
          <div key={toast.id} className={`oth-toast ${toast.type}`}>
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
                  activeNetRoom.status === 'PLAYING' && p.discColor === activeNetRoom.currentTurn;
                const discCount = p.discColor === 1 ? black : white;
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${isActive ? 'active-turn-spotlight' : ''}`}
                  >
                    <div className="player-badge-top">
                      <span
                        className={`mini-disc-icon ${p.discColor === 1 ? 'black' : 'white'}`}
                      />
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '>'}
                        {p.name}
                        {p.id === mySessionId ? '(나)' : ''}
                      </strong>
                      <span className="disc-score-pill">{discCount}돌</span>
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
                title="착수 가능 위치 힌트 켜기/끄기"
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
          <div className="oth-table-board">
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
                      : `🔥 다음 대국 시작 (흑/백 교대 · ${activeNetRoom.anteBet.toLocaleString()}칩)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={activeNetRoom.turnNotice} className="oth-notice-banner">
                {activeNetRoom.turnNotice}
              </div>
            )}

            {/* 판돈 및 실시간 돌 개수 스코어보드 */}
            <div className="oth-scoreboard-strip">
              <div className="score-side black-side">
                <span className="mini-disc-icon large black" />
                <span>흑돌</span>
                <strong>{black}</strong>
              </div>

              <div className="center-pot-box">
                <span className="pot-label">💰 누적 POT</span>
                <strong className="pot-amount">
                  {(activeNetRoom.pot || 0).toLocaleString()} 칩
                </strong>
              </div>

              <div className="score-side white-side">
                <strong>{white}</strong>
                <span>백돌</span>
                <span className="mini-disc-icon large white" />
              </div>
            </div>

            {/* 원목 8x8 오델로 보드 */}
            <div className="board-center-stage">
              {renderWoodenOthelloBoard(
                activeNetRoom.board,
                activeNetRoom.currentTurn,
                isMyTurn,
                activeNetRoom.lastMoveIdx,
                activeNetRoom.flippedIndices,
                handleNetCellClick
              )}
            </div>
          </div>

          {/* 하단 상태 도크 */}
          <div className="oth-bottom-dock">
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
                  {activeNetRoom.currentTurn === 1 ? '⚫ 흑돌' : '⚪ 백돌'}{' '}
                  {activeTurnPlayer?.name}님 차례
                  {isMyTurn ? ' · 원목 보드의 빈 홈을 눌러 착수하세요!' : ' · 상대방 수 고민 중...'}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // 5. 단독게임(SOLO) - 2인 로컬 원목 오델로 연승 매치
  // =========================================================================
  const { black: soloBlack, white: soloWhite } = countDiscs(soloBoard);
  const currentSoloPlayer =
    soloPlayers.find((p) => p.discColor === soloTurn) || soloPlayers[0];
  const isSoloEnded = gameState === 'ROUND_OVER' || gameState === 'MATCH_OVER';

  return (
    <div className="oth-container" style={{ background: WOOD_BG_THEMES[0] }}>
      {renderFireworksAndChips()}

      {toast && (
        <div key={toast.id} className={`oth-toast ${toast.type}`}>
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
          <h1 className="setup-title">🪵 우드 오델로 (단독게임 설정)</h1>

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
              <div className="player-item">
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="mini-disc-icon large black" />
                  <span>선공 (흑돌)</span>
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

              <div className="player-item">
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="mini-disc-icon large white" />
                  <span>후공 (백돌)</span>
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
            ➡️ 흑/백 선공 확인하러 가기
          </button>
        </div>
      )}

      {gameState === 'READY' && (
        <div className="order-panel">
          <div className="order-header">
            <h2 style={{ margin: 0, fontSize: '20px', color: '#3e2723' }}>
              📋 흑/백 돌 배정을 확인하세요
            </h2>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: '8px 14px', fontSize: '13px' }}
              onClick={swapSoloOrder}
            >
              🔄 흑/백 맞바꾸기
            </button>
          </div>

          <div className="order-list">
            {soloPlayers.map((player) => (
              <div key={player.id} className="order-item">
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span
                    className={`mini-disc-icon large ${
                      player.discColor === 1 ? 'black' : 'white'
                    }`}
                  />
                  <strong>{player.discColor === 1 ? '선공 (⚫ 흑돌)' : '후공 (⚪ 백돌)'}</strong>
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
                const isActive = !isSoloEnded && p.discColor === soloTurn;
                const discCount = p.discColor === 1 ? soloBlack : soloWhite;
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${isActive ? 'active-turn-spotlight' : 'active-turn-unlight'}`}
                    >
                    <div className="player-badge-top">
                      <span
                        className={`mini-disc-icon ${p.discColor === 1 ? 'black' : 'white'}`}
                      />
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '>'}
                        {p.name}
                      </strong>
                      <span className="disc-score-pill">{discCount}돌</span>
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
                title="착수 가능 위치 힌트 켜기/끄기"
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
          <div className="oth-table-board">
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
                      : `🔥 다음 대국 시작 (흑/백 교대 · ${soloAnteBet.toLocaleString()}칩)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={turnNotice} className="oth-notice-banner">
                {turnNotice}
              </div>
            )}

            {/* 판돈 및 실시간 흑/백 돌 카운터 */}
            <div className="oth-scoreboard-strip">
              <div className="score-side black-side">
                <span className="mini-disc-icon large black" />
                <span>흑돌</span>
                <strong>{soloBlack}</strong>
              </div>

              <div className="center-pot-box">
                <span className="pot-label">💰 누적 POT</span>
                <strong className="pot-amount">{soloPot.toLocaleString()} 칩</strong>
              </div>

              <div className="score-side white-side">
                <strong>{soloWhite}</strong>
                <span>백돌</span>
                <span className="mini-disc-icon large white" />
              </div>
            </div>

            {/* 원목 8x8 오델로 보드 */}
            <div className="board-center-stage">
              {renderWoodenOthelloBoard(
                soloBoard,
                soloTurn,
                gameState === 'PLAYING',
                soloLastMoveIdx,
                soloFlippedIndices,
                (idx) => handleSoloCellClick(idx, false)
              )}
            </div>
          </div>

          {/* 하단 상태 도크 */}
          <div className="oth-bottom-dock">
            <div className="dock-top-status">
              {isSoloEnded ? (
                <span className="waiting-dock-msg">
                  🎉 대국 종료! <strong>[다음 대국 시작]</strong>을 눌러 흑/백을 교대해 계속
                  대국하세요!
                </span>
              ) : (
                <span className="turn-owner-pill large-turn-pill">
                  {soloTurn === 1 ? '⚫ 흑돌' : '⚪ 백돌'} {currentSoloPlayer.name}님 차례 · 🏆
                  {currentSoloPlayer.wins}승 · 💰{currentSoloPlayer.chips.toLocaleString()}칩
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}