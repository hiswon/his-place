import React, { useState, useRef, useEffect, useCallback } from 'react';
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
import './Page8.css';

// 방향: [상(Top), 우(Right), 하(Bottom), 좌(Left)] (true = 터널 길, false = 벽)
type Openings = [boolean, boolean, boolean, boolean];

interface TileDef {
  id: string;
  openings: Openings;
  isDeadEnd?: boolean; // 막다른 길(손전등/바위) 여부
  isStart?: boolean;   // 중앙 반디도 감옥 카드 여부
  label?: string;
}

interface PlacedTile {
  x: number;
  y: number;
  openings: Openings;
  isDeadEnd?: boolean;
  isStart?: boolean;
  placedBy?: string;
}

interface BandidoPlayer {
  id: string;
  name: string;
  badgeColor: string;
  hand: TileDef[];
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

interface NetBandidoRoomData {
  roomId: number;
  status: 'EMPTY' | 'WAITING' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER';
  players: BandidoPlayer[];
  pot: number;
  waitlist: WaitlistPlayer[];
  spectators: SpectatorPlayer[];
  baseTimeout: number;
  anteBet: number;
  difficulty: 'NORMAL' | 'HARD'; // NORMAL: 5출구, HARD: 6출구(악몽)
  roundNumber: number;
  deck: TileDef[];
  board: PlacedTile[];
  openExitsCount: number;
  currentPlayerIdx: number;
  turnDeadline: number | null;
  turnNotice: string;
  winnerAnnouncement: string;
  isVictory: boolean;
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

const PLAYER_BG_COLORS = [
  'linear-gradient(135deg, #fef3c7 0%, #ffedd5 50%, #fef9c3 100%)',
  'linear-gradient(135deg, #e0f2fe 0%, #f0f9ff 50%, #faf5ff 100%)',
  'linear-gradient(135deg, #dcfce7 0%, #f0fdf4 50%, #fef9c3 100%)',
  'linear-gradient(135deg, #fee2e2 0%, #fef3c7 50%, #f0fdf4 100%)',
];

const PIECE_COLORS = ['#dc2626', '#2563eb', '#059669', '#d97706'];
const INITIAL_CHIPS = 10000;
const DEFAULT_TIMEOUT_SEC = 60;

function getShortName(name: string): string {
  const trimmed = name ? name.trim() : '';
  return trimmed ? trimmed.slice(0, 2) : '?';
}

/**
 * 타일 90도 시계방향 회전
 */
function rotateOpenings(openings: Openings, times = 1): Openings {
  let curr: Openings = [...openings];
  const steps = ((times % 4) + 4) % 4;
  for (let i = 0; i < steps; i++) {
    curr = [curr[3], curr[0], curr[1], curr[2]];
  }
  return curr;
}

/**
 * 반디도 터널 카드 덱 생성 (42장 구성)
 */
function createBandidoDeck(): TileDef[] {
  const blueprints: { openings: Openings; count: number; isDeadEnd?: boolean; label: string }[] = [
    // 막다른 길 (터널을 막는 핵심 카드)
    { openings: [true, false, false, false], count: 8, isDeadEnd: true, label: '막다른 길' },
    // 직선 통로
    { openings: [true, false, true, false], count: 7, label: '직선 통로' },
    // L자 커브
    { openings: [true, true, false, false], count: 9, label: '코너 통로' },
    // T자 삼거리
    { openings: [true, true, true, false], count: 10, label: 'T자 분기' },
    // 십자(+) 사거리
    { openings: [true, true, true, true], count: 5, label: '십자 분기' },
  ];

  const deck: TileDef[] = [];
  let seq = 1;
  for (const bp of blueprints) {
    for (let i = 0; i < bp.count; i++) {
      const randomRot = Math.floor(Math.random() * 4);
      deck.push({
        id: `tile_${seq++}_${Math.random().toString(36).slice(2, 5)}`,
        openings: rotateOpenings(bp.openings, randomRot),
        isDeadEnd: bp.isDeadEnd,
        label: bp.label,
      });
    }
  }

  // Fisher-Yates 셔플
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * 시작 감옥 타일 생성 (중앙 2칸 크기: (0,0)과 (1,0))
 * - NORMAL: 5개 출구
 * - HARD: 6개 출구
 */
function createInitialPrisonBoard(difficulty: 'NORMAL' | 'HARD'): PlacedTile[] {
  const leftTile: PlacedTile = {
    x: 0,
    y: 0,
    // 상(true), 우(true-내부연결), 하(true), 좌(true) -> 외부 출구 3개
    openings: [true, true, true, true],
    isStart: true,
    placedBy: '감옥',
  };
  const rightTile: PlacedTile = {
    x: 1,
    y: 0,
    // NORMAL: 상(true), 우(true), 하(false), 좌(true-내부연결) -> 외부 출구 2개 (총 5출구)
    // HARD: 상(true), 우(true), 하(true), 좌(true-내부연결) -> 외부 출구 3개 (총 6출구)
    openings: [true, true, difficulty === 'HARD', true],
    isStart: true,
    placedBy: '감옥',
  };
  return [leftTile, rightTile];
}

/**
 * 현재 보드에서 아직 막히지 않고 열려있는 터널 출구 수 계산
 */
function countOpenExits(board: PlacedTile[]): number {
  const map = new Map<string, PlacedTile>();
  for (const t of board) {
    map.set(`${t.x},${t.y}`, t);
  }

  let openCount = 0;
  const dirs: [number, number, number][] = [
    [0, -1, 0], // Top
    [1, 0, 1],  // Right
    [0, 1, 2],  // Bottom
    [-1, 0, 3], // Left
  ];

  for (const tile of board) {
    for (const [dx, dy, dirIdx] of dirs) {
      if (tile.openings[dirIdx]) {
        const neighbor = map.get(`${tile.x + dx},${tile.y + dy}`);
        if (!neighbor) {
          openCount++;
        }
      }
    }
  }
  return openCount;
}

/**
 * 특정 좌표 (x, y)에 해당 openings를 가진 타일을 놓을 수 있는지 엄격 검증
 * 1) 빈 칸이어야 함
 * 2) 최소 1개 이상의 기존 타일과 인접해야 함
 * 3) 인접한 모든 면에서 (길<->길) 또는 (벽<->벽)이 정확히 일치해야 함
 * 4) 인접한 면 중 최소 1곳은 실제 터널(길)로 연결되어야 함
 */
function canPlaceTileAt(
  board: PlacedTile[],
  x: number,
  y: number,
  openings: Openings
): { valid: boolean; reason?: string } {
  const map = new Map<string, PlacedTile>();
  for (const t of board) {
    map.set(`${t.x},${t.y}`, t);
  }

  if (map.has(`${x},${y}`)) {
    return { valid: false, reason: '이미 타일이 놓여 있는 자리입니다.' };
  }

  const dirs: [number, number, number, number][] = [
    [0, -1, 0, 2], // 내 Top(0) <-> 위쪽 타일의 Bottom(2)
    [1, 0, 1, 3],  // 내 Right(1) <-> 오른쪽 타일의 Left(3)
    [0, 1, 2, 0],  // 내 Bottom(2) <-> 아래쪽 타일의 Top(0)
    [-1, 0, 3, 1], // 내 Left(3) <-> 왼쪽 타일의 Right(1)
  ];

  let hasNeighbor = false;
  let hasTunnelConnection = false;

  for (const [dx, dy, myDir, oppDir] of dirs) {
    const neighbor = map.get(`${x + dx},${y + dy}`);
    if (neighbor) {
      hasNeighbor = true;
      const myOpen = openings[myDir];
      const neighborOpen = neighbor.openings[oppDir];
      if (myOpen !== neighborOpen) {
        return { valid: false, reason: '인접한 터널 통로와 벽 모양이 일치하지 않습니다.' };
      }
      if (myOpen && neighborOpen) {
        hasTunnelConnection = true;
      }
    }
  }

  if (!hasNeighbor || !hasTunnelConnection) {
    return { valid: false, reason: '기존에 열려 있는 터널 출구와 연결해야 합니다.' };
  }

  return { valid: true };
}

/**
 * 현재 보드에서 배치 가능한 후보 좌표(열린 출구 인접 빈 칸) 목록 반환
 */
function getCandidatePositions(board: PlacedTile[]): { x: number; y: number }[] {
  const occupied = new Set<string>(board.map((t) => `${t.x},${t.y}`));
  const candidates = new Map<string, { x: number; y: number }>();

  const dirs: [number, number, number][] = [
    [0, -1, 0],
    [1, 0, 1],
    [0, 1, 2],
    [-1, 0, 3],
  ];

  for (const tile of board) {
    for (const [dx, dy, dirIdx] of dirs) {
      if (tile.openings[dirIdx]) {
        const nx = tile.x + dx;
        const ny = tile.y + dy;
        const key = `${nx},${ny}`;
        if (!occupied.has(key)) {
          candidates.set(key, { x: nx, y: ny });
        }
      }
    }
  }
  return Array.from(candidates.values());
}

function getNextAlivePlayerIdx(players: BandidoPlayer[], currentIdx: number): number {
  const total = players.length;
  if (total === 0) return 0;
  for (let step = 1; step <= total; step++) {
    const candidate = (currentIdx + step) % total;
    if (!players[candidate].isEliminated) {
      return candidate;
    }
  }
  return currentIdx;
}

function createDefaultBandidoRoom(roomId: number): NetBandidoRoomData {
  return {
    roomId,
    status: 'EMPTY',
    players: [],
    pot: 0,
    waitlist: [],
    spectators: [],
    baseTimeout: DEFAULT_TIMEOUT_SEC,
    anteBet: 1000,
    difficulty: 'NORMAL',
    roundNumber: 1,
    deck: [],
    board: [],
    openExitsCount: 5,
    currentPlayerIdx: 0,
    turnDeadline: null,
    turnNotice: '',
    winnerAnnouncement: '',
    isVictory: false,
    waitingSince: null,
  };
}

export default function Page8() {
  const [appMode, setAppMode] = useState<
    'HOME' | 'SOLO' | 'NET_LOBBY' | 'NET_ROOM' | 'HALL_OF_FAME'
  >('HOME');

  const [mySessionId] = useState<string>(() => {
    const saved = sessionStorage.getItem('bandido_net_uid');
    if (saved) return saved;
    const generated = `bd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('bandido_net_uid', generated);
    return generated;
  });

  // 넷게임 상태
  const [rooms, setRooms] = useState<NetBandidoRoomData[]>(
    [1, 2, 3, 4].map(createDefaultBandidoRoom)
  );
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [joinModalRoom, setJoinModalRoom] = useState<NetBandidoRoomData | null>(null);
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
  const [players, setPlayers] = useState<BandidoPlayer[]>([
    {
      id: '1',
      name: '보안관',
      badgeColor: PIECE_COLORS[0],
      hand: [],
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
    },
    {
      id: '2',
      name: '부보안관',
      badgeColor: PIECE_COLORS[1],
      hand: [],
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
    },
    {
      id: '3',
      name: '추적자',
      badgeColor: PIECE_COLORS[2],
      hand: [],
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
    },
  ]);

  const [inputName, setInputName] = useState('');
  const [soloAnteBet, setSoloAnteBet] = useState<number>(1000);
  const [soloDifficulty, setSoloDifficulty] = useState<'NORMAL' | 'HARD'>('NORMAL');
  const [soloTimeoutSec, setSoloTimeoutSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRemainingSec, setSoloRemainingSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRoundNum, setSoloRoundNum] = useState<number>(1);
  const [soloPot, setSoloPot] = useState<number>(0);

  const [deck, setDeck] = useState<TileDef[]>([]);
  const [board, setBoard] = useState<PlacedTile[]>([]);
  const [selectedHandIdx, setSelectedHandIdx] = useState<number>(0);
  const [selectedRotation, setSelectedRotation] = useState<number>(0);
  const [currentPlayerIdx, setCurrentPlayerIdx] = useState<number>(0);
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

  const playSound = (kind: 'place' | 'rotate' | 'pass' | 'chip' | 'win' | 'lose' | 'tick') => {
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
        place: [440, 659.25],
        rotate: [587.33],
        pass: [523.25, 392.0],
        chip: [880, 1174.66],
        win: [523.25, 659.25, 783.99, 1046.5, 1318.5],
        lose: [392.0, 349.23, 311.13, 261.63],
        tick: [987.77],
      };

      notesMap[kind].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === 'lose' ? 'sawtooth' : 'triangle';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.07);
        gain.gain.setValueAtTime(kind === 'tick' ? 0.18 : 0.14, ctx.currentTime + idx * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.07 + 0.22);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.07);
        osc.stop(ctx.currentTime + idx * 0.07 + 0.22);
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

  const triggerEndCelebration = (announcementText: string, victory: boolean) => {
    playSound(victory ? 'win' : 'lose');
    speakKorean(announcementText);
    if (victory) {
      setShowFireworks(true);
      window.setTimeout(() => {
        setShowFireworks(false);
      }, 4500);
    }
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
    const key = type === 'SOLO' ? 'bandido_hof_solo' : 'bandido_hof_net';
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
    const key = type === 'SOLO' ? 'bandido_hof_solo' : 'bandido_hof_net';
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      return [];
    }
  };

  // =========================================================================
  // 방 나가기 공통 처리 (버튼 클릭 & 브라우저 창 닫기)
  // =========================================================================
  const leaveRoomById = useCallback(
    async (roomIdToLeave: number) => {
      const roomRef = ref(db, `bandido_rooms/room_${roomIdToLeave}`);
      try {
        await runTransaction(roomRef, (roomData) => {
          if (!roomData) return roomData;
          const room = roomData as NetBandidoRoomData;
          const filteredPlayers = (room.players || []).filter((p) => p.id !== mySessionId);
          const filteredWaitlist = (room.waitlist || []).filter((w) => w.id !== mySessionId);
          const filteredSpectators = (room.spectators || []).filter((s) => s.id !== mySessionId);

          if (filteredPlayers.length === 0 && filteredSpectators.length === 0) {
            return createDefaultBandidoRoom(room.roomId);
          }

          let nextIdx = room.currentPlayerIdx || 0;
          if (filteredPlayers.length > 0) {
            nextIdx = nextIdx % filteredPlayers.length;
            if (filteredPlayers[nextIdx]?.isEliminated) {
              nextIdx = getNextAlivePlayerIdx(filteredPlayers, nextIdx);
            }
          } else {
            nextIdx = 0;
          }

          room.players = filteredPlayers;
          room.waitlist = filteredWaitlist;
          room.spectators = filteredSpectators;
          room.currentPlayerIdx = nextIdx;

          if (filteredPlayers.length < 2 && room.status === 'PLAYING') {
            room.status = 'WAITING';
            room.turnNotice = '⚠️ 팀원이 퇴장하여 대기 상태로 전환되었습니다.';
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

    const presenceRef = ref(db, `bandido_presence/room_${selectedRoomId}/${mySessionId}`);
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
        const roomRef = ref(db, `bandido_rooms/room_${id}`);
        const snap = await get(roomRef);
        if (!snap.exists()) {
          await set(roomRef, createDefaultBandidoRoom(id));
        }
      }
    };
    ensureRoomsExist();

    const roomsRef = ref(db, 'bandido_rooms');
    const unsubscribe = onValue(roomsRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      const loadedRooms: NetBandidoRoomData[] = [1, 2, 3, 4].map((id) => {
        const rData = data[`room_${id}`];
        const def = createDefaultBandidoRoom(id);
        if (!rData) return def;
        return {
          ...def,
          ...rData,
          players: (rData.players || []).map((p: BandidoPlayer) => ({
            ...p,
            hand: p.hand || [],
            chips: typeof p.chips === 'number' ? p.chips : INITIAL_CHIPS,
            wins: typeof p.wins === 'number' ? p.wins : 0,
            currentBet: typeof p.currentBet === 'number' ? p.currentBet : 0,
            isEliminated: Boolean(p.isEliminated),
          })),
          pot: typeof rData.pot === 'number' ? rData.pot : 0,
          waitlist: rData.waitlist || [],
          spectators: rData.spectators || [],
          deck: rData.deck || [],
          board: rData.board || [],
          openExitsCount: typeof rData.openExitsCount === 'number' ? rData.openExitsCount : 5,
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
      triggerEndCelebration(activeNetRoom.winnerAnnouncement, activeNetRoom.isVictory);
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
    activeNetRoom?.isVictory,
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
          const roomRef = ref(db, `bandido_rooms/room_${activeNetRoom.roomId}`);
          await set(roomRef, createDefaultBandidoRoom(activeNetRoom.roomId));
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

  useEffect(() => {
    if (appMode !== 'SOLO' || gameState !== 'PLAYING') {
      return;
    }

    const timer = window.setInterval(() => {
      setSoloRemainingSec((prev) => {
        const next = Math.max(0, prev - 1);
        handleCountdownCue(next);
        if (next === 0) {
          handleSoloPassAndSwapHand();
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [appMode, gameState, currentPlayerIdx, soloTimeoutSec, players, deck, board]);

  const handleEnterRoomSubmit = async (asSpectator = false) => {
    if (!joinModalRoom) return;
    const trimmedName = joinPlayerName ? joinPlayerName.trim() : '';
    if (!trimmedName) {
      alert('참가할 이름을 입력해주세요!');
      return;
    }

    const roomRef = ref(db, `bandido_rooms/room_${joinModalRoom.roomId}`);

    try {
      let joinResultType = 'PLAYER';

      await runTransaction(roomRef, (roomData) => {
        const room: NetBandidoRoomData =
          roomData || createDefaultBandidoRoom(joinModalRoom.roomId);
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

        if ((room.status === 'EMPTY' || room.status === 'WAITING') && room.players.length < 4) {
          const idx = room.players.length;
          const newPlayer: BandidoPlayer = {
            id: mySessionId,
            name: trimmedName,
            badgeColor: PIECE_COLORS[idx],
            hand: [],
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
      setSelectedHandIdx(0);
      setSelectedRotation(0);
      setAppMode('NET_ROOM');

      if (joinResultType === 'SPECTATOR') {
        showToast('👀 관망모드로 입장했습니다! 각 플레이어의 손패는 비공개 보호됩니다.', 'info');
      } else if (joinResultType === 'WAITLIST') {
        showToast('⏳ 다음 작전 예약자로 등록되었습니다!', 'info');
      }
    } catch (err) {
      console.error(err);
      alert('방 입장 중 오류가 발생했습니다.');
    }
  };

  const updateRoomSettings = async (
    newAnteBet: number,
    newTimeout: number,
    newDifficulty: 'NORMAL' | 'HARD'
  ) => {
    if (!activeNetRoom) return;
    const clampedTimeout = Math.min(180, Math.max(20, newTimeout));
    const roomRef = ref(db, `bandido_rooms/room_${activeNetRoom.roomId}`);
    await update(roomRef, {
      anteBet: newAnteBet,
      baseTimeout: clampedTimeout,
      difficulty: newDifficulty,
      waitingSince: Date.now(),
    });
  };

  /**
   * 넷게임 라운드 시작
   */
  const handleStartNetRound = async (isNextRound = false) => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `bandido_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetBandidoRoomData;
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
      const eliminatedPlayers = basePlayers.filter((p) => p.isEliminated);

      const waitlist = [...room.waitlist];
      const nextActive: BandidoPlayer[] = [...survivingPlayers];
      const remainingWaitlist: WaitlistPlayer[] = [];

      for (const w of waitlist) {
        if (nextActive.length + eliminatedPlayers.length < 4) {
          nextActive.push({
            id: w.id,
            name: w.name,
            badgeColor: PIECE_COLORS[0],
            hand: [],
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
        room.players = [...nextActive, ...eliminatedPlayers];
        room.waitlist = remainingWaitlist;
        return room;
      }

      const equalStake = Math.min(ante, ...nextActive.map((p) => p.chips));
      let collectedPot = isNewMatch ? 0 : room.pot || 0;
      const deckCopy = createBandidoDeck();

      const activeWithBet = nextActive.map((p) => {
        collectedPot += equalStake;
        const hand = deckCopy.splice(0, 3);
        return {
          ...p,
          hand,
          chips: p.chips - equalStake,
          currentBet: equalStake,
          isEliminated: false,
        };
      });

      const mergedPlayers = [...activeWithBet, ...eliminatedPlayers].map((p, idx) => ({
        ...p,
        badgeColor: PIECE_COLORS[idx % PIECE_COLORS.length],
      }));

      const initialBoard = createInitialPrisonBoard(room.difficulty || 'NORMAL');
      const openExits = countOpenExits(initialBoard);

      room.status = 'PLAYING';
      room.roundNumber = nextRound;
      room.players = mergedPlayers;
      room.pot = collectedPot;
      room.waitlist = remainingWaitlist;
      room.deck = deckCopy;
      room.board = initialBoard;
      room.openExitsCount = openExits;
      room.currentPlayerIdx = 0;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.winnerAnnouncement = '';
      room.isVictory = false;
      room.turnNotice = `🚨 [${nextRound}라운드] 전원 동일 판돈 ${equalStake.toLocaleString()}칩 베팅! 열려있는 탈출구 ${openExits}개를 모두 봉쇄하세요! 👉 ${mergedPlayers[0].name}님 차례`;
      room.waitingSince = null;

      return room;
    });

    setSelectedHandIdx(0);
    setSelectedRotation(0);
    triggerChipAnimation('전원', activeNetRoom.anteBet, '#f59e0b');
  };

  /**
   * 넷게임 라운드 승패 정산
   */
  const settleNetBandidoRound = (room: NetBandidoRoomData, victory: boolean) => {
    const alivePlayers = room.players.filter((p) => !p.isEliminated);
    const wonPot = room.pot || 0;
    const sharePerPlayer =
      victory && alivePlayers.length > 0 ? Math.floor(wonPot / alivePlayers.length) : 0;

    room.players = room.players.map((p) => {
      if (p.isEliminated) return p;
      const updatedChips = victory ? p.chips + sharePerPlayer : p.chips;
      const busted = updatedChips <= 0;
      return {
        ...p,
        chips: updatedChips,
        wins: victory ? (p.wins || 0) + 1 : p.wins || 0,
        isEliminated: busted,
      };
    });

    const remainingAlive = room.players.filter((p) => !p.isEliminated);
    const bustedNames = room.players.filter((p) => p.isEliminated).map((p) => p.name);
    const bustText =
      bustedNames.length > 0 ? ` · 💀 ${bustedNames.join(', ')}님 판돈 소진 아웃!` : '';

    room.pot = 0;
    room.turnDeadline = null;
    room.turnNotice = '';
    room.isVictory = victory;

    if (remainingAlive.length < 2) {
      room.status = 'MATCH_OVER';
      room.winnerAnnouncement = victory
        ? `🎉 반디도 검거 성공! 상금 ${wonPot.toLocaleString()}칩을 나눠 가졌습니다!${bustText}`
        : `💥 반디도 탈옥 성공! 인원 부족으로 매치가 종료됩니다.${bustText}`;
    } else {
      room.status = 'ROUND_OVER';
      room.winnerAnnouncement = victory
        ? `🎊 작전 대성공! 모든 터널(${room.board.length}타일)을 봉쇄하여 반디도를 검거했습니다! 1인당 ${sharePerPlayer.toLocaleString()}칩 획득!${bustText}`
        : `😱 작전 실패! 남은 출구 ${room.openExitsCount}개를 막지 못해 반디도가 탈출했습니다! (판돈 몰수)${bustText}`;
    }

    if (victory && alivePlayers.length > 0) {
      saveHallOfFameRecord('NET', {
        name: alivePlayers.map((p) => p.name).join(', '),
        scoreOrLevel: `반디도 검거 (${room.board.length}타일 봉쇄)`,
      });
    }
  };

  /**
   * 넷게임: 보드 빈 칸에 선택한 터널 타일 배치
   */
  const handleNetPlaceTile = async (x: number, y: number) => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const idx = activeNetRoom.currentPlayerIdx;
    const actor = activeNetRoom.players[idx];
    if (!actor || actor.id !== mySessionId || actor.isEliminated) return;

    const chosenTile = actor.hand[selectedHandIdx];
    if (!chosenTile) return;

    const rotatedOpenings = rotateOpenings(chosenTile.openings, selectedRotation);
    const check = canPlaceTileAt(activeNetRoom.board, x, y, rotatedOpenings);
    if (!check.valid) {
      showToast(check.reason || '이곳에는 연결할 수 없습니다.', 'danger');
      return;
    }

    playSound('place');
    const roomRef = ref(db, `bandido_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetBandidoRoomData;
      if (room.status !== 'PLAYING') return room;

      const cIdx = room.currentPlayerIdx;
      const p = room.players[cIdx];
      if (!p || p.id !== mySessionId) return room;

      const tileInHand = p.hand[selectedHandIdx];
      if (!tileInHand) return room;

      const finalOpenings = rotateOpenings(tileInHand.openings, selectedRotation);
      const recheck = canPlaceTileAt(room.board, x, y, finalOpenings);
      if (!recheck.valid) return room;

      const newBoard: PlacedTile[] = [
        ...room.board,
        {
          x,
          y,
          openings: finalOpenings,
          isDeadEnd: tileInHand.isDeadEnd,
          placedBy: p.name,
        },
      ];

      const deckCopy = [...(room.deck || [])];
      const nextHand = p.hand.filter((_, hIdx) => hIdx !== selectedHandIdx);
      if (deckCopy.length > 0) {
        nextHand.push(deckCopy.shift()!);
      }

      room.players[cIdx] = { ...p, hand: nextHand };
      room.board = newBoard;
      room.deck = deckCopy;

      const exitsLeft = countOpenExits(newBoard);
      room.openExitsCount = exitsLeft;

      // 승리 조건: 열려 있는 탈출구가 0개!
      if (exitsLeft === 0) {
        settleNetBandidoRound(room, true);
        return room;
      }

      // 패배 조건: 덱도 떨어지고 모든 플레이어 손패도 소진
      const totalCardsLeft =
        deckCopy.length + room.players.reduce((acc, pl) => acc + (pl.hand?.length || 0), 0);
      if (totalCardsLeft === 0) {
        settleNetBandidoRound(room, false);
        return room;
      }

      const nextIdx = getNextAlivePlayerIdx(room.players, cIdx);
      room.currentPlayerIdx = nextIdx;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `🧱 ${p.name}님이 (${x}, ${y})에 터널을 연결했습니다! 남은 출구: ${exitsLeft}개 👉 ${room.players[nextIdx].name}님 차례!`;
      return room;
    });

    setSelectedHandIdx(0);
    setSelectedRotation(0);
  };

  /**
   * 넷게임: 손패 교체 (놓을 수 없을 때 패스)
   */
  const handleNetSwapHand = async () => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const idx = activeNetRoom.currentPlayerIdx;
    const actor = activeNetRoom.players[idx];
    if (!actor || actor.id !== mySessionId || actor.isEliminated) return;

    playSound('pass');
    const roomRef = ref(db, `bandido_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetBandidoRoomData;
      if (room.status !== 'PLAYING') return room;

      const cIdx = room.currentPlayerIdx;
      const p = room.players[cIdx];
      if (!p || p.id !== mySessionId) return room;

      const deckCopy = [...(room.deck || [])];
      if (deckCopy.length === 0) {
        settleNetBandidoRound(room, false);
        return room;
      }

      const drawCount = Math.min(3, deckCopy.length);
      const newHand = deckCopy.splice(0, drawCount);
      room.players[cIdx] = { ...p, hand: newHand };
      room.deck = deckCopy;

      const nextIdx = getNextAlivePlayerIdx(room.players, cIdx);
      room.currentPlayerIdx = nextIdx;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `🔄 ${p.name}님이 손패를 버리고 새 타일 ${drawCount}장을 보충했습니다. (남은 덱: ${deckCopy.length}장) 👉 ${room.players[nextIdx].name}님 차례!`;
      return room;
    });

    setSelectedHandIdx(0);
    setSelectedRotation(0);
  };

  const handleNetTurnTimeout = async (room: NetBandidoRoomData) => {
    const roomRef = ref(db, `bandido_rooms/room_${room.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const r = roomData as NetBandidoRoomData;
      if (r.status !== 'PLAYING') return r;

      const cIdx = r.currentPlayerIdx;
      const p = r.players[cIdx];
      if (!p) return r;

      const deckCopy = [...(r.deck || [])];
      if (deckCopy.length > 0) {
        const drawCount = Math.min(3, deckCopy.length);
        r.players[cIdx] = { ...p, hand: deckCopy.splice(0, drawCount) };
        r.deck = deckCopy;
      }

      const nextIdx = getNextAlivePlayerIdx(r.players, cIdx);
      r.currentPlayerIdx = nextIdx;
      r.turnDeadline = Date.now() + r.baseTimeout * 1000;
      r.turnNotice = `⏰ 시간 초과로 ${p.name}님의 턴이 넘어가고 손패가 교체되었습니다. 👉 ${r.players[nextIdx].name}님 차례!`;
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
  const addPlayer = () => {
    const trimmed = inputName ? inputName.trim() : '';
    if (!trimmed) return;
    if (players.length >= 4) {
      showToast('최대 4명까지 참가할 수 있습니다.', 'info');
      return;
    }
    const idx = players.length;
    setPlayers([
      ...players,
      {
        id: String(Date.now() + Math.random()),
        name: trimmed,
        badgeColor: PIECE_COLORS[idx % PIECE_COLORS.length],
        hand: [],
        chips: INITIAL_CHIPS,
        wins: 0,
        currentBet: 0,
        isEliminated: false,
      },
    ]);
    setInputName('');
  };

  const removePlayer = (id: string) => {
    setPlayers(players.filter((p) => p.id !== id));
  };

  const movePlayerOrder = (index: number, directionMove: 'UP' | 'DOWN') => {
    const newPlayers = [...players];
    const targetIdx = directionMove === 'UP' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= newPlayers.length) return;
    [newPlayers[index], newPlayers[targetIdx]] = [newPlayers[targetIdx], newPlayers[index]];
    setPlayers(newPlayers);
  };

  const shufflePlayersOrder = () => {
    setPlayers([...players].sort(() => Math.random() - 0.5));
  };

  const goToMainReady = () => {
    if (players.length < 2) {
      showToast('반디도는 최소 2명 이상의 팀원이 필요합니다!', 'info');
      return;
    }
    setGameState('READY');
  };

  const startSoloRound = (isNextRound = false) => {
    const isFreshMatch = !isNextRound || gameState === 'MATCH_OVER';
    const nextRound = isFreshMatch ? 1 : soloRoundNum + 1;

    const checkedPlayers = players.map((p, idx) => {
      const chips = isFreshMatch ? INITIAL_CHIPS : p.chips;
      const eliminated = !isFreshMatch && (p.isEliminated || chips <= 0);
      return {
        ...p,
        badgeColor: PIECE_COLORS[idx % PIECE_COLORS.length],
        hand: [],
        chips,
        wins: isFreshMatch ? 0 : p.wins,
        currentBet: 0,
        isEliminated: eliminated,
      };
    });

    const alivePlayers = checkedPlayers.filter((p) => !p.isEliminated);
    if (alivePlayers.length < 2) return;

    const equalStake = Math.min(soloAnteBet, ...alivePlayers.map((p) => p.chips));
    let totalPot = isFreshMatch ? 0 : soloPot;
    const deckCopy = createBandidoDeck();

    const preparedPlayers = checkedPlayers.map((p) => {
      if (p.isEliminated) return p;
      totalPot += equalStake;
      return {
        ...p,
        hand: deckCopy.splice(0, 3),
        chips: p.chips - equalStake,
        currentBet: equalStake,
      };
    });

    const initialBoard = createInitialPrisonBoard(soloDifficulty);
    const openExits = countOpenExits(initialBoard);
    const firstAliveIdx = preparedPlayers.findIndex((p) => !p.isEliminated);

    triggerChipAnimation('전원', equalStake, '#f59e0b');
    const notice = `🚨 [${nextRound}라운드] 전원 동일 판돈 ${equalStake.toLocaleString()}칩 베팅! 탈출구 ${openExits}개를 모두 봉쇄하세요! 👉 ${preparedPlayers[firstAliveIdx].name}님 차례`;

    setSoloRoundNum(nextRound);
    setSoloPot(totalPot);
    setPlayers(preparedPlayers);
    setDeck(deckCopy);
    setBoard(initialBoard);
    setSelectedHandIdx(0);
    setSelectedRotation(0);
    setCurrentPlayerIdx(firstAliveIdx);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setWinnerAnnouncement('');
    setShowFireworks(false);
    setTurnNotice(notice);
    speakKorean(notice);
    setGameState('PLAYING');
  };

  const settleSoloRound = (
    finalPlayers: BandidoPlayer[],
    finalBoard: PlacedTile[],
    victory: boolean
  ) => {
    const alive = finalPlayers.filter((p) => !p.isEliminated);
    const share = victory && alive.length > 0 ? Math.floor(soloPot / alive.length) : 0;

    const settledPlayers = finalPlayers.map((p) => {
      if (p.isEliminated) return p;
      const updatedChips = victory ? p.chips + share : p.chips;
      const busted = updatedChips <= 0;
      return {
        ...p,
        chips: updatedChips,
        wins: victory ? p.wins + 1 : p.wins,
        isEliminated: busted,
      };
    });

    const remainingAlive = settledPlayers.filter((p) => !p.isEliminated);
    const bustedNames = settledPlayers.filter((p) => p.isEliminated).map((p) => p.name);
    const bustText =
      bustedNames.length > 0 ? ` · 💀 ${bustedNames.join(', ')}님 판돈 소진 아웃!` : '';

    const openLeft = countOpenExits(finalBoard);
    const announcement = victory
      ? `🎊 작전 대성공! 모든 탈출구(${finalBoard.length}타일)를 봉쇄하여 반디도를 검거했습니다! 1인당 ${share.toLocaleString()}칩 획득!${bustText}`
      : `😱 작전 실패! 남은 출구 ${openLeft}개를 막지 못해 반디도가 탈출했습니다! (판돈 몰수)${bustText}`;

    setPlayers(settledPlayers);
    setSoloPot(0);
    setTurnNotice('');
    setWinnerAnnouncement(announcement);
    setGameState(remainingAlive.length < 2 ? 'MATCH_OVER' : 'ROUND_OVER');
    triggerEndCelebration(announcement, victory);

    if (victory && alive.length > 0) {
      saveHallOfFameRecord('SOLO', {
        name: alive.map((p) => p.name).join(', '),
        scoreOrLevel: `반디도 검거 (${finalBoard.length}타일 봉쇄)`,
      });
    }
  };

  const handleSoloPlaceTile = (x: number, y: number) => {
    if (gameState !== 'PLAYING') return;
    const actor = players[currentPlayerIdx];
    const chosenTile = actor?.hand[selectedHandIdx];
    if (!actor || !chosenTile) return;

    const rotatedOpenings = rotateOpenings(chosenTile.openings, selectedRotation);
    const check = canPlaceTileAt(board, x, y, rotatedOpenings);
    if (!check.valid) {
      showToast(check.reason || '이곳에는 터널을 연결할 수 없습니다.', 'danger');
      return;
    }

    playSound('place');
    const newBoard: PlacedTile[] = [
      ...board,
      {
        x,
        y,
        openings: rotatedOpenings,
        isDeadEnd: chosenTile.isDeadEnd,
        placedBy: actor.name,
      },
    ];

    const deckCopy = [...deck];
    const nextHand = actor.hand.filter((_, hIdx) => hIdx !== selectedHandIdx);
    if (deckCopy.length > 0) {
      nextHand.push(deckCopy.shift()!);
    }

    const updatedPlayers = players.map((p, idx) =>
      idx === currentPlayerIdx ? { ...p, hand: nextHand } : p
    );

    setBoard(newBoard);
    setDeck(deckCopy);
    setPlayers(updatedPlayers);
    setSelectedHandIdx(0);
    setSelectedRotation(0);

    const exitsLeft = countOpenExits(newBoard);
    if (exitsLeft === 0) {
      settleSoloRound(updatedPlayers, newBoard, true);
      return;
    }

    const totalCardsLeft =
      deckCopy.length + updatedPlayers.reduce((acc, pl) => acc + pl.hand.length, 0);
    if (totalCardsLeft === 0) {
      settleSoloRound(updatedPlayers, newBoard, false);
      return;
    }

    const nextIdx = getNextAlivePlayerIdx(updatedPlayers, currentPlayerIdx);
    const notice = `🧱 ${actor.name}님이 (${x}, ${y})에 터널을 연결했습니다! 남은 탈출구: ${exitsLeft}개 👉 ${updatedPlayers[nextIdx].name}님 차례!`;
    setCurrentPlayerIdx(nextIdx);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setTurnNotice(notice);
    speakKorean(notice);
  };

  const handleSoloPassAndSwapHand = () => {
    if (gameState !== 'PLAYING') return;
    const actor = players[currentPlayerIdx];
    if (!actor) return;

    if (deck.length === 0) {
      settleSoloRound(players, board, false);
      return;
    }

    playSound('pass');
    const deckCopy = [...deck];
    const drawCount = Math.min(3, deckCopy.length);
    const newHand = deckCopy.splice(0, drawCount);

    const updatedPlayers = players.map((p, idx) =>
      idx === currentPlayerIdx ? { ...p, hand: newHand } : p
    );

    const nextIdx = getNextAlivePlayerIdx(updatedPlayers, currentPlayerIdx);
    const notice = `🔄 ${actor.name}님이 손패를 버리고 새 타일 ${drawCount}장을 보충했습니다. (남은 덱: ${deckCopy.length}장) 👉 ${updatedPlayers[nextIdx].name}님 차례!`;

    setPlayers(updatedPlayers);
    setDeck(deckCopy);
    setSelectedHandIdx(0);
    setSelectedRotation(0);
    setCurrentPlayerIdx(nextIdx);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setTurnNotice(notice);
    speakKorean(notice);
  };

  // =========================================================================
  // 공용 UI 렌더링 헬퍼 (터널 타일 그래픽, 보드 그리드, 손패 도크, 폭죽)
  // =========================================================================

  /**
   * 4방향 터널 그래픽 SVG 렌더링
   */
  const renderTunnelGraphic = (
    openings: Openings,
    options?: { isStart?: boolean; isDeadEnd?: boolean; isGhost?: boolean }
  ) => {
    const [top, right, bottom, left] = openings;
    const roadColor = options?.isGhost ? '#34d399' : '#d97706';
    const roadInner = options?.isGhost ? '#a7f3d0' : '#fef3c7';

    return (
      <svg viewBox="0 0 100 100" className="tunnel-svg">
        {/* 어두운 암벽 배경 */}
        <rect
          x="2"
          y="2"
          width="96"
          height="96"
          rx="12"
          fill={options?.isStart ? '#7f1d1d' : options?.isGhost ? 'rgba(6, 78, 59, 0.35)' : '#1e293b'}
          stroke={options?.isStart ? '#f59e0b' : options?.isGhost ? '#34d399' : '#475569'}
          strokeWidth="4"
        />

        {/* 상(Top) 통로 */}
        {top && (
          <>
            <rect x="35" y="0" width="30" height="55" fill={roadColor} />
            <rect x="41" y="0" width="18" height="50" fill={roadInner} />
          </>
        )}
        {/* 우(Right) 통로 */}
        {right && (
          <>
            <rect x="45" y="35" width="55" height="30" fill={roadColor} />
            <rect x="50" y="41" width="50" height="18" fill={roadInner} />
          </>
        )}
        {/* 하(Bottom) 통로 */}
        {bottom && (
          <>
            <rect x="35" y="45" width="30" height="55" fill={roadColor} />
            <rect x="41" y="50" width="18" height="50" fill={roadInner} />
          </>
        )}
        {/* 좌(Left) 통로 */}
        {left && (
          <>
            <rect x="0" y="35" width="55" height="30" fill={roadColor} />
            <rect x="0" y="41" width="50" height="18" fill={roadInner} />
          </>
        )}

        {/* 중앙 교차점 / 막다른 길 / 감옥 표시 */}
        {options?.isStart ? (
          <g>
            <circle cx="50" cy="50" r="24" fill="#dc2626" stroke="#fde047" strokeWidth="3" />
            <text x="50" y="56" textAnchor="middle" fontSize="22">
              🦹
            </text>
          </g>
        ) : options?.isDeadEnd ? (
          <g>
            <circle cx="50" cy="50" r="19" fill="#991b1b" stroke="#fca5a5" strokeWidth="3" />
            <text x="50" y="56" textAnchor="middle" fontSize="18">
              🛑
            </text>
          </g>
        ) : (
          <circle cx="50" cy="50" r="11" fill={roadInner} />
        )}
      </svg>
    );
  };

  /**
   * 동적 확장형 지하 터널 보드 그리드 렌더링
   */
  const renderTunnelBoardGrid = (
    currentBoard: PlacedTile[],
    activeTile: TileDef | undefined,
    rotation: number,
    canInteract: boolean,
    onSelectCell: (x: number, y: number) => void
  ) => {
    const candidates = getCandidatePositions(currentBoard);
    const allCoords = [
      ...currentBoard.map((t) => ({ x: t.x, y: t.y })),
      ...candidates,
    ];

    const minX = Math.min(-2, ...allCoords.map((c) => c.x));
    const maxX = Math.max(3, ...allCoords.map((c) => c.x));
    const minY = Math.min(-2, ...allCoords.map((c) => c.y));
    const maxY = Math.max(2, ...allCoords.map((c) => c.y));

    const cols = maxX - minX + 1;
    const placedMap = new Map<string, PlacedTile>();
    for (const t of currentBoard) {
      placedMap.set(`${t.x},${t.y}`, t);
    }

    const candidateSet = new Set<string>(candidates.map((c) => `${c.x},${c.y}`));
    const rotatedActiveOpenings = activeTile
      ? rotateOpenings(activeTile.openings, rotation)
      : null;

    const cells: React.ReactNode[] = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const key = `${x},${y}`;
        const placed = placedMap.get(key);
        const isCandidate = candidateSet.has(key);

        if (placed) {
          cells.push(
            <div
              key={key}
              className={`board-grid-cell placed ${placed.isStart ? 'prison-cell' : ''}`}
              title={placed.placedBy ? `${placed.placedBy} 배치 (${x}, ${y})` : ''}
            >
              {renderTunnelGraphic(placed.openings, {
                isStart: placed.isStart,
                isDeadEnd: placed.isDeadEnd,
              })}
            </div>
          );
        } else if (isCandidate) {
          const validCheck =
            canInteract && rotatedActiveOpenings
              ? canPlaceTileAt(currentBoard, x, y, rotatedActiveOpenings)
              : { valid: false };

          cells.push(
            <button
              key={key}
              type="button"
              disabled={!validCheck.valid}
              className={`board-grid-cell slot ${validCheck.valid ? 'valid-drop' : 'open-exit'}`}
              onClick={() => onSelectCell(x, y)}
              title={
                validCheck.valid
                  ? `클릭하여 (${x}, ${y})에 터널 배치`
                  : '열려 있는 탈출구 (현재 회전 방향으로는 연결 불가)'
              }
            >
              {validCheck.valid && rotatedActiveOpenings ? (
                <div className="ghost-preview-wrap">
                  {renderTunnelGraphic(rotatedActiveOpenings, {
                    isDeadEnd: activeTile?.isDeadEnd,
                    isGhost: true,
                  })}
                </div>
              ) : (
                <span className="exit-warning-dot">⚠️</span>
              )}
            </button>
          );
        } else {
          cells.push(<div key={key} className="board-grid-cell empty-rock" />);
        }
      }
    }

    return (
      <div className="tunnel-board-scroll-area">
        <div
          className="tunnel-board-matrix"
          style={{
            gridTemplateColumns: `repeat(${cols}, 68px)`,
          }}
        >
          {cells}
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
      <div className="bd-container" style={{ background: PLAYER_BG_COLORS[0] }}>
        <div className="setup-card home-entry-card">
          <div className="home-castle-icon">🦹⛏️🚨</div>
          <h1 className="setup-title">반디도! (BANDIDO)</h1>
          <p className="home-subtitle">
            2~4인 실시간 협동 탈출 저지 · 모든 지하 터널 출구를 봉쇄하고 현상금을 나눠 가지세요!
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
              <span className="mode-desc">2~4인 로컬 협동 탈옥 저지 &amp; 현상금 누적</span>
            </button>

            <button
              type="button"
              className="mode-select-btn net"
              onClick={() => setAppMode('NET_LOBBY')}
            >
              <span className="mode-icon">🌐</span>
              <strong>넷게임</strong>
              <span className="mode-desc">실시간 4개 작전실 대전 (창 닫기 시 자동 퇴장)</span>
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
      <div className="bd-container" style={{ background: PLAYER_BG_COLORS[0], padding: '16px' }}>
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
            <h2 style={{ margin: 0, color: '#0f172a' }}>🏅 명예의 전당</h2>
            <div style={{ width: '60px' }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div
              style={{
                background: '#f8fafc',
                padding: '12px',
                borderRadius: '12px',
                border: '1px solid #e2e8f0',
              }}
            >
              <h3 style={{ margin: '0 0 8px', fontSize: '15px', color: '#1e3a8a', textAlign: 'center' }}>
                🎮 단독 작전 TOP 10
              </h3>
              {soloRecords.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#64748b', fontSize: '13px' }}>
                  기록이 없습니다.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {soloRecords.map((rec, i) => (
                    <div
                      key={rec.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: '12px',
                        background: '#fff',
                        padding: '6px 8px',
                        borderRadius: '6px',
                        border: '1px solid #f1f5f9',
                      }}
                    >
                      <span>
                        <strong>
                          {i + 1}. {rec.name}
                        </strong>
                      </span>
                      <span style={{ color: '#059669' }}>{rec.scoreOrLevel}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div
              style={{
                background: '#f8fafc',
                padding: '12px',
                borderRadius: '12px',
                border: '1px solid #e2e8f0',
              }}
            >
              <h3 style={{ margin: '0 0 8px', fontSize: '15px', color: '#b45309', textAlign: 'center' }}>
                🌐 넷작전 TOP 10
              </h3>
              {netRecords.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#64748b', fontSize: '13px' }}>
                  기록이 없습니다.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {netRecords.map((rec, i) => (
                    <div
                      key={rec.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: '12px',
                        background: '#fff',
                        padding: '6px 8px',
                        borderRadius: '6px',
                        border: '1px solid #f1f5f9',
                      }}
                    >
                      <span>
                        <strong>
                          {i + 1}. {rec.name}
                        </strong>
                      </span>
                      <span style={{ color: '#d97706' }}>{rec.scoreOrLevel}</span>
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
      <div className="bd-container" style={{ background: PLAYER_BG_COLORS[0] }}>
        <div className="net-lobby-container">
          <div className="net-lobby-header">
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, fontSize: '20px', color: '#0f172a' }}>
              🌐 반디도 넷게임 (4개 작전실)
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
              const isFull = roomPlayers.length >= 4;

              let statusBadgeText = '🟢 빈 작전실';
              let statusClass = 'empty';
              if (isPlaying) {
                statusBadgeText = `🔥 ${room.roundNumber}차 작전 중`;
                statusClass = 'playing';
              } else if (isWaiting) {
                statusBadgeText = isFull
                  ? `🟠 대기중 (만석 4/4)`
                  : `🟡 대기중 (${roomPlayers.length}/4명)`;
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
                    <span className="room-number-title">🦹 제 {room.roomId} 반디도 작전실</span>
                    <span className={`room-status-pill ${statusClass}`}>{statusBadgeText}</span>
                  </div>

                  <div className="room-rules-info">
                    <span>💰 판돈: {room.anteBet.toLocaleString()}칩</span>
                    <span>
                      🚨 난이도: {room.difficulty === 'HARD' ? '6출구(악몽)' : '5출구(표준)'}
                    </span>
                    <span>⏱️ {room.baseTimeout}초</span>
                  </div>

                  <div className="room-members-box">
                    <div className="room-members-label">팀원 ({roomPlayers.length}/4):</div>
                    <div className="room-members-chips">
                      {roomPlayers.length === 0 ? (
                        <span className="empty-member-text">첫 번째 보안관을 기다리고 있습니다</span>
                      ) : (
                        roomPlayers.map((p, idx) => (
                          <span
                            key={p.id}
                            className="member-chip"
                            style={{ borderColor: PIECE_COLORS[idx] }}
                          >
                            <i style={{ backgroundColor: PIECE_COLORS[idx] }} />
                            {p.name} (
                            {p.isEliminated
                              ? '💀아웃'
                              : `${p.wins || 0}승 · ${(p.chips ?? INITIAL_CHIPS).toLocaleString()}칩`}
                            )
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
                      👀 관망 중 ({roomSpectators.length}명):{' '}
                      {roomSpectators.map((s) => s.name).join(', ')}
                    </div>
                  )}

                  {roomWaitlist.length > 0 && (
                    <div className="room-waitlist-box">
                      ⏳ 다음 작전 예약 ({roomWaitlist.length}명):{' '}
                      {roomWaitlist.map((w) => w.name).join(', ')}
                    </div>
                  )}

                  <div className="room-enter-cta">
                    {isEmpty
                      ? '👉 클릭하여 작전실 열기 또는 관망하기'
                      : isPlaying || isFull
                      ? '👉 클릭하여 다음 작전 예약 또는 관망하기'
                      : '👉 클릭하여 합류하기 또는 관망하기'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {joinModalRoom && (
          <div className="modal-overlay" onClick={() => setJoinModalRoom(null)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h2 style={{ margin: '0 0 8px' }}>🦹 제 {joinModalRoom.roomId} 반디도 작전실 입장</h2>
              <p className="modal-subtext">
                전원 동일 판돈 <strong>{joinModalRoom.anteBet.toLocaleString()}칩</strong>을 걸고
                협동으로 탈옥을 저지합니다.
              </p>

              <input
                type="text"
                className="player-input"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: '14px' }}
                placeholder="내 이름 입력 (예: 보안관)"
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
                  👀 관망하기
                </button>
                <button
                  type="button"
                  className="btn btn-success"
                  style={{ flex: 2 }}
                  onClick={() => handleEnterRoomSubmit(false)}
                >
                  🚀 합류하기 / 예약하기
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
          className="bd-container"
          style={{
            background: PLAYER_BG_COLORS[0],
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div className="setup-card" style={{ textAlign: 'center' }}>
            <h2>⏳ 작전실 정보를 불러오는 중입니다...</h2>
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
        <div className="bd-container" style={{ background: PLAYER_BG_COLORS[0] }}>
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
                제 {activeNetRoom.roomId}방 · 대기 중 (⏱️ {countdownStr})
              </span>
            </div>

            <h1 className="setup-title" style={{ marginTop: '14px' }}>
              🦹 반디도 작전 대기실 {amISpectator ? '👀 [관망모드]' : ''}
            </h1>

            <div className="setting-section">
              <label className="setting-label">
                🚨 감옥 출구 난이도 {isHost ? '(방장 설정 가능)' : '(방장 설정 중)'}
              </label>
              <div className="piece-count-selector" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <button
                  type="button"
                  disabled={!isHost}
                  className={`count-btn ${activeNetRoom.difficulty === 'NORMAL' ? 'active' : ''}`}
                  onClick={() =>
                    updateRoomSettings(activeNetRoom.anteBet, activeNetRoom.baseTimeout, 'NORMAL')
                  }
                >
                  🛡️ 표준 모드 (5출구)
                </button>
                <button
                  type="button"
                  disabled={!isHost}
                  className={`count-btn ${activeNetRoom.difficulty === 'HARD' ? 'active' : ''}`}
                  onClick={() =>
                    updateRoomSettings(activeNetRoom.anteBet, activeNetRoom.baseTimeout, 'HARD')
                  }
                >
                  🔥 악몽 모드 (6출구)
                </button>
              </div>
            </div>

            <div className="setting-section">
              <label className="setting-label">
                💰 동일 판돈 설정 (초기 10,000칩 · 검거 성공 시 현상금 분배)
              </label>
              <div className="piece-count-selector" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                {[1000, 2000, 3000, 5000].map((val) => (
                  <button
                    key={val}
                    type="button"
                    disabled={!isHost}
                    className={`count-btn ${activeNetRoom.anteBet === val ? 'active' : ''}`}
                    onClick={() =>
                      updateRoomSettings(val, activeNetRoom.baseTimeout, activeNetRoom.difficulty)
                    }
                  >
                    {val.toLocaleString()}칩
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-section">
              <label className="setting-label">
                ⏱️ 턴 제한시간: <strong>{activeNetRoom.baseTimeout}초</strong>
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
                    updateRoomSettings(
                      activeNetRoom.anteBet,
                      Number(e.target.value),
                      activeNetRoom.difficulty
                    )
                  }
                />
                <span style={{ fontSize: '12px', fontWeight: 700 }}>180초</span>
              </div>
            </div>

            <div className="setting-section">
              <label className="setting-label">🧭 합류한 팀원 (2명 이상 시 작전 개시)</label>
              <div className="player-list">
                {roomPlayers.map((p, idx) => (
                  <div key={p.id} className="player-item">
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="squircle-dot" style={{ backgroundColor: PIECE_COLORS[idx] }}>
                        {getShortName(p.name)}
                      </span>
                      {p.name} {idx === 0 && '👑(팀장)'} {p.id === mySessionId && '(나)'}
                    </span>
                    <span style={{ fontSize: '12px', color: '#059669' }}>
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
              🚀 반디도 봉쇄 작전 개시! (전원 {activeNetRoom.anteBet.toLocaleString()}칩 베팅)
            </button>
          </div>
        </div>
      );
    }

    const netCurrIdx = activeNetRoom.currentPlayerIdx % Math.max(1, roomPlayers.length);
    const netCurrPlayer = roomPlayers[netCurrIdx];
    const isMyTurn =
      activeNetRoom.status === 'PLAYING' &&
      netCurrPlayer?.id === mySessionId &&
      !netCurrPlayer?.isEliminated &&
      !amISpectator;
    const myPlayerObj = roomPlayers.find((p) => p.id === mySessionId);
    const isRoundEnded =
      activeNetRoom.status === 'ROUND_OVER' || activeNetRoom.status === 'MATCH_OVER';
    const myActiveTile = myPlayerObj?.hand[selectedHandIdx];

    return (
      <div
        className="bd-container"
        style={{ background: PLAYER_BG_COLORS[netCurrIdx % PLAYER_BG_COLORS.length] }}
      >
        {renderFireworksAndChips()}

        {toast && (
          <div key={toast.id} className={`bd-toast ${toast.type}`}>
            {toast.text}
          </div>
        )}

        <div className="play-wrapper compact-tablet-mode">
          <div className="game-header compact-header">
            <div className="net-level-timer-box">
              <span className="net-level-badge">
                {activeNetRoom.roundNumber}차전 {amISpectator ? '👀[관망]' : ''}
              </span>
              {!isRoundEnded && (
                <span className={`net-timer-badge ${remainingSeconds <= 10 ? 'urgent' : ''}`}>
                  ⏱️ {remainingSeconds}초
                </span>
              )}
            </div>

            <div className="player-status-bar">
              {roomPlayers.map((p, idx) => {
                const isActive =
                  !p.isEliminated && activeNetRoom.status === 'PLAYING' && idx === netCurrIdx;
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${isActive ? 'active-turn-spotlight' : ''} ${
                      p.isEliminated ? 'eliminated' : ''
                    }`}
                    style={{ borderColor: isActive ? p.badgeColor : 'transparent' }}
                  >
                    <div className="player-badge-top">
                      <span className="squircle-dot mini" style={{ backgroundColor: p.badgeColor }}>
                        {getShortName(p.name)}
                      </span>
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '👉 '}
                        {p.name}
                        {p.id === mySessionId ? '(나)' : ''}
                      </strong>
                      {p.isEliminated ? (
                        <span className="out-pill">💀 아웃</span>
                      ) : (
                        <>
                          <span className="win-count-pill">🏆{p.wins || 0}승</span>
                          <span className="badge-score">💰{(p.chips ?? 0).toLocaleString()}</span>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              className="btn btn-secondary btn-compact-setup"
              onClick={handleLeaveNetRoom}
              title="방 나가기"
            >
              🚪
            </button>
          </div>

          {(amIWaitlisted || roomWaitlist.length > 0) && !amISpectator && (
            <div className="net-waitlist-strip">
              {amIWaitlisted
                ? '⏳ 현재 다음 작전 예약 대기 중입니다! 이번 라운드가 끝나면 빈자리에 자동 합류됩니다.'
                : `⏳ 다음 작전 예약자 (${roomWaitlist.length}명): ${roomWaitlist
                    .map((w) => w.name)
                    .join(', ')}`}
            </div>
          )}

          <div className="bd-table-board">
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
                      : `🔥 다음 작전 시작 (동일 판돈 ${activeNetRoom.anteBet.toLocaleString()}칩)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={activeNetRoom.turnNotice} className="bd-notice-banner">
                {activeNetRoom.turnNotice}
              </div>
            )}

            {/* 상단 작전 현황판 (열린 탈출구 수 / 남은 카드 / 현상금 POT) */}
            <div className="bd-hud-strip">
              <div className="hud-pill exits">
                <span>🚨 열린 탈출구</span>
                <strong>{activeNetRoom.openExitsCount}개</strong>
              </div>
              <div className="hud-pill deck">
                <span>🃏 남은 덱</span>
                <strong>{activeNetRoom.deck.length}장</strong>
              </div>
              <div className="hud-pill pot">
                <span>💰 현상금 POT</span>
                <strong>{(activeNetRoom.pot || 0).toLocaleString()}칩</strong>
              </div>
            </div>

            {/* 중앙 확장형 터널 보드 */}
            {renderTunnelBoardGrid(
              activeNetRoom.board,
              myActiveTile,
              selectedRotation,
              isMyTurn,
              handleNetPlaceTile
            )}
          </div>

          {amISpectator && (
            <div className="bd-bottom-dock">
              <div className="waiting-dock-msg">
                👀 관망모드에서는 각 팀원의 손패가 비공개로 보호됩니다.
              </div>
            </div>
          )}

          {myPlayerObj && !amISpectator && (
            <div
              className="bd-bottom-dock"
              style={{ borderTop: `4px solid ${myPlayerObj.badgeColor}` }}
            >
              {myPlayerObj.isEliminated ? (
                <div className="waiting-dock-msg" style={{ color: '#dc2626' }}>
                  💀 보유한 판돈을 모두 소진하여 아웃되었습니다. 다음 매치가 열릴 때까지 관전합니다.
                </div>
              ) : (
                <>
                  {activeNetRoom.status === 'PLAYING' && (
                    <div className="bd-hand-dock-inner">
                      <div className="hand-cards-selector">
                        {myPlayerObj.hand.map((tile, hIdx) => {
                          const isSelected = hIdx === selectedHandIdx;
                          const displayOpenings = rotateOpenings(
                            tile.openings,
                            isSelected ? selectedRotation : 0
                          );
                          return (
                            <button
                              key={tile.id}
                              type="button"
                              className={`hand-tile-btn ${isSelected ? 'selected' : ''}`}
                              onClick={() => {
                                if (isSelected) {
                                  playSound('rotate');
                                  setSelectedRotation((prev) => (prev + 1) % 4);
                                } else {
                                  setSelectedHandIdx(hIdx);
                                  setSelectedRotation(0);
                                }
                              }}
                            >
                              <div className="hand-tile-preview">
                                {renderTunnelGraphic(displayOpenings, {
                                  isDeadEnd: tile.isDeadEnd,
                                })}
                              </div>
                              <span className="hand-tile-label">
                                {isSelected ? '🔄 클릭해 회전' : tile.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>

                      <div className="bd-side-controls">
                        <button
                          type="button"
                          className="bd-act-btn rotate"
                          onClick={() => {
                            playSound('rotate');
                            setSelectedRotation((prev) => (prev + 1) % 4);
                          }}
                        >
                          🔄 90° 회전
                        </button>
                        <button
                          type="button"
                          className="bd-act-btn swap"
                          disabled={!isMyTurn}
                          onClick={handleNetSwapHand}
                        >
                          ♻️ 손패 교체 (패스)
                        </button>
                      </div>
                    </div>
                  )}

                  {isRoundEnded && (
                    <div className="waiting-dock-msg">
                      🏆 라운드 종료! 상단의 <strong>[다음 작전 시작]</strong> 버튼으로 승수와
                      현상금을 이어가세요!
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // =========================================================================
  // 5. 단독게임(SOLO) - 2~4인 로컬 협동 반디도
  // =========================================================================
  const currentPlayer = players[currentPlayerIdx] || players[0];
  const currentBackground =
    gameState === 'PLAYING' && players.length > 0
      ? PLAYER_BG_COLORS[currentPlayerIdx % PLAYER_BG_COLORS.length]
      : PLAYER_BG_COLORS[0];
  const isSoloEnded = gameState === 'ROUND_OVER' || gameState === 'MATCH_OVER';
  const soloActiveTile = currentPlayer?.hand[selectedHandIdx];
  const soloOpenExits = countOpenExits(board);

  return (
    <div className="bd-container" style={{ background: currentBackground }}>
      {renderFireworksAndChips()}

      {toast && (
        <div key={toast.id} className={`bd-toast ${toast.type}`}>
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
          <h1 className="setup-title">🦹 반디도! (단독게임 · 협동 봉쇄)</h1>

          <div className="setting-section">
            <label className="setting-label">🚨 감옥 탈출구 난이도 설정</label>
            <div className="piece-count-selector" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <button
                type="button"
                className={`count-btn ${soloDifficulty === 'NORMAL' ? 'active' : ''}`}
                onClick={() => setSoloDifficulty('NORMAL')}
              >
                🛡️ 표준 모드 (5출구)
              </button>
              <button
                type="button"
                className={`count-btn ${soloDifficulty === 'HARD' ? 'active' : ''}`}
                onClick={() => setSoloDifficulty('HARD')}
              >
                🔥 악몽 모드 (6출구)
              </button>
            </div>
          </div>

          <div className="setting-section">
            <label className="setting-label">
              💰 매 라운드 전원 동일 판돈 설정 (초기 지급 10,000칩)
            </label>
            <div className="piece-count-selector" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
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
              🧭 팀원 등록 (2~4명 · 판돈 0칩 시 즉시 아웃)
            </label>
            <div className="input-group">
              <input
                type="text"
                className="player-input"
                placeholder="팀원 이름 입력 후 추가"
                value={inputName}
                onChange={(e) => setInputName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addPlayer()}
              />
              <button type="button" className="btn btn-primary" onClick={addPlayer}>
                ➕ 추가
              </button>
            </div>

            <div className="player-list">
              {players.map((player, idx) => (
                <div key={player.id} className="player-item">
                  <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span
                      className="squircle-dot"
                      style={{ backgroundColor: PIECE_COLORS[idx % PIECE_COLORS.length] }}
                    >
                      {getShortName(player.name)}
                    </span>
                    {player.name}
                  </span>
                  <button
                    type="button"
                    className="btn-delete"
                    onClick={() => removePlayer(player.id)}
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
          </div>

          <button
            type="button"
            className="btn btn-success"
            disabled={players.length < 2}
            onClick={goToMainReady}
          >
            ➡️ 순서 정하러 가기 ({players.length}명)
          </button>
        </div>
      )}

      {gameState === 'READY' && (
        <div className="order-panel">
          <div className="order-header">
            <h2 style={{ margin: 0, fontSize: '20px' }}>📋 작전 진행 순서를 정해주세요</h2>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: '8px 14px', fontSize: '13px' }}
              onClick={shufflePlayersOrder}
            >
              🎲 순서 랜덤 섞기
            </button>
          </div>

          <div className="order-list">
            {players.map((player, idx) => (
              <div key={player.id} className="order-item">
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <strong style={{ color: '#2563eb' }}>{idx + 1}번째</strong>
                  <span
                    className="squircle-dot"
                    style={{ backgroundColor: PIECE_COLORS[idx % PIECE_COLORS.length] }}
                  >
                    {getShortName(player.name)}
                  </span>
                  {player.name}
                </span>
                <div className="order-controls">
                  <button
                    type="button"
                    className="order-btn"
                    disabled={idx === 0}
                    onClick={() => movePlayerOrder(idx, 'UP')}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    className="order-btn"
                    disabled={idx === players.length - 1}
                    onClick={() => movePlayerOrder(idx, 'DOWN')}
                  >
                    ▼
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setGameState('SETUP')}
            >
              ⬅️ 설정으로
            </button>
            <button type="button" className="btn btn-success" onClick={() => startSoloRound(false)}>
              🚀 반디도 봉쇄 작전 시작! (전원 {soloAnteBet.toLocaleString()}칩 베팅)
            </button>
          </div>
        </div>
      )}

      {(gameState === 'PLAYING' || gameState === 'ROUND_OVER' || gameState === 'MATCH_OVER') &&
        currentPlayer && (
          <div className="play-wrapper compact-tablet-mode">
            <div className="game-header compact-header">
              <div className="net-level-timer-box">
                <span className="net-level-badge">{soloRoundNum}차전</span>
                {!isSoloEnded && (
                  <span className={`net-timer-badge ${soloRemainingSec <= 10 ? 'urgent' : ''}`}>
                    ⏱️ {soloRemainingSec}초
                  </span>
                )}
              </div>

              <div className="player-status-bar">
                {players.map((p, idx) => {
                  const isActive = !isSoloEnded && !p.isEliminated && idx === currentPlayerIdx;
                  return (
                    <div
                      key={p.id}
                      className={`player-badge-card ${isActive ? 'active-turn-spotlight' : ''} ${
                        p.isEliminated ? 'eliminated' : ''
                      }`}
                      style={{ borderColor: isActive ? p.badgeColor : 'transparent' }}
                    >
                      <div className="player-badge-top">
                        <span className="squircle-dot mini" style={{ backgroundColor: p.badgeColor }}>
                          {getShortName(p.name)}
                        </span>
                        <strong className={isActive ? 'turn-hero-name' : ''}>
                          {isActive && '👉 '}
                          {p.name}
                        </strong>
                        {p.isEliminated ? (
                          <span className="out-pill">💀 아웃</span>
                        ) : (
                          <>
                            <span className="win-count-pill">🏆{p.wins}승</span>
                            <span className="badge-score">💰{p.chips.toLocaleString()}</span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                className="btn btn-secondary btn-compact-setup"
                onClick={() => setGameState('SETUP')}
                title="설정/나가기"
              >
                🚪
              </button>
            </div>

            <div className="bd-table-board">
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
                        : `🔥 다음 작전 시작 (동일 판돈 ${soloAnteBet.toLocaleString()}칩)`}
                    </button>
                  </div>
                </div>
              ) : (
                <div key={turnNotice} className="bd-notice-banner">
                  {turnNotice}
                </div>
              )}

              {/* 상단 작전 현황판 */}
              <div className="bd-hud-strip">
                <div className="hud-pill exits">
                  <span>🚨 열린 탈출구</span>
                  <strong>{soloOpenExits}개</strong>
                </div>
                <div className="hud-pill deck">
                  <span>🃏 남은 덱</span>
                  <strong>{deck.length}장</strong>
                </div>
                <div className="hud-pill pot">
                  <span>💰 현상금 POT</span>
                  <strong>{soloPot.toLocaleString()}칩</strong>
                </div>
              </div>

              {/* 중앙 확장형 터널 보드 */}
              {renderTunnelBoardGrid(
                board,
                soloActiveTile,
                selectedRotation,
                gameState === 'PLAYING',
                handleSoloPlaceTile
              )}
            </div>

            <div
              className="bd-bottom-dock"
              style={{ borderTop: `4px solid ${currentPlayer.badgeColor}` }}
            >
              <div className="dock-top-status">
                <span
                  className="turn-owner-pill large-turn-pill"
                  style={{ backgroundColor: currentPlayer.badgeColor }}
                >
                  👉 {currentPlayer.name}님 차례 · 타일을 선택한 뒤 보드의 초록색 칸을 클릭하세요!
                </span>
              </div>

              {gameState === 'PLAYING' && (
                <div className="bd-hand-dock-inner">
                  <div className="hand-cards-selector">
                    {currentPlayer.hand.map((tile, hIdx) => {
                      const isSelected = hIdx === selectedHandIdx;
                      const displayOpenings = rotateOpenings(
                        tile.openings,
                        isSelected ? selectedRotation : 0
                      );
                      return (
                        <button
                          key={tile.id}
                          type="button"
                          className={`hand-tile-btn ${isSelected ? 'selected' : ''}`}
                          onClick={() => {
                            if (isSelected) {
                              playSound('rotate');
                              setSelectedRotation((prev) => (prev + 1) % 4);
                            } else {
                              setSelectedHandIdx(hIdx);
                              setSelectedRotation(0);
                            }
                          }}
                        >
                          <div className="hand-tile-preview">
                            {renderTunnelGraphic(displayOpenings, {
                              isDeadEnd: tile.isDeadEnd,
                            })}
                          </div>
                          <span className="hand-tile-label">
                            {isSelected ? '🔄 클릭해 회전' : tile.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="bd-side-controls">
                    <button
                      type="button"
                      className="bd-act-btn rotate"
                      onClick={() => {
                        playSound('rotate');
                        setSelectedRotation((prev) => (prev + 1) % 4);
                      }}
                    >
                      🔄 90° 회전
                    </button>
                    <button
                      type="button"
                      className="bd-act-btn swap"
                      onClick={handleSoloPassAndSwapHand}
                    >
                      ♻️ 손패 교체 (패스)
                    </button>
                  </div>
                </div>
              )}

              {isSoloEnded && (
                <div className="waiting-dock-msg">
                  🎉 작전 종료! <strong>[다음 작전 시작]</strong>을 눌러 승수와 현상금을 계속
                  이어가세요!
                </div>
              )}
            </div>
          </div>
        )}
    </div>
  );
}