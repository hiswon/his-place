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
import './Page11.css';

// 0: 빈 칸, 1: 흑 주사위(좌측 시작), 2: 백 주사위(우측 시작)
type TeamColor = 0 | 1 | 2;
type DieValue = 1 | 2 | 3 | 4 | 5 | 6;

interface DittleCell {
  owner: TeamColor;
  value: DieValue | 0;
}

interface DittlePlayer {
  id: string;
  name: string;
  team: 1 | 2; // 1: 흑(좌측), 2: 백(우측)
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

interface NetDittleRoomData {
  roomId: number;
  status: 'EMPTY' | 'WAITING' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER';
  players: DittlePlayer[];
  pot: number;
  waitlist: WaitlistPlayer[];
  spectators: SpectatorPlayer[];
  baseTimeout: number;
  anteBet: number;
  roundNumber: number;
  board: DittleCell[]; // 6x6 = 36칸 1차원 배열
  currentTurn: 1 | 2;
  lastMoveFromIdx: number | null;
  lastMoveToIdx: number | null;
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

const BOARD_SIZE = 6;
const TOTAL_CELLS = 36;
const INITIAL_CHIPS = 10000;
const DEFAULT_TIMEOUT_SEC = 60;

const ORTHO_DIRS: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

// 주사위 눈금(1~6)별 3x3 그리드 내 점(Pip) 위치 인덱스 (0~8)
const DIE_PIP_POSITIONS: Record<DieValue, readonly number[]> = {
  1: [4],
  2: [2, 6],
  3: [2, 4, 6],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

/**
 * 사진 속 초기 Dittle 6x6 보드 생성
 * - 1열(좌측): 상단 2칸, 하단 2칸에 흑 주사위(6)
 * - 6열(우측): 상단 2칸, 하단 2칸에 백 주사위(6)
 */
function createInitialDittleBoard(): DittleCell[] {
  const board: DittleCell[] = Array.from({ length: TOTAL_CELLS }, () => ({
    owner: 0,
    value: 0,
  }));

  const leftRows = [0, 1, 4, 5];
  for (const r of leftRows) {
    board[r * BOARD_SIZE + 0] = { owner: 1, value: 6 };
  }

  const rightRows = [0, 1, 4, 5];
  for (const r of rightRows) {
    board[r * BOARD_SIZE + (BOARD_SIZE - 1)] = { owner: 2, value: 6 };
  }

  return board;
}

/**
 * 선택한 주사위(startIdx)에서 도달 가능한 모든 칸과 최소 이동 거리(steps) 계산
 * 규칙:
 * - 상하좌우 인접 칸으로 1 ~ value 칸 이동 (같은 턴에 밟은 칸 재방문 불가)
 * - 중간 경로에서는 아군/적군 주사위를 뛰어넘어 통과 가능
 * - 최종 도착 칸은 빈 칸이거나, 상대방 주사위가 있는 칸(포획)이어야 함
 */
function getReachableDestinations(
  board: DittleCell[],
  startIdx: number
): Map<number, number> {
  const startCell = board[startIdx];
  const reachable = new Map<number, number>();
  if (!startCell || startCell.owner === 0 || startCell.value <= 0) {
    return reachable;
  }

  const myTeam = startCell.owner;
  const maxSteps = startCell.value;

  const dfs = (currIdx: number, stepsUsed: number, visitedMask: bigint) => {
    if (stepsUsed >= 1) {
      const target = board[currIdx];
      // 빈 칸이거나 상대 주사위 칸이면 도착 가능 (아군 주사위 위에는 멈출 수 없음)
      if (target.owner !== myTeam) {
        const prevMin = reachable.get(currIdx);
        if (prevMin === undefined || stepsUsed < prevMin) {
          reachable.set(currIdx, stepsUsed);
        }
      }
    }

    if (stepsUsed >= maxSteps) return;

    const r = Math.floor(currIdx / BOARD_SIZE);
    const c = currIdx % BOARD_SIZE;

    for (const [dr, dc] of ORTHO_DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;

      const nextIdx = nr * BOARD_SIZE + nc;
      const bit = 1n << BigInt(nextIdx);
      if ((visitedMask & bit) !== 0n) continue;

      dfs(nextIdx, stepsUsed + 1, visitedMask | bit);
    }
  };

  dfs(startIdx, 0, 1n << BigInt(startIdx));
  return reachable;
}

/**
 * 해당 진영(team)이 하나라도 유효한 이동을 할 수 있는지 검사
 */
function hasAnyValidDittleMove(board: DittleCell[], team: 1 | 2): boolean {
  for (let i = 0; i < TOTAL_CELLS; i++) {
    if (board[i].owner === team && board[i].value > 0) {
      if (getReachableDestinations(board, i).size > 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 양 진영 주사위 개수 및 눈금 총합 집계
 */
function getTeamStats(board: DittleCell[]): {
  blackCount: number;
  blackPips: number;
  whiteCount: number;
  whitePips: number;
} {
  let blackCount = 0;
  let blackPips = 0;
  let whiteCount = 0;
  let whitePips = 0;

  for (const cell of board) {
    if (cell.owner === 1) {
      blackCount += 1;
      blackPips += cell.value;
    } else if (cell.owner === 2) {
      whiteCount += 1;
      whitePips += cell.value;
    }
  }
  return { blackCount, blackPips, whiteCount, whitePips };
}

/**
 * 보드 좌표 표기 (예: A1 ~ F6)
 */
function formatCoord(idx: number): string {
  const colChar = String.fromCharCode(65 + (idx % BOARD_SIZE));
  const rowNum = Math.floor(idx / BOARD_SIZE) + 1;
  return `${colChar}${rowNum}`;
}

/**
 * 보드 이동 적용 (분할 이동 vs 전체 이동, 상대 포획 처리)
 */
function applyDittleMove(
  board: DittleCell[],
  fromIdx: number,
  toIdx: number,
  stepsUsed: number
): { nextBoard: DittleCell[]; captured: boolean; splitLeft: number } {
  const nextBoard = board.map((cell) => ({ ...cell }));
  const movingDie = nextBoard[fromIdx];
  const targetCell = nextBoard[toIdx];

  const captured = targetCell.owner !== 0 && targetCell.owner !== movingDie.owner;
  const remainingValue = movingDie.value - stepsUsed;

  if (remainingValue > 0) {
    // 눈금 분할: 원래 칸에 남은 눈금 주사위를 남김
    nextBoard[fromIdx] = {
      owner: movingDie.owner,
      value: remainingValue as DieValue,
    };
  } else {
    // 전체 눈금 이동
    nextBoard[fromIdx] = { owner: 0, value: 0 };
  }

  nextBoard[toIdx] = {
    owner: movingDie.owner,
    value: stepsUsed as DieValue,
  };

  return {
    nextBoard,
    captured,
    splitLeft: Math.max(0, remainingValue),
  };
}

function createDefaultDittleRoom(roomId: number): NetDittleRoomData {
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
    board: createInitialDittleBoard(),
    currentTurn: 1,
    lastMoveFromIdx: null,
    lastMoveToIdx: null,
    turnDeadline: null,
    turnNotice: '',
    winnerAnnouncement: '',
    roundWinnerId: null,
    waitingSince: null,
  };
}

export default function Page11() {
  const [appMode, setAppMode] = useState<
    'HOME' | 'SOLO' | 'NET_LOBBY' | 'NET_ROOM' | 'HALL_OF_FAME'
  >('HOME');

  const [mySessionId] = useState<string>(() => {
    const saved = sessionStorage.getItem('dittle_net_uid');
    if (saved) return saved;
    const generated = `dtl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('dittle_net_uid', generated);
    return generated;
  });

  // 넷게임 상태
  const [rooms, setRooms] = useState<NetDittleRoomData[]>(
    [1, 2, 3, 4].map(createDefaultDittleRoom)
  );
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [joinModalRoom, setJoinModalRoom] = useState<NetDittleRoomData | null>(null);
  const [joinPlayerName, setJoinPlayerName] = useState<string>('');
  const [remainingSeconds, setRemainingSeconds] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [waitingCountdownSec, setWaitingCountdownSec] = useState<number>(420);
  const timeoutHandledRef = useRef<number | null>(null);
  const lastSpokenNoticeRef = useRef<string>('');
  const lastCountdownSpokenRef = useRef<number | null>(null);

  // 선택된 주사위 인덱스 (단독/넷 공용)
  const [selectedDieIdx, setSelectedDieIdx] = useState<number | null>(null);

  // 단독게임(SOLO) 상태
  const [gameState, setGameState] = useState<
    'SETUP' | 'READY' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER'
  >('SETUP');
  const [soloPlayers, setSoloPlayers] = useState<DittlePlayer[]>([
    {
      id: '1',
      name: 'WADE',
      team: 1,
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
    },
    {
      id: '2',
      name: 'DIANA',
      team: 2,
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
    },
  ]);

  const [soloName1, setSoloName1] = useState('WADE');
  const [soloName2, setSoloName2] = useState('DIANA');
  const [soloAnteBet, setSoloAnteBet] = useState<number>(1000);
  const [soloTimeoutSec, setSoloTimeoutSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRemainingSec, setSoloRemainingSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRoundNum, setSoloRoundNum] = useState<number>(1);
  const [soloPot, setSoloPot] = useState<number>(0);

  const [soloBoard, setSoloBoard] = useState<DittleCell[]>(createInitialDittleBoard());
  const [soloTurn, setSoloTurn] = useState<1 | 2>(1);
  const [soloLastFromIdx, setSoloLastFromIdx] = useState<number | null>(null);
  const [soloLastToIdx, setSoloLastToIdx] = useState<number | null>(null);
  const [showMoveHints, setShowMoveHints] = useState<boolean>(true);
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
   * 주사위 이동 / 분할 / 포획 사운드
   */
  const playSound = (kind: 'dice' | 'capture' | 'chip' | 'win' | 'tick') => {
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
        dice: [280, 190],
        capture: [440, 293.66, 196],
        chip: [880, 1174.66],
        win: [523.25, 659.25, 783.99, 1046.5, 1318.5],
        tick: [987.77],
      };

      notesMap[kind].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === 'dice' ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.055);
        gain.gain.setValueAtTime(kind === 'dice' ? 0.22 : 0.15, ctx.currentTime + idx * 0.055);
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
    const key = type === 'SOLO' ? 'dittle_hof_solo' : 'dittle_hof_net';
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
    const key = type === 'SOLO' ? 'dittle_hof_solo' : 'dittle_hof_net';
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      return [];
    }
  };

  // =========================================================================
  // 방 나가기 공통 처리 함수
  // =========================================================================
  const leaveRoomById = useCallback(
    async (roomIdToLeave: number) => {
      const roomRef = ref(db, `dittle_rooms/room_${roomIdToLeave}`);
      try {
        await runTransaction(roomRef, (roomData) => {
          if (!roomData) return roomData;
          const room = roomData as NetDittleRoomData;
          const filteredPlayers = (room.players || []).filter((p) => p.id !== mySessionId);
          const filteredWaitlist = (room.waitlist || []).filter((w) => w.id !== mySessionId);
          const filteredSpectators = (room.spectators || []).filter((s) => s.id !== mySessionId);

          if (filteredPlayers.length === 0 && filteredSpectators.length === 0) {
            return createDefaultDittleRoom(room.roomId);
          }

          room.players = filteredPlayers.map((p, idx) => ({
            ...p,
            team: idx === 0 ? 1 : 2,
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

  useEffect(() => {
    if (appMode !== 'NET_ROOM' || !selectedRoomId) return;

    const presenceRef = ref(db, `dittle_presence/room_${selectedRoomId}/${mySessionId}`);
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
        const roomRef = ref(db, `dittle_rooms/room_${id}`);
        const snap = await get(roomRef);
        if (!snap.exists()) {
          await set(roomRef, createDefaultDittleRoom(id));
        }
      }
    };
    ensureRoomsExist();

    const roomsRef = ref(db, 'dittle_rooms');
    const unsubscribe = onValue(roomsRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      const loadedRooms: NetDittleRoomData[] = [1, 2, 3, 4].map((id) => {
        const rData = data[`room_${id}`];
        const def = createDefaultDittleRoom(id);
        if (!rData) return def;

        const normalizedBoard: DittleCell[] = Array.from({ length: TOTAL_CELLS }, (_, i) => {
          const raw = rData.board?.[i];
          const owner: TeamColor = raw?.owner === 1 || raw?.owner === 2 ? raw.owner : 0;
          const val = typeof raw?.value === 'number' && raw.value >= 1 && raw.value <= 6 ? raw.value : 0;
          return { owner, value: owner === 0 ? 0 : (val as DieValue) };
        });

        return {
          ...def,
          ...rData,
          players: (rData.players || []).map((p: DittlePlayer, idx: number) => ({
            ...p,
            team: p.team === 2 ? 2 : idx === 0 ? 1 : 2,
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
          lastMoveFromIdx: typeof rData.lastMoveFromIdx === 'number' ? rData.lastMoveFromIdx : null,
          lastMoveToIdx: typeof rData.lastMoveToIdx === 'number' ? rData.lastMoveToIdx : null,
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
    setSelectedDieIdx(null);
  }, [activeNetRoom?.currentTurn, activeNetRoom?.status, soloTurn, gameState]);

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
          const roomRef = ref(db, `dittle_rooms/room_${activeNetRoom.roomId}`);
          await set(roomRef, createDefaultDittleRoom(activeNetRoom.roomId));
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
          // 시간 초과 시 임의의 주사위로 랜덤 유효 이동 실행
          const candidates: { fromIdx: number; toIdx: number; steps: number }[] = [];
          for (let i = 0; i < TOTAL_CELLS; i++) {
            if (soloBoard[i].owner === soloTurn) {
              const destMap = getReachableDestinations(soloBoard, i);
              destMap.forEach((steps, toIdx) => {
                candidates.push({ fromIdx: i, toIdx, steps });
              });
            }
          }
          if (candidates.length > 0) {
            const pick = candidates[Math.floor(Math.random() * candidates.length)];
            executeSoloMove(pick.fromIdx, pick.toIdx, pick.steps, true);
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

    const roomRef = ref(db, `dittle_rooms/room_${joinModalRoom.roomId}`);

    try {
      let joinResultType = 'PLAYER';

      await runTransaction(roomRef, (roomData) => {
        const room: NetDittleRoomData = roomData || createDefaultDittleRoom(joinModalRoom.roomId);
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
          const team: 1 | 2 = room.players.length === 0 ? 1 : 2;
          const newPlayer: DittlePlayer = {
            id: mySessionId,
            name: trimmedName,
            team,
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
        showToast('👀 관전모드로 입장했습니다!', 'info');
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
    const roomRef = ref(db, `dittle_rooms/room_${activeNetRoom.roomId}`);
    await update(roomRef, {
      anteBet: newAnteBet,
      baseTimeout: clampedTimeout,
      waitingSince: Date.now(),
    });
  };

  /**
   * 넷게임 라운드 시작 (좌측 흑 주사위 / 우측 백 주사위 교대 배정 및 동일 판돈 베팅)
   */
  const handleStartNetRound = async (isNextRound = false) => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `dittle_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetDittleRoomData;
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
      const nextActive: DittlePlayer[] = [...survivingPlayers];
      const remainingWaitlist: WaitlistPlayer[] = [];

      for (const w of waitlist) {
        if (nextActive.length < 2) {
          nextActive.push({
            id: w.id,
            name: w.name,
            team: 2,
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

      const preparedPlayers: DittlePlayer[] = orderedActive.map((p, idx) => {
        collectedPot += equalStake;
        return {
          ...p,
          team: idx === 0 ? 1 : 2,
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
      room.board = createInitialDittleBoard();
      room.currentTurn = 1;
      room.lastMoveFromIdx = null;
      room.lastMoveToIdx = null;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.winnerAnnouncement = '';
      room.roundWinnerId = null;
      room.turnNotice = `🎲 [${nextRound}국] 판돈 ${equalStake.toLocaleString()}칩 베팅! ⚫흑 주사위 ${preparedPlayers[0].name}님 선공입니다.`;
      room.waitingSince = null;

      return room;
    });

    setSelectedDieIdx(null);
    triggerChipAnimation('전원', activeNetRoom.anteBet, '#6d4c41');
  };

  /**
   * 넷게임 라운드 승패 정산
   */
  const settleNetDittleRound = (
    room: NetDittleRoomData,
    finalBoard: DittleCell[],
    winnerTeam: 1 | 2,
    reasonText: string
  ) => {
    const { blackCount, whiteCount } = getTeamStats(finalBoard);
    const winner = room.players.find((p) => p.team === winnerTeam) || room.players[0];
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

    room.pot = 0;
    room.turnDeadline = null;
    room.turnNotice = '';
    room.roundWinnerId = winner.id;

    if (anyBusted) {
      room.status = 'MATCH_OVER';
      room.winnerAnnouncement = `👑 최종 우승! ${winner.name}님이 ${reasonText} (⚫${blackCount} : ⚪${whiteCount}) 상대 판돈을 모두 획득했습니다!`;
    } else {
      room.status = 'ROUND_OVER';
      room.winnerAnnouncement = `🎊 ${winner.name}님 승리! ${reasonText} (⚫${blackCount} : ⚪${whiteCount}) 판돈 ${wonPot.toLocaleString()}칩 독식! (${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}칩)`;
    }

    saveHallOfFameRecord('NET', {
      name: winner.name,
      scoreOrLevel: `${winnerObj.wins}승 · 보유 ${winnerObj.chips.toLocaleString()}칩`,
    });
  };

  /**
   * 넷게임 보드 칸 클릭 처리 (1단계: 자기 주사위 선택 / 2단계: 도착 칸 선택)
   */
  const handleNetCellClick = async (idx: number) => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const actor = activeNetRoom.players.find((p) => p.team === activeNetRoom.currentTurn);
    if (!actor || actor.id !== mySessionId) return;

    const clickedCell = activeNetRoom.board[idx];

    // 자기 주사위 클릭 시 선택 토글
    if (clickedCell.owner === activeNetRoom.currentTurn) {
      if (selectedDieIdx === idx) {
        setSelectedDieIdx(null);
      } else {
        const destMap = getReachableDestinations(activeNetRoom.board, idx);
        if (destMap.size === 0) {
          showToast('이 주사위는 이동할 수 있는 칸이 없습니다!', 'danger');
          return;
        }
        setSelectedDieIdx(idx);
      }
      return;
    }

    if (selectedDieIdx === null) {
      showToast('먼저 이동할 내 주사위를 클릭하세요!', 'info');
      return;
    }

    const destMap = getReachableDestinations(activeNetRoom.board, selectedDieIdx);
    const stepsUsed = destMap.get(idx);
    if (stepsUsed === undefined) {
      showToast('선택한 주사위 눈금으로 도달할 수 없는 칸입니다!', 'danger');
      return;
    }

    const fromIdx = selectedDieIdx;
    setSelectedDieIdx(null);

    const roomRef = ref(db, `dittle_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetDittleRoomData;
      if (room.status !== 'PLAYING') return room;

      const turnTeam = room.currentTurn;
      const currentActor = room.players.find((p) => p.team === turnTeam);
      if (!currentActor || currentActor.id !== mySessionId) return room;

      const boardCopy: DittleCell[] = Array.from({ length: TOTAL_CELLS }, (_, i) => {
        const raw = room.board?.[i];
        const owner: TeamColor = raw?.owner === 1 || raw?.owner === 2 ? raw.owner : 0;
        const val = typeof raw?.value === 'number' && raw.value >= 1 && raw.value <= 6 ? raw.value : 0;
        return { owner, value: owner === 0 ? 0 : (val as DieValue) };
      });

      const validMap = getReachableDestinations(boardCopy, fromIdx);
      const exactSteps = validMap.get(idx);
      if (exactSteps === undefined) return room;

      const { nextBoard, captured, splitLeft } = applyDittleMove(
        boardCopy,
        fromIdx,
        idx,
        exactSteps
      );

      room.board = nextBoard;
      room.lastMoveFromIdx = fromIdx;
      room.lastMoveToIdx = idx;

      const nextTeam: 1 | 2 = turnTeam === 1 ? 2 : 1;
      const stats = getTeamStats(nextBoard);
      const opponentDieCount = nextTeam === 1 ? stats.blackCount : stats.whiteCount;

      if (opponentDieCount === 0) {
        settleNetDittleRound(room, nextBoard, turnTeam, '상대 주사위를 모두 포획했습니다!');
        return room;
      }

      if (!hasAnyValidDittleMove(nextBoard, nextTeam)) {
        settleNetDittleRound(
          room,
          nextBoard,
          turnTeam,
          '상대 주사위의 이동 경로를 모두 봉쇄했습니다!'
        );
        return room;
      }

      const nextPlayer = room.players.find((p) => p.team === nextTeam);
      room.currentTurn = nextTeam;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;

      const actionDesc =
        splitLeft > 0
          ? `${formatCoord(fromIdx)}→${formatCoord(idx)} (${exactSteps} 이동 / ${splitLeft} 분할)`
          : `${formatCoord(fromIdx)}→${formatCoord(idx)} (${exactSteps}칸 이동)`;
      const capDesc = captured ? ' 💥상대 주사위 포획!' : '';

      room.turnNotice = `🎲 ${currentActor.name}: ${actionDesc}${capDesc} 👉 ${nextPlayer?.name}님 차례!`;
      return room;
    });

    playSound('dice');
  };

  /**
   * 넷게임 시간 초과 시 랜덤 유효 수 자동 실행
   */
  const handleNetTurnTimeout = async (room: NetDittleRoomData) => {
    const roomRef = ref(db, `dittle_rooms/room_${room.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const r = roomData as NetDittleRoomData;
      if (r.status !== 'PLAYING') return r;

      const turnTeam = r.currentTurn;
      const boardCopy: DittleCell[] = Array.from({ length: TOTAL_CELLS }, (_, i) => {
        const raw = r.board?.[i];
        const owner: TeamColor = raw?.owner === 1 || raw?.owner === 2 ? raw.owner : 0;
        const val = typeof raw?.value === 'number' && raw.value >= 1 && raw.value <= 6 ? raw.value : 0;
        return { owner, value: owner === 0 ? 0 : (val as DieValue) };
      });

      const candidates: { fromIdx: number; toIdx: number; steps: number }[] = [];
      for (let i = 0; i < TOTAL_CELLS; i++) {
        if (boardCopy[i].owner === turnTeam) {
          const destMap = getReachableDestinations(boardCopy, i);
          destMap.forEach((steps, toIdx) => {
            candidates.push({ fromIdx: i, toIdx, steps });
          });
        }
      }

      const nextTeam: 1 | 2 = turnTeam === 1 ? 2 : 1;
      if (candidates.length === 0) {
        settleNetDittleRound(r, boardCopy, nextTeam, '이동 가능한 주사위가 없어 패배했습니다.');
        return r;
      }

      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      const { nextBoard, captured } = applyDittleMove(
        boardCopy,
        pick.fromIdx,
        pick.toIdx,
        pick.steps
      );

      r.board = nextBoard;
      r.lastMoveFromIdx = pick.fromIdx;
      r.lastMoveToIdx = pick.toIdx;

      const stats = getTeamStats(nextBoard);
      const opponentDieCount = nextTeam === 1 ? stats.blackCount : stats.whiteCount;

      if (opponentDieCount === 0 || !hasAnyValidDittleMove(nextBoard, nextTeam)) {
        settleNetDittleRound(r, nextBoard, turnTeam, '시간 초과 자동 수로 승리를 확정했습니다!');
        return r;
      }

      const nextPlayer = r.players.find((p) => p.team === nextTeam);
      r.currentTurn = nextTeam;
      r.turnDeadline = Date.now() + r.baseTimeout * 1000;
      r.turnNotice = `⏰ 시간 초과 자동 이동(${formatCoord(pick.fromIdx)}→${formatCoord(
        pick.toIdx
      )}${captured ? ' · 포획!' : ''}) 👉 ${nextPlayer?.name}님 차례!`;
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
    const p1Name = soloName1.trim() || 'WADE';
    const p2Name = soloName2.trim() || 'DIANA';
    setSoloPlayers([
      {
        id: '1',
        name: p1Name,
        team: 1,
        chips: INITIAL_CHIPS,
        wins: 0,
        currentBet: 0,
        isEliminated: false,
      },
      {
        id: '2',
        name: p2Name,
        team: 2,
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
      { ...prev[1], team: 1 },
      { ...prev[0], team: 2 },
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

    const orderedPlayers =
      isNextRound && !isFreshMatch
        ? [
            { ...basePlayers[1], team: 1 as const },
            { ...basePlayers[0], team: 2 as const },
          ]
        : [
            { ...basePlayers[0], team: 1 as const },
            { ...basePlayers[1], team: 2 as const },
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

    triggerChipAnimation('전원', equalStake, '#6d4c41');
    const notice = `🎲 [${nextRound}국] 판돈 ${equalStake.toLocaleString()}칩 베팅! ⚫흑 주사위 ${preparedPlayers[0].name}님 선공입니다.`;

    setSoloRoundNum(nextRound);
    setSoloPot(totalPot);
    setSoloPlayers(preparedPlayers);
    setSoloBoard(createInitialDittleBoard());
    setSoloTurn(1);
    setSoloLastFromIdx(null);
    setSoloLastToIdx(null);
    setSelectedDieIdx(null);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setWinnerAnnouncement('');
    setShowFireworks(false);
    setTurnNotice(notice);
    speakKorean(notice);
    setGameState('PLAYING');
  };

  const settleSoloDittleRound = (
    finalBoard: DittleCell[],
    winnerTeam: 1 | 2,
    reasonText: string
  ) => {
    const { blackCount, whiteCount } = getTeamStats(finalBoard);
    const winner = soloPlayers.find((p) => p.team === winnerTeam) || soloPlayers[0];

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
      ? `👑 최종 우승! ${winner.name}님이 ${reasonText} (⚫${blackCount} : ⚪${whiteCount}) 상대 판돈을 모두 획득했습니다!`
      : `🎊 ${winner.name}님 승리! ${reasonText} (⚫${blackCount} : ⚪${whiteCount}) 판돈 ${soloPot.toLocaleString()}칩 독식! (${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}칩)`;

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

  const executeSoloMove = (
    fromIdx: number,
    toIdx: number,
    stepsUsed: number,
    isAuto = false
  ) => {
    const { nextBoard, captured, splitLeft } = applyDittleMove(
      soloBoard,
      fromIdx,
      toIdx,
      stepsUsed
    );

    playSound(captured ? 'capture' : 'dice');
    setSoloBoard(nextBoard);
    setSoloLastFromIdx(fromIdx);
    setSoloLastToIdx(toIdx);
    setSelectedDieIdx(null);

    const actor = soloPlayers.find((p) => p.team === soloTurn)!;
    const nextTeam: 1 | 2 = soloTurn === 1 ? 2 : 1;
    const stats = getTeamStats(nextBoard);
    const opponentDieCount = nextTeam === 1 ? stats.blackCount : stats.whiteCount;

    if (opponentDieCount === 0) {
      settleSoloDittleRound(nextBoard, soloTurn, '상대 주사위를 모두 포획했습니다!');
      return;
    }

    if (!hasAnyValidDittleMove(nextBoard, nextTeam)) {
      settleSoloDittleRound(
        nextBoard,
        soloTurn,
        '상대 주사위의 이동 경로를 모두 봉쇄했습니다!'
      );
      return;
    }

    const nextPlayer = soloPlayers.find((p) => p.team === nextTeam)!;
    setSoloTurn(nextTeam);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;

    const prefix = isAuto ? '⏰ 시간 초과 자동 이동! ' : '🎲 ';
    const actionDesc =
      splitLeft > 0
        ? `${formatCoord(fromIdx)}→${formatCoord(toIdx)} (${stepsUsed} 이동 / ${splitLeft} 분할)`
        : `${formatCoord(fromIdx)}→${formatCoord(toIdx)} (${stepsUsed}칸 이동)`;
    const capDesc = captured ? ' 💥상대 주사위 포획!' : '';
    const notice = `${prefix}${actor.name}: ${actionDesc}${capDesc} 👉 ${nextPlayer.name}님 차례!`;

    setTurnNotice(notice);
    speakKorean(notice);
  };

  const handleSoloCellClick = (idx: number) => {
    if (gameState !== 'PLAYING') return;
    const clickedCell = soloBoard[idx];

    // 자기 진영 주사위를 누른 경우: 선택 / 해제
    if (clickedCell.owner === soloTurn) {
      if (selectedDieIdx === idx) {
        setSelectedDieIdx(null);
      } else {
        const destMap = getReachableDestinations(soloBoard, idx);
        if (destMap.size === 0) {
          showToast('이 주사위는 이동할 수 있는 칸이 없습니다!', 'danger');
          return;
        }
        setSelectedDieIdx(idx);
      }
      return;
    }

    if (selectedDieIdx === null) {
      showToast('먼저 이동할 내 주사위를 클릭하세요!', 'info');
      return;
    }

    const destMap = getReachableDestinations(soloBoard, selectedDieIdx);
    const stepsUsed = destMap.get(idx);
    if (stepsUsed === undefined) {
      showToast('주사위 눈금 범위 내에서 직교 이동 가능한 칸만 선택할 수 있습니다!', 'danger');
      return;
    }

    executeSoloMove(selectedDieIdx, idx, stepsUsed, false);
  };

  // =========================================================================
  // 공용 UI 렌더링 헬퍼
  // 1) 세로 스크래블 타일 이름표 (차례 시 아래위로 둥둥 부유)
  // 2) 사진 속 초콜릿 월넛 6x6 오목 보드 & 흑/백 3D 주사위
  // =========================================================================
  const renderScrabbleNameRack = (player: DittlePlayer | undefined, isTurnActive: boolean) => {
    const rawName = (player?.name || 'PLAYER').toUpperCase();
    const chars = Array.from(rawName).slice(0, 8);

    return (
      <div
        className={`scrabble-name-rack ${
          isTurnActive ? 'active-turn-bobbing' : 'inactive-turn-rack'
        }`}
        aria-label={`${rawName} ${isTurnActive ? '현재 차례' : ''}`}
      >
        {chars.map((ch, idx) => (
          <div key={`${ch}-${idx}`} className="scrabble-letter-tile">
            <span>{ch}</span>
          </div>
        ))}
      </div>
    );
  };

  const renderDiceFace = (owner: TeamColor, value: DieValue | 0) => {
    if (owner === 0 || value === 0) return null;
    const pips = DIE_PIP_POSITIONS[value];

    return (
      <div className={`dittle-die ${owner === 1 ? 'black-die' : 'ivory-die'}`}>
        <div className="die-pip-grid">
          {Array.from({ length: 9 }, (_, cellIdx) => (
            <span
              key={cellIdx}
              className={`die-pip-slot ${pips.includes(cellIdx) ? 'has-pip' : ''}`}
            />
          ))}
        </div>
      </div>
    );
  };

  const renderDittleStage = (
    board: DittleCell[],
    activeTurn: 1 | 2,
    canInteract: boolean,
    leftPlayer: DittlePlayer | undefined,
    rightPlayer: DittlePlayer | undefined,
    lastFromIdx: number | null,
    lastToIdx: number | null,
    onCellClick: (idx: number) => void
  ) => {
    const reachableMap =
      canInteract && selectedDieIdx !== null
        ? getReachableDestinations(board, selectedDieIdx)
        : new Map<number, number>();

    return (
      <div className="dittle-photo-stage">
        {/* 좌측 세로 스크래블 타일 이름표 (흑 주사위 플레이어) */}
        {renderScrabbleNameRack(leftPlayer, canInteract && activeTurn === 1)}

        {/* 중앙 다크 초콜릿 월넛 6x6 오목 격자 보드 */}
        <div className="dittle-chocolate-board">
          <div className="dittle-grid-6x6">
            {board.map((cell, idx) => {
              const isSelected = canInteract && selectedDieIdx === idx;
              const moveSteps = reachableMap.get(idx);
              const isReachable = moveSteps !== undefined;
              const isOwnMovable =
                canInteract &&
                selectedDieIdx === null &&
                cell.owner === activeTurn &&
                getReachableDestinations(board, idx).size > 0;
              const isLastFrom = lastFromIdx === idx;
              const isLastTo = lastToIdx === idx;
              const isCaptureTarget = isReachable && cell.owner !== 0 && cell.owner !== activeTurn;

              return (
                <button
                  key={idx}
                  type="button"
                  disabled={!canInteract}
                  onClick={() => onCellClick(idx)}
                  className={[
                    'dittle-recessed-cell',
                    isSelected ? 'die-selected' : '',
                    isReachable && showMoveHints ? 'cell-reachable' : '',
                    isCaptureTarget && showMoveHints ? 'cell-capture-target' : '',
                    isOwnMovable ? 'own-die-ready' : '',
                    isLastFrom ? 'cell-last-from' : '',
                    isLastTo ? 'cell-last-to' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-label={`${formatCoord(idx)} 칸`}
                >
                  {renderDiceFace(cell.owner, cell.value)}

                  {/* 이동 가능 칸 가이드 & 소요 눈금 배지 */}
                  {isReachable && showMoveHints && (
                    <span
                      className={`move-step-badge ${
                        isCaptureTarget ? 'capture-badge' : ''
                      }`}
                    >
                      {isCaptureTarget ? `💥${moveSteps}` : moveSteps}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* 우측 세로 스크래블 타일 이름표 (백 주사위 플레이어) */}
        {renderScrabbleNameRack(rightPlayer, canInteract && activeTurn === 2)}
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
      <div className="dtl-container">
        <div className="setup-card home-entry-card">
          <div className="home-castle-icon">🎲🪵🎲</div>
          <h1 className="setup-title">DITTLE (디틀 보드게임)</h1>
          <p className="home-subtitle">
            주사위 눈금 이동 · 전략적 분할(Split) &amp; 포획(Capture) · 동일 판돈 승자 독식
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
              <span className="mode-desc">실시간 4개 Dittle 테이블 대전 &amp; 관전</span>
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
      <div className="dtl-container" style={{ padding: '16px' }}>
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
            <h2 style={{ margin: 0, color: '#3e2723' }}>🏅 Dittle 명예의 전당</h2>
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
      <div className="dtl-container">
        <div className="net-lobby-container">
          <div className="net-lobby-header">
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, fontSize: '20px', color: '#3e2723' }}>
              🌐 Dittle 넷게임 (4개 대국실)
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
                    <span className="room-number-title">🎲 제 {room.roomId} Dittle실</span>
                    <span className={`room-status-pill ${statusClass}`}>{statusBadgeText}</span>
                  </div>

                  <div className="room-rules-info">
                    <span>💰 동일 판돈: {room.anteBet.toLocaleString()}칩</span>
                    <span>⏱️ 이동 제한: {room.baseTimeout}초</span>
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
                              className={`mini-die-icon ${p.team === 1 ? 'black' : 'ivory'}`}
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
              <h2 style={{ margin: '0 0 8px' }}>🎲 제 {joinModalRoom.roomId} Dittle실 입장</h2>
              <p className="modal-subtext">
                동일 판돈 <strong>{joinModalRoom.anteBet.toLocaleString()}칩</strong>을 걸고 1:1
                Dittle 대국이 진행됩니다.
              </p>

              <input
                type="text"
                className="player-input"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: '14px' }}
                placeholder="대국자 영문/한글 이름 (예: WADE)"
                maxLength={10}
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
          className="dtl-container"
          style={{
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
        <div className="dtl-container">
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
              🎲 Dittle 대기실 {amISpectator ? '👀 [관전모드]' : ''}
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
                ⏱️ 이동 제한시간: <strong>{activeNetRoom.baseTimeout}초</strong>{' '}
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
                      <span
                        className={`mini-die-icon large ${p.team === 1 ? 'black' : 'ivory'}`}
                      />
                      {p.name} ({p.team === 1 ? '⚫흑 주사위 · 좌측' : '⚪백 주사위 · 우측'}){' '}
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
              🚀 Dittle 대국 시작! (전원 {activeNetRoom.anteBet.toLocaleString()}칩 동일 베팅)
            </button>
          </div>
        </div>
      );
    }

    const netStats = getTeamStats(activeNetRoom.board);
    const leftNetPlayer = roomPlayers.find((p) => p.team === 1) || roomPlayers[0];
    const rightNetPlayer = roomPlayers.find((p) => p.team === 2) || roomPlayers[1];
    const activeTurnPlayer = roomPlayers.find((p) => p.team === activeNetRoom.currentTurn);
    const isMyTurn =
      activeNetRoom.status === 'PLAYING' &&
      activeTurnPlayer?.id === mySessionId &&
      !amISpectator;
    const isRoundEnded =
      activeNetRoom.status === 'ROUND_OVER' || activeNetRoom.status === 'MATCH_OVER';

    return (
      <div className="dtl-container">
        {renderFireworksAndChips()}

        {toast && (
          <div key={toast.id} className={`dtl-toast ${toast.type}`}>
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
                  activeNetRoom.status === 'PLAYING' && p.team === activeNetRoom.currentTurn;
                const dieCnt = p.team === 1 ? netStats.blackCount : netStats.whiteCount;
                const pipSum = p.team === 1 ? netStats.blackPips : netStats.whitePips;
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${
                      isActive ? 'active-turn-spotlight' : 'active-turn-unlight'
                    }`}
                  >
                    <div className="player-badge-top">
                      <span className={`mini-die-icon ${p.team === 1 ? 'black' : 'ivory'}`} />
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {p.name}
                        {p.id === mySessionId ? '(나)' : ''}
                      </strong>
                      <span className="disc-score-pill">
                        {dieCnt}개({pipSum})
                      </span>
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
                onClick={() => setShowMoveHints((v) => !v)}
                title="이동 가능 경로 힌트 켜기/끄기"
              >
                {showMoveHints ? '💡' : '🕶️'}
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

          {/* 중앙 매트 블랙 Dittle 테이블 스테이지 */}
          <div className="dtl-table-board">
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
                      : `🔥 다음 대국 시작 (진영 교대 · ${activeNetRoom.anteBet.toLocaleString()}칩)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={activeNetRoom.turnNotice} className="dtl-notice-banner">
                {activeNetRoom.turnNotice}
              </div>
            )}

            {/* 판돈 및 실시간 주사위/눈금 스코어보드 */}
            <div className="dtl-scoreboard-strip">
              <div className="score-side black-side">
                <span className="mini-die-icon large black" />
                <span>흑 주사위</span>
                <strong>
                  {netStats.blackCount}개 <small>({netStats.blackPips})</small>
                </strong>
              </div>

              <div className="center-pot-box">
                <span className="pot-label">💰 누적 POT</span>
                <strong className="pot-amount">
                  {(activeNetRoom.pot || 0).toLocaleString()} 칩
                </strong>
              </div>

              <div className="score-side white-side">
                <strong>
                  {netStats.whiteCount}개 <small>({netStats.whitePips})</small>
                </strong>
                <span>백 주사위</span>
                <span className="mini-die-icon large ivory" />
              </div>
            </div>

            {/* 사진 구도: 좌측 세로 이름표 + 중앙 초콜릿 보드 + 우측 세로 이름표 */}
            <div className="board-center-stage">
              {renderDittleStage(
                activeNetRoom.board,
                activeNetRoom.currentTurn,
                isMyTurn,
                leftNetPlayer,
                rightNetPlayer,
                activeNetRoom.lastMoveFromIdx,
                activeNetRoom.lastMoveToIdx,
                handleNetCellClick
              )}
            </div>
          </div>

          {/* 하단 조작 도크 */}
          <div className="dtl-bottom-dock">
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
                  {activeNetRoom.currentTurn === 1 ? '⚫ 흑 주사위' : '⚪ 백 주사위'}{' '}
                  {activeTurnPlayer?.name}님 차례
                  {isMyTurn
                    ? selectedDieIdx !== null
                      ? ' · 이동할 목적지 칸을 선택하세요 (눈금보다 적게 가면 분할!)'
                      : ' · 이동할 내 주사위를 클릭하세요!'
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
  // 5. 단독게임(SOLO) - 2인 로컬 Dittle 대국
  // =========================================================================
  const soloStats = getTeamStats(soloBoard);
  const leftSoloPlayer = soloPlayers.find((p) => p.team === 1) || soloPlayers[0];
  const rightSoloPlayer = soloPlayers.find((p) => p.team === 2) || soloPlayers[1];
  const currentSoloPlayer = soloPlayers.find((p) => p.team === soloTurn) || soloPlayers[0];
  const isSoloEnded = gameState === 'ROUND_OVER' || gameState === 'MATCH_OVER';

  return (
    <div className="dtl-container">
      {renderFireworksAndChips()}

      {toast && (
        <div key={toast.id} className={`dtl-toast ${toast.type}`}>
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
          <h1 className="setup-title">🎲 DITTLE 보드게임 (단독게임 설정)</h1>

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
            <label className="setting-label">
              🧭 대국자 이름 설정 (보드 좌/우 스크래블 타일 표시 · 최대 8글자 권장)
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="player-item-a">
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="mini-die-icon large black" />
                  <span>좌측 선공 (흑)</span>
                </span>
                <input
                  type="text"
                  className="player-input"
                  style={{ maxWidth: '200px', padding: '6px 10px' }}
                  maxLength={10}
                  value={soloName1}
                  onChange={(e) => setSoloName1(e.target.value)}
                  placeholder="예: WADE"
                />
              </div>

              <div className="player-item-a">
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="mini-die-icon large ivory" />
                  <span>우측 후공 (백)</span>
                </span>
                <input
                  type="text"
                  className="player-input"
                  style={{ maxWidth: '200px', padding: '6px 10px' }}
                  maxLength={10}
                  value={soloName2}
                  onChange={(e) => setSoloName2(e.target.value)}
                  placeholder="예: DIANA"
                />
              </div>
            </div>
          </div>

          <button type="button" className="btn btn-success" onClick={goToSoloReady}>
            ➡️ 진영 및 선공 확인하러 가기
          </button>
        </div>
      )}

      {gameState === 'READY' && (
        <div className="order-panel">
          <div className="order-header">
            <h2 style={{ margin: 0, fontSize: '20px', color: '#3e2723' }}>
              📋 흑/백 주사위 배정을 확인하세요
            </h2>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: '8px 14px', fontSize: '13px' }}
              onClick={swapSoloOrder}
            >
              🔄 좌/우 진영 맞바꾸기
            </button>
          </div>

          <div className="order-list">
            {soloPlayers.map((player) => (
              <div key={player.id} className="order-item">
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span
                    className={`mini-die-icon large ${player.team === 1 ? 'black' : 'ivory'}`}
                  />
                  <strong>
                    {player.team === 1 ? '선공 (⚫ 좌측 흑 주사위)' : '후공 (⚪ 우측 백 주사위)'}
                  </strong>
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
                const isActive = !isSoloEnded && p.team === soloTurn;
                const dieCnt = p.team === 1 ? soloStats.blackCount : soloStats.whiteCount;
                const pipSum = p.team === 1 ? soloStats.blackPips : soloStats.whitePips;
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${
                      isActive ? 'active-turn-spotlight' : 'active-turn-unlight'
                    }`}
                  >
                    <div className="player-badge-top">
                      <span className={`mini-die-icon ${p.team === 1 ? 'black' : 'ivory'}`} />
                      <strong className={isActive ? 'turn-hero-name' : ''}>{p.name}</strong>
                      <span className="disc-score-pill">
                        {dieCnt}개({pipSum})
                      </span>
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
                onClick={() => setShowMoveHints((v) => !v)}
                title="이동 가능 경로 힌트 켜기/끄기"
              >
                {showMoveHints ? '💡' : '🕶️'}
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

          {/* 중앙 매트 블랙 Dittle 보드 스테이지 */}
          <div className="dtl-table-board">
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
                      : `🔥 다음 대국 시작 (진영 교대 · ${soloAnteBet.toLocaleString()}칩)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={turnNotice} className="dtl-notice-banner">
                {turnNotice}
              </div>
            )}

            {/* 판돈 및 실시간 주사위/눈금 카운터 */}
            <div className="dtl-scoreboard-strip">
              <div className="score-side black-side">
                <span className="mini-die-icon large black" />
                <span>흑 주사위</span>
                <strong>
                  {soloStats.blackCount}개 <small>({soloStats.blackPips})</small>
                </strong>
              </div>

              <div className="center-pot-box">
                <span className="pot-label">💰 누적 POT</span>
                <strong className="pot-amount">{soloPot.toLocaleString()} 칩</strong>
              </div>

              <div className="score-side white-side">
                <strong>
                  {soloStats.whiteCount}개 <small>({soloStats.whitePips})</small>
                </strong>
                <span>백 주사위</span>
                <span className="mini-die-icon large ivory" />
              </div>
            </div>

            {/* 사진 구도: 좌측 세로 이름표 + 중앙 초콜릿 보드 + 우측 세로 이름표 */}
            <div className="board-center-stage">
              {renderDittleStage(
                soloBoard,
                soloTurn,
                gameState === 'PLAYING',
                leftSoloPlayer,
                rightSoloPlayer,
                soloLastFromIdx,
                soloLastToIdx,
                handleSoloCellClick
              )}
            </div>
          </div>

          {/* 하단 상태 도크 */}
          <div className="dtl-bottom-dock">
            <div className="dock-top-status">
              {isSoloEnded ? (
                <span className="waiting-dock-msg">
                  🎉 대국 종료! <strong>[다음 대국 시작]</strong>을 눌러 진영을 교대해 계속
                  대국하세요!
                </span>
              ) : (
                <span className="turn-owner-pill large-turn-pill">
                  {soloTurn === 1 ? '⚫ 흑 주사위' : '⚪ 백 주사위'} {currentSoloPlayer.name}님
                  차례 ·{' '}
                  {selectedDieIdx !== null
                    ? '도착 칸 클릭 (눈금보다 적게 이동 시 자동 분할)'
                    : '이동할 내 주사위를 클릭하세요'}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}