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
import './Page11.css';

// 1: 밝은 원목(단풍나무/Light), 2: 어두운 원목(호두나무/Dark)
type PlayerSide = 1 | 2;
type PieceKind = 'STEEPLE' | 'NAVE' | 'HOUSE';
// 'V': 상하(수직) 용마루 방향, 'H': 좌우(수평) 용마루 방향
type RidgeDir = 'V' | 'H';

interface VillagePiece {
  uid: string;
  owner: PlayerSide;
  kind: PieceKind;
  row: number; // 0..6
  col: number; // 0..6
  ridge: RidgeDir;
}

interface ClergymanPos {
  row: number;
  col: number;
}

interface VillagePlayer {
  id: string;
  name: string;
  side: PlayerSide;
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

type NetPhase = 'SETUP_CHURCH' | 'SETUP_HOUSES' | 'MOVING';

interface NetVillageRoomData {
  roomId: number;
  status: 'EMPTY' | 'WAITING' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER';
  phase: NetPhase;
  players: VillagePlayer[];
  pot: number;
  waitlist: WaitlistPlayer[];
  spectators: SpectatorPlayer[];
  baseTimeout: number;
  anteBet: number;
  roundNumber: number;
  clergyman: ClergymanPos;
  pieces: VillagePiece[];
  currentTurn: PlayerSide;
  setupChurchStep: number; // 0: Light 1번째, 1: Light 2번째, 2: Dark 1번째, 3: Dark 2번째
  selectedPieceUid: string | null;
  lastMovedUid: string | null;
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

interface MoveOption {
  row: number;
  col: number;
  kind: 'SLIDE' | 'CLERGY_SWAP';
}

const WOOD_BG_THEMES: readonly string[] = [
  'radial-gradient(circle at top, #5d4037 0%, #3e2723 60%, #261612 100%)',
  'radial-gradient(circle at top, #4e342e 0%, #321f1a 60%, #1f120e 100%)',
];

const BOARD_SIZE = 7;
const CENTER_POS: ClergymanPos = { row: 3, col: 3 };
const INITIAL_CHIPS = 10000;
const DEFAULT_TIMEOUT_SEC = 60;
const HOUSES_PER_PLAYER = 7;
const TOTAL_PIECES_PER_PLAYER = 1 + 1 + HOUSES_PER_PLAYER; // 9개

const ORTHO_DIRS: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];


function isInsideBoard(r: number, c: number): boolean {
  return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
}

function isCorner(r: number, c: number): boolean {
  return (r === 0 || r === BOARD_SIZE - 1) && (c === 0 || c === BOARD_SIZE - 1);
}

function isEdgeOrCorner(r: number, c: number): boolean {
  return r === 0 || r === BOARD_SIZE - 1 || c === 0 || c === BOARD_SIZE - 1;
}

function formatCoord(r: number, c: number): string {
  const colChar = String.fromCharCode(65 + c); // A~G
  return `${colChar}${r + 1}`;
}

function findPieceAt(
  pieces: VillagePiece[],
  r: number,
  c: number
): VillagePiece | undefined {
  return pieces.find((p) => p.row === r && p.col === c);
}

function isOccupied(
  pieces: VillagePiece[],
  clergyman: ClergymanPos,
  r: number,
  c: number
): boolean {
  if (clergyman.row === r && clergyman.col === c) return true;
  return pieces.some((p) => p.row === r && p.col === c);
}

/**
 * 집 배치 규칙: 자신의 기존 건물과 상하좌우(직교) 인접 불가, 대각선은 허용
 */
function canPlaceHouseAt(
  pieces: VillagePiece[],
  clergyman: ClergymanPos,
  side: PlayerSide,
  r: number,
  c: number
): boolean {
  if (!isInsideBoard(r, c)) return false;
  if (isOccupied(pieces, clergyman, r, c)) return false;

  for (const [dr, dc] of ORTHO_DIRS) {
    const nr = r + dr;
    const nc = c + dc;
    if (isInsideBoard(nr, nc)) {
      const neighbor = findPieceAt(pieces, nr, nc);
      if (neighbor && neighbor.owner === side) {
        return false;
      }
    }
  }
  return true;
}

/**
 * 직선 슬라이드 가능 칸 계산 (지붕 용마루 방향: 'V'는 상하, 'H'는 좌우, 빈 칸만 통과 가능)
 */
function getSlideTargets(
  pieces: VillagePiece[],
  clergyman: ClergymanPos,
  piece: VillagePiece
): { row: number; col: number }[] {
  const targets: { row: number; col: number }[] = [];
  const deltas: [number, number][] =
    piece.ridge === 'V'
      ? [
          [-1, 0],
          [1, 0],
        ]
      : [
          [0, -1],
          [0, 1],
        ];

  for (const [dr, dc] of deltas) {
    let nr = piece.row + dr;
    let nc = piece.col + dc;
    while (isInsideBoard(nr, nc)) {
      if (isOccupied(pieces, clergyman, nr, nc)) {
        break;
      }
      targets.push({ row: nr, col: nc });
      nr += dr;
      nc += dc;
    }
  }
  return targets;
}

/**
 * 해당 피스가 움직임 축에서 막혀 있는지(Stuck) 판별
 */
function isPieceStuck(
  pieces: VillagePiece[],
  clergyman: ClergymanPos,
  piece: VillagePiece
): boolean {
  return getSlideTargets(pieces, clergyman, piece).length === 0;
}

/**
 * 피스의 이동 가능 목적지 목록 (기본 슬라이드 + 막혔을 때 사제 위치와 맞교환)
 */
function getPieceMoveOptions(
  pieces: VillagePiece[],
  clergyman: ClergymanPos,
  piece: VillagePiece
): MoveOption[] {
  const slides = getSlideTargets(pieces, clergyman, piece).map((pos) => ({
    ...pos,
    kind: 'SLIDE' as const,
  }));

  if (slides.length > 0) {
    return slides;
  }

  // 막힌 피스만 사제(Pfarrer)와 자리 교환 가능
  if (isPieceStuck(pieces, clergyman, piece)) {
    return [
      {
        row: clergyman.row,
        col: clergyman.col,
        kind: 'CLERGY_SWAP' as const,
      },
    ];
  }

  return [];
}

/**
 * 승리 조건 검사:
 * 1) 해당 플레이어의 모든 피스(9개)가 상하좌우(직교)로 하나로 연결됨
 * 2) 첨탑(STEEPLE)과 본관(NAVE)이 상하좌우로 직접 인접함
 * 3) 첨탑과 본관 모두 모서리(Corner)나 가장자리(Edge) 칸에 있지 않음
 */
function checkVillageVictory(pieces: VillagePiece[], side: PlayerSide): boolean {
  const sidePieces = pieces.filter((p) => p.owner === side);
  if (sidePieces.length < TOTAL_PIECES_PER_PLAYER) return false;

  const steeple = sidePieces.find((p) => p.kind === 'STEEPLE');
  const nave = sidePieces.find((p) => p.kind === 'NAVE');
  if (!steeple || !nave) return false;

  // 교회(첨탑·본관)는 모서리/가장자리 금지
  if (
    isEdgeOrCorner(steeple.row, steeple.col) ||
    isEdgeOrCorner(nave.row, nave.col)
  ) {
    return false;
  }

  // 첨탑과 본관은 직교 인접 필수 (맨해튼 거리 === 1)
  const manhattan =
    Math.abs(steeple.row - nave.row) + Math.abs(steeple.col - nave.col);
  if (manhattan !== 1) return false;

  // 모든 자가 피스 상하좌우 연결성(BFS) 확인
  const visited = new Set<string>([sidePieces[0].uid]);
  const queue: VillagePiece[] = [sidePieces[0]];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const other of sidePieces) {
      if (visited.has(other.uid)) continue;
      const dist = Math.abs(curr.row - other.row) + Math.abs(curr.col - other.col);
      if (dist === 1) {
        visited.add(other.uid);
        queue.push(other);
      }
    }
  }

  return visited.size === sidePieces.length;
}

function getPieceKindLabel(kind: PieceKind): string {
  if (kind === 'STEEPLE') return '첨탑';
  if (kind === 'NAVE') return '성당 본관';
  return '집';
}

function createDefaultVillageRoom(roomId: number): NetVillageRoomData {
  return {
    roomId,
    status: 'EMPTY',
    phase: 'SETUP_CHURCH',
    players: [],
    pot: 0,
    waitlist: [],
    spectators: [],
    baseTimeout: DEFAULT_TIMEOUT_SEC,
    anteBet: 1000,
    roundNumber: 1,
    clergyman: { ...CENTER_POS },
    pieces: [],
    currentTurn: 1,
    setupChurchStep: 0,
    selectedPieceUid: null,
    lastMovedUid: null,
    turnDeadline: null,
    turnNotice: '',
    winnerAnnouncement: '',
    roundWinnerId: null,
    waitingSince: null,
  };
}

export default function Page11(): React.ReactElement {
  const [appMode, setAppMode] = useState<
    'HOME' | 'SOLO' | 'NET_LOBBY' | 'NET_ROOM' | 'HALL_OF_FAME'
  >('HOME');

  const [mySessionId] = useState<string>(() => {
    const saved = sessionStorage.getItem('kirchdorf_net_uid');
    if (saved) return saved;
    const generated = `kd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('kirchdorf_net_uid', generated);
    return generated;
  });

  // 넷게임 상태
  const [rooms, setRooms] = useState<NetVillageRoomData[]>(
    [1, 2, 3, 4].map(createDefaultVillageRoom)
  );
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [joinModalRoom, setJoinModalRoom] = useState<NetVillageRoomData | null>(null);
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
  const [soloPlayers, setSoloPlayers] = useState<VillagePlayer[]>([
    {
      id: '1',
      name: '단풍마을',
      side: 1,
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
    },
    {
      id: '2',
      name: '호두마을',
      side: 2,
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
    },
  ]);

  const [soloName1, setSoloName1] = useState<string>('단풍마을');
  const [soloName2, setSoloName2] = useState<string>('호두마을');
  const [soloAnteBet, setSoloAnteBet] = useState<number>(1000);
  const [soloTimeoutSec, setSoloTimeoutSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRemainingSec, setSoloRemainingSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRoundNum, setSoloRoundNum] = useState<number>(1);
  const [soloPot, setSoloPot] = useState<number>(0);

  const [soloPhase, setSoloPhase] = useState<NetPhase>('SETUP_CHURCH');
  const [soloSetupChurchStep, setSoloSetupChurchStep] = useState<number>(0);
  const [soloRidgeChoice, setSoloRidgeChoice] = useState<RidgeDir>('V');
  const [soloClergyman, setSoloClergyman] = useState<ClergymanPos>({ ...CENTER_POS });
  const [soloPieces, setSoloPieces] = useState<VillagePiece[]>([]);
  const [soloTurn, setSoloTurn] = useState<PlayerSide>(1);
  const [soloSelectedUid, setSoloSelectedUid] = useState<string | null>(null);
  const [soloLastMovedUid, setSoloLastMovedUid] = useState<string | null>(null);

  const [netRidgeChoice, setNetRidgeChoice] = useState<RidgeDir>('V');
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

  const playSound = (kind: 'place' | 'move' | 'chip' | 'win' | 'tick') => {
    try {
      const winWithWebkit = window as unknown as {
        webkitAudioContext?: typeof AudioContext;
      };
      const AudioCtx = window.AudioContext || winWithWebkit.webkitAudioContext;
      if (!AudioCtx) return;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioCtx();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }

      const notesMap: Record<typeof kind, number[]> = {
        place: [246.94, 185.0],
        move: [293.66, 392.0],
        chip: [880, 1174.66],
        win: [523.25, 659.25, 783.99, 1046.5, 1318.5],
        tick: [987.77],
      };

      notesMap[kind].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === 'place' || kind === 'move' ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.055);
        gain.gain.setValueAtTime(0.18, ctx.currentTime + idx * 0.055);
        gain.gain.exponentialRampToValueAtTime(
          0.001,
          ctx.currentTime + idx * 0.055 + 0.18
        );
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.055);
        osc.stop(ctx.currentTime + idx * 0.055 + 0.18);
      });
    } catch {
      // 오디오 정책 예외 무시
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
    const key = type === 'SOLO' ? 'kirchdorf_hof_solo' : 'kirchdorf_hof_net';
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
    const key = type === 'SOLO' ? 'kirchdorf_hof_solo' : 'kirchdorf_hof_net';
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
      const roomRef = ref(db, `kirchdorf_rooms/room_${roomIdToLeave}`);
      try {
        await runTransaction(roomRef, (roomData) => {
          if (!roomData) return roomData;
          const room = roomData as NetVillageRoomData;
          const filteredPlayers = (room.players || []).filter((p) => p.id !== mySessionId);
          const filteredWaitlist = (room.waitlist || []).filter((w) => w.id !== mySessionId);
          const filteredSpectators = (room.spectators || []).filter(
            (s) => s.id !== mySessionId
          );

          if (filteredPlayers.length === 0 && filteredSpectators.length === 0) {
            return createDefaultVillageRoom(room.roomId);
          }

          room.players = filteredPlayers.map((p, idx) => ({
            ...p,
            side: idx === 0 ? 1 : 2,
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

    const presenceRef = ref(
      db,
      `kirchdorf_presence/room_${selectedRoomId}/${mySessionId}`
    );
    void set(presenceRef, { online: true, joinedAt: Date.now() });
    const disconnectHook = onDisconnect(presenceRef);
    void disconnectHook.remove();

    const handleWindowClose = () => {
      void leaveRoomById(selectedRoomId);
    };

    window.addEventListener('beforeunload', handleWindowClose);
    window.addEventListener('pagehide', handleWindowClose);

    return () => {
      window.removeEventListener('beforeunload', handleWindowClose);
      window.removeEventListener('pagehide', handleWindowClose);
      void disconnectHook.cancel();
    };
  }, [appMode, selectedRoomId, mySessionId, leaveRoomById]);

  // =========================================================================
  // Firebase 실시간 넷게임 동기화
  // =========================================================================
  useEffect(() => {
    if (appMode !== 'NET_LOBBY' && appMode !== 'NET_ROOM') return;

    const ensureRoomsExist = async () => {
      for (const id of [1, 2, 3, 4]) {
        const roomRef = ref(db, `kirchdorf_rooms/room_${id}`);
        const snap = await get(roomRef);
        if (!snap.exists()) {
          await set(roomRef, createDefaultVillageRoom(id));
        }
      }
    };
    void ensureRoomsExist();

    const roomsRef = ref(db, 'kirchdorf_rooms');
    const unsubscribe = onValue(roomsRef, (snapshot) => {
      const data = snapshot.val() as Record<string, Partial<NetVillageRoomData>> | null;
      if (!data) return;

      const loadedRooms: NetVillageRoomData[] = [1, 2, 3, 4].map((id) => {
        const rData = data[`room_${id}`];
        const def = createDefaultVillageRoom(id);
        if (!rData) return def;

        return {
          ...def,
          ...rData,
          phase: rData.phase || 'SETUP_CHURCH',
          players: (rData.players || []).map((p: VillagePlayer, idx: number) => ({
            ...p,
            side: p.side === 2 ? 2 : idx === 0 ? 1 : 2,
            chips: typeof p.chips === 'number' ? p.chips : INITIAL_CHIPS,
            wins: typeof p.wins === 'number' ? p.wins : 0,
            currentBet: typeof p.currentBet === 'number' ? p.currentBet : 0,
            isEliminated: Boolean(p.isEliminated),
          })),
          pot: typeof rData.pot === 'number' ? rData.pot : 0,
          waitlist: rData.waitlist || [],
          spectators: rData.spectators || [],
          clergyman: rData.clergyman || { ...CENTER_POS },
          pieces: Array.isArray(rData.pieces) ? rData.pieces : [],
          currentTurn: rData.currentTurn === 2 ? 2 : 1,
          setupChurchStep:
            typeof rData.setupChurchStep === 'number' ? rData.setupChurchStep : 0,
          selectedPieceUid: rData.selectedPieceUid ?? null,
          lastMovedUid: rData.lastMovedUid ?? null,
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

  const settleNetRound = (room: NetVillageRoomData, winnerSide: PlayerSide) => {
    const winner = room.players.find((p) => p.side === winnerSide) || room.players[0];
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
    room.selectedPieceUid = null;

    if (anyBusted) {
      room.status = 'MATCH_OVER';
      room.winnerAnnouncement = `👑 최종 우승! ${winner.name}님이 마을과 교회(첨탑·본관)를 완성하며 판돈을 모두 차지했습니다!`;
    } else {
      room.status = 'ROUND_OVER';
      room.winnerAnnouncement = `🎊 ${winner.name}님 마을 완성 승리! 판돈 ${wonPot.toLocaleString()}칩 획득! (${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}칩)`;
    }

    saveHallOfFameRecord('NET', {
      name: winner.name,
      scoreOrLevel: `${winnerObj.wins}승 · 보유 ${winnerObj.chips.toLocaleString()}칩`,
    });
  };

  const handleNetTurnTimeout = useCallback(async (room: NetVillageRoomData) => {
    const roomRef = ref(db, `kirchdorf_rooms/room_${room.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const r = roomData as NetVillageRoomData;
      if (r.status !== 'PLAYING') return r;

      const side = r.currentTurn;
      const actor = r.players.find((p) => p.side === side);
      const pieces = [...(r.pieces || [])];
      const clergy = r.clergyman || { ...CENTER_POS };

      if (r.phase === 'SETUP_CHURCH') {
        const corners = [
          { row: 0, col: 0 },
          { row: 0, col: BOARD_SIZE - 1 },
          { row: BOARD_SIZE - 1, col: 0 },
          { row: BOARD_SIZE - 1, col: BOARD_SIZE - 1 },
        ];
        const openCorner = corners.find((c) => !findPieceAt(pieces, c.row, c.col));
        if (openCorner) {
          const step = r.setupChurchStep;
          const isFirstOfPair = step % 2 === 0;
          const kind: PieceKind = isFirstOfPair ? 'STEEPLE' : 'NAVE';
          pieces.push({
            uid: `${side}_${kind}_${Date.now()}`,
            owner: side,
            kind,
            row: openCorner.row,
            col: openCorner.col,
            ridge: 'V',
          });
          r.pieces = pieces;
          r.setupChurchStep = step + 1;
          if (step === 1) {
            r.currentTurn = 2;
          } else if (step === 3) {
            r.phase = 'SETUP_HOUSES';
            r.currentTurn = 1;
          }
          r.turnDeadline = Date.now() + r.baseTimeout * 1000;
          r.turnNotice = `⏰ 시간 초과 자동 배치(${formatCoord(openCorner.row, openCorner.col)})!`;
        }
        return r;
      }

      if (r.phase === 'SETUP_HOUSES') {
        const candidates: { row: number; col: number }[] = [];
        for (let row = 0; row < BOARD_SIZE; row++) {
          for (let col = 0; col < BOARD_SIZE; col++) {
            if (canPlaceHouseAt(pieces, clergy, side, row, col)) {
              candidates.push({ row, col });
            }
          }
        }
        if (candidates.length > 0) {
          const chosen = candidates[Math.floor(Math.random() * candidates.length)];
          const houseIdx = pieces.filter((p) => p.owner === side && p.kind === 'HOUSE').length;
          pieces.push({
            uid: `${side}_HOUSE_${houseIdx}_${Date.now()}`,
            owner: side,
            kind: 'HOUSE',
            row: chosen.row,
            col: chosen.col,
            ridge: 'V',
          });
          r.pieces = pieces;
        }
        const totalPlaced = pieces.length;
        const expectedTotal = 4 + HOUSES_PER_PLAYER * 2;
        if (totalPlaced >= expectedTotal) {
          r.phase = 'MOVING';
          r.currentTurn = 1;
          r.turnNotice = `⏰ 시간 초과! 모든 집 배치 완료 — 이동 단계 시작! 밝은 마을 차례입니다.`;
        } else {
          r.currentTurn = side === 1 ? 2 : 1;
          r.turnNotice = `⏰ 시간 초과 자동 집 배치! 다음 차례로 넘어갑니다.`;
        }
        r.turnDeadline = Date.now() + r.baseTimeout * 1000;
        return r;
      }

      // MOVING 단계 자동 수
      const myPieces = pieces.filter((p) => p.owner === side);
      for (const p of myPieces) {
        const opts = getPieceMoveOptions(pieces, clergy, p);
        if (opts.length > 0) {
          const opt = opts[Math.floor(Math.random() * opts.length)];
          if (opt.kind === 'CLERGY_SWAP') {
            r.clergyman = { row: p.row, col: p.col };
          }
          p.row = opt.row;
          p.col = opt.col;
          p.ridge = p.ridge === 'V' ? 'H' : 'V';
          r.lastMovedUid = p.uid;
          r.selectedPieceUid = null;
          if (checkVillageVictory(pieces, side)) {
            settleNetRound(r, side);
            return r;
          }
          break;
        }
      }
      const nextSide: PlayerSide = side === 1 ? 2 : 1;
      const nextPlayer = r.players.find((pl) => pl.side === nextSide);
      r.currentTurn = nextSide;
      r.turnDeadline = Date.now() + r.baseTimeout * 1000;
      r.turnNotice = `⏰ ${actor?.name ?? ''}님 시간 초과 자동 이동 👉 ${nextPlayer?.name ?? ''}님 차례!`;
      return r;
    });
  }, []);

  useEffect(() => {
    if (appMode !== 'NET_ROOM' || !activeNetRoom) {
      setRemainingSeconds(DEFAULT_TIMEOUT_SEC);
      setWaitingCountdownSec(420);
      return;
    }

    const timer = window.setInterval(() => {
      const now = Date.now();

      if (activeNetRoom.status === 'WAITING' && activeNetRoom.waitingSince) {
        const elapsedSec = (now - activeNetRoom.waitingSince) / 1000;
        const leftSec = Math.max(0, 420 - Math.floor(elapsedSec));
        setWaitingCountdownSec(leftSec);

        if (elapsedSec >= 425) {
          const roomRef = ref(db, `kirchdorf_rooms/room_${activeNetRoom.roomId}`);
          void set(roomRef, createDefaultVillageRoom(activeNetRoom.roomId));
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
          void handleNetTurnTimeout(activeNetRoom);
        }
      }
    }, 300);

    return () => window.clearInterval(timer);
  }, [appMode, activeNetRoom, handleNetTurnTimeout]);

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
          showToast('⏰ 제한 시간이 지나 턴이 넘어갑니다.', 'info');
          setSoloSelectedUid(null);
          setSoloTurn((t) => (t === 1 ? 2 : 1));
          setSoloRemainingSec(soloTimeoutSec);
          lastCountdownSpokenRef.current = null;
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [appMode, gameState, soloTimeoutSec]);

  const handleEnterRoomSubmit = async (asSpectator = false) => {
    if (!joinModalRoom) return;
    const trimmedName = joinPlayerName ? joinPlayerName.trim() : '';
    if (!trimmedName) {
      alert('참가할 이름을 입력해주세요!');
      return;
    }

    const roomRef = ref(db, `kirchdorf_rooms/room_${joinModalRoom.roomId}`);

    try {
      let joinResultType = 'PLAYER';

      await runTransaction(roomRef, (roomData) => {
        const room: NetVillageRoomData =
          roomData || createDefaultVillageRoom(joinModalRoom.roomId);
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
          const side: PlayerSide = room.players.length === 0 ? 1 : 2;
          const newPlayer: VillagePlayer = {
            id: mySessionId,
            name: trimmedName,
            side,
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
    const roomRef = ref(db, `kirchdorf_rooms/room_${activeNetRoom.roomId}`);
    await update(roomRef, {
      anteBet: newAnteBet,
      baseTimeout: clampedTimeout,
      waitingSince: Date.now(),
    });
  };

  const handleStartNetRound = async (isNextRound = false) => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `kirchdorf_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetVillageRoomData;
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
      const nextActive: VillagePlayer[] = [...survivingPlayers];
      const remainingWaitlist: WaitlistPlayer[] = [];

      for (const w of waitlist) {
        if (nextActive.length < 2) {
          nextActive.push({
            id: w.id,
            name: w.name,
            side: 2,
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

      const preparedPlayers: VillagePlayer[] = orderedActive.map((p, idx) => {
        collectedPot += equalStake;
        return {
          ...p,
          side: idx === 0 ? 1 : 2,
          chips: p.chips - equalStake,
          currentBet: equalStake,
          isEliminated: false,
        };
      });

      room.status = 'PLAYING';
      room.phase = 'SETUP_CHURCH';
      room.setupChurchStep = 0;
      room.roundNumber = nextRound;
      room.players = preparedPlayers;
      room.pot = collectedPot;
      room.waitlist = remainingWaitlist;
      room.clergyman = { ...CENTER_POS };
      room.pieces = [];
      room.currentTurn = 1;
      room.selectedPieceUid = null;
      room.lastMovedUid = null;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.winnerAnnouncement = '';
      room.roundWinnerId = null;
      room.turnNotice = `⛪ [${nextRound}국] 판돈 ${equalStake.toLocaleString()}칩! 중앙 사제 대기 중 — ${preparedPlayers[0].name}님(밝은 원목)이 모서리에 첨탑을 배치하세요.`;
      room.waitingSince = null;

      return room;
    });

    triggerChipAnimation('전원', activeNetRoom.anteBet, '#8d6e63');
  };

  /**
   * 넷게임 보드 칸 클릭 처리
   */
  const handleNetCellClick = async (r: number, c: number) => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const actor = activeNetRoom.players.find((p) => p.side === activeNetRoom.currentTurn);
    if (!actor || actor.id !== mySessionId) return;

    const roomRef = ref(db, `kirchdorf_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetVillageRoomData;
      if (room.status !== 'PLAYING') return room;

      const side = room.currentTurn;
      const currentActor = room.players.find((p) => p.side === side);
      if (!currentActor || currentActor.id !== mySessionId) return room;

      const pieces = [...(room.pieces || [])];
      const clergy = room.clergyman || { ...CENTER_POS };

      // 1) 교회(첨탑·본관) 대각 모서리 배치 단계
      if (room.phase === 'SETUP_CHURCH') {
        if (!isCorner(r, c) || findPieceAt(pieces, r, c)) {
          return room;
        }
        const step = room.setupChurchStep;
        // step 0: Side 1 Steeple, step 1: Side 1 Nave (대각선 반대 모서리)
        if (step === 1) {
          const firstLight = pieces.find((p) => p.owner === 1);
          if (firstLight) {
            const oppR = BOARD_SIZE - 1 - firstLight.row;
            const oppC = BOARD_SIZE - 1 - firstLight.col;
            if (r !== oppR || c !== oppC) {
              return room;
            }
          }
        }
        // step 3: Side 2 Nave (남은 대각선 반대 모서리)
        if (step === 3) {
          const firstDark = pieces.find((p) => p.owner === 2);
          if (firstDark) {
            const oppR = BOARD_SIZE - 1 - firstDark.row;
            const oppC = BOARD_SIZE - 1 - firstDark.col;
            if (r !== oppR || c !== oppC) {
              return room;
            }
          }
        }

        const kind: PieceKind = step % 2 === 0 ? 'STEEPLE' : 'NAVE';
        const newPiece: VillagePiece = {
          uid: `${side}_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
          owner: side,
          kind,
          row: r,
          col: c,
          ridge: netRidgeChoice,
        };
        pieces.push(newPiece);
        room.pieces = pieces;
        room.lastMovedUid = newPiece.uid;
        room.setupChurchStep = step + 1;
        room.turnDeadline = Date.now() + room.baseTimeout * 1000;

        if (step === 0) {
          room.turnNotice = `⛪ ${currentActor.name}님이 ${formatCoord(r, c)} 모서리에 첨탑 배치! 대각선 반대 모서리에 성당 본관을 놓으세요.`;
        } else if (step === 1) {
          const secondPlayer = room.players.find((p) => p.side === 2);
          room.currentTurn = 2;
          room.turnNotice = `⛪ 밝은 교회 배치 완료! ${secondPlayer?.name ?? '어두운 마을'}님이 남은 두 모서리에 첨탑과 본관을 배치하세요.`;
        } else if (step === 2) {
          room.turnNotice = `⛪ ${currentActor.name}님이 ${formatCoord(r, c)} 모서리에 첨탑 배치! 마지막 대각선 모서리에 본관을 놓으세요.`;
        } else {
          const firstPlayer = room.players.find((p) => p.side === 1);
          room.phase = 'SETUP_HOUSES';
          room.currentTurn = 1;
          room.turnNotice = `🏡 교회 배치 완료! 이제 집(${HOUSES_PER_PLAYER}채씩)을 번갈아 놓습니다(직교 인접 금지). ${firstPlayer?.name ?? ''}님 차례!`;
        }
        return room;
      }

      // 2) 집 배치 단계
      if (room.phase === 'SETUP_HOUSES') {
        if (!canPlaceHouseAt(pieces, clergy, side, r, c)) {
          return room;
        }
        const houseCount = pieces.filter((p) => p.owner === side && p.kind === 'HOUSE').length;
        if (houseCount >= HOUSES_PER_PLAYER) return room;

        const housePiece: VillagePiece = {
          uid: `${side}_HOUSE_${houseCount}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
          owner: side,
          kind: 'HOUSE',
          row: r,
          col: c,
          ridge: netRidgeChoice,
        };
        pieces.push(housePiece);
        room.pieces = pieces;
        room.lastMovedUid = housePiece.uid;
        room.turnDeadline = Date.now() + room.baseTimeout * 1000;

        const expectedTotal = 4 + HOUSES_PER_PLAYER * 2;
        if (pieces.length >= expectedTotal) {
          const firstPlayer = room.players.find((p) => p.side === 1);
          room.phase = 'MOVING';
          room.currentTurn = 1;
          room.turnNotice = `🏘️ 모든 집 배치 완료! 이동 단계 시작 — 용마루 방향으로 이동 후 90° 회전합니다. ${firstPlayer?.name ?? ''}님 차례!`;
        } else {
          const nextSide: PlayerSide = side === 1 ? 2 : 1;
          const nextPlayer = room.players.find((p) => p.side === nextSide);
          room.currentTurn = nextSide;
          room.turnNotice = `🏠 ${currentActor.name}님이 ${formatCoord(r, c)}에 집 배치 👉 ${nextPlayer?.name ?? ''}님 집 배치 차례!`;
        }
        return room;
      }

      // 3) 이동 단계 (선택 & 이동/사제 자리교환 + 90° 회전)
      const clickedPiece = findPieceAt(pieces, r, c);
      if (clickedPiece && clickedPiece.owner === side) {
        room.selectedPieceUid =
          room.selectedPieceUid === clickedPiece.uid ? null : clickedPiece.uid;
        return room;
      }

      if (!room.selectedPieceUid) return room;
      const movingPiece = pieces.find(
        (p) => p.uid === room.selectedPieceUid && p.owner === side
      );
      if (!movingPiece) return room;

      const options = getPieceMoveOptions(pieces, clergy, movingPiece);
      const chosenOpt = options.find((o) => o.row === r && o.col === c);
      if (!chosenOpt) return room;

      if (chosenOpt.kind === 'CLERGY_SWAP') {
        room.clergyman = { row: movingPiece.row, col: movingPiece.col };
      }
      movingPiece.row = chosenOpt.row;
      movingPiece.col = chosenOpt.col;
      movingPiece.ridge = movingPiece.ridge === 'V' ? 'H' : 'V';
      room.pieces = pieces;
      room.selectedPieceUid = null;
      room.lastMovedUid = movingPiece.uid;

      if (checkVillageVictory(pieces, side)) {
        settleNetRound(room, side);
        return room;
      }

      const nextSide: PlayerSide = side === 1 ? 2 : 1;
      const nextPlayer = room.players.find((p) => p.side === nextSide);
      const actionDesc =
        chosenOpt.kind === 'CLERGY_SWAP'
          ? `사제와 자리 교환 후 ${formatCoord(r, c)} 이동 & 90° 회전`
          : `${formatCoord(r, c)}로 이동 & 90° 회전`;
      room.currentTurn = nextSide;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `🪵 ${currentActor.name}님 ${getPieceKindLabel(movingPiece.kind)} ${actionDesc} 👉 ${nextPlayer?.name ?? ''}님 차례!`;
      return room;
    });

    playSound('move');
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
    const p1Name = soloName1.trim() || '단풍마을';
    const p2Name = soloName2.trim() || '호두마을';
    setSoloPlayers([
      {
        id: '1',
        name: p1Name,
        side: 1,
        chips: INITIAL_CHIPS,
        wins: 0,
        currentBet: 0,
        isEliminated: false,
      },
      {
        id: '2',
        name: p2Name,
        side: 2,
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
      { ...prev[1], side: 1 },
      { ...prev[0], side: 2 },
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
            { ...basePlayers[1], side: 1 as const },
            { ...basePlayers[0], side: 2 as const },
          ]
        : [
            { ...basePlayers[0], side: 1 as const },
            { ...basePlayers[1], side: 2 as const },
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
    const notice = `⛪ [${nextRound}국] 판돈 ${equalStake.toLocaleString()}칩! 중앙 사제 대기 중 — ${preparedPlayers[0].name}님(밝은 원목)이 모서리에 첨탑을 놓으세요.`;

    setSoloRoundNum(nextRound);
    setSoloPot(totalPot);
    setSoloPlayers(preparedPlayers);
    setSoloPhase('SETUP_CHURCH');
    setSoloSetupChurchStep(0);
    setSoloClergyman({ ...CENTER_POS });
    setSoloPieces([]);
    setSoloTurn(1);
    setSoloSelectedUid(null);
    setSoloLastMovedUid(null);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setWinnerAnnouncement('');
    setShowFireworks(false);
    setTurnNotice(notice);
    speakKorean(notice);
    setGameState('PLAYING');
  };

  const settleSoloRound = (winnerSide: PlayerSide, finalPieces: VillagePiece[]) => {
    void finalPieces;
    const winner = soloPlayers.find((p) => p.side === winnerSide) || soloPlayers[0];
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
      ? `👑 최종 우승! ${winner.name}님이 마을과 교회(첨탑·본관)를 완성하며 상대 판돈을 모두 차지했습니다!`
      : `🎊 ${winner.name}님 마을 완성 승리! 판돈 ${soloPot.toLocaleString()}칩 획득! (${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}칩)`;

    setSoloPlayers(settledPlayers);
    setSoloPot(0);
    setTurnNotice('');
    setSoloSelectedUid(null);
    setWinnerAnnouncement(announcement);
    setGameState(anyBusted ? 'MATCH_OVER' : 'ROUND_OVER');
    triggerFireworksCelebration(announcement);

    saveHallOfFameRecord('SOLO', {
      name: winner.name,
      scoreOrLevel: `${winnerObj.wins}승 · 보유 ${winnerObj.chips.toLocaleString()}칩`,
    });
  };

  const handleSoloCellClick = (r: number, c: number) => {
    if (gameState !== 'PLAYING') return;
    const currentActor = soloPlayers.find((p) => p.side === soloTurn) || soloPlayers[0];

    if (soloPhase === 'SETUP_CHURCH') {
      if (!isCorner(r, c) || findPieceAt(soloPieces, r, c)) {
        showToast('교회(첨탑·본관)는 모서리 칸에만 배치할 수 있습니다!', 'danger');
        return;
      }
      if (soloSetupChurchStep === 1) {
        const firstLight = soloPieces.find((p) => p.owner === 1);
        if (
          firstLight &&
          (r !== BOARD_SIZE - 1 - firstLight.row || c !== BOARD_SIZE - 1 - firstLight.col)
        ) {
          showToast('성당 본관은 첫 번째 첨탑과 대각선 반대 모서리에 놓아야 합니다!', 'danger');
          return;
        }
      }
      if (soloSetupChurchStep === 3) {
        const firstDark = soloPieces.find((p) => p.owner === 2);
        if (
          firstDark &&
          (r !== BOARD_SIZE - 1 - firstDark.row || c !== BOARD_SIZE - 1 - firstDark.col)
        ) {
          showToast('성당 본관은 첫 번째 첨탑과 대각선 반대 모서리에 놓아야 합니다!', 'danger');
          return;
        }
      }

      playSound('place');
      const kind: PieceKind = soloSetupChurchStep % 2 === 0 ? 'STEEPLE' : 'NAVE';
      const created: VillagePiece = {
        uid: `solo_${soloTurn}_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        owner: soloTurn,
        kind,
        row: r,
        col: c,
        ridge: soloRidgeChoice,
      };
      const nextPieces = [...soloPieces, created];
      const nextStep = soloSetupChurchStep + 1;

      setSoloPieces(nextPieces);
      setSoloSetupChurchStep(nextStep);
      setSoloLastMovedUid(created.uid);
      setSoloRemainingSec(soloTimeoutSec);
      lastCountdownSpokenRef.current = null;

      if (nextStep === 1) {
        const msg = `⛪ ${currentActor.name}님이 ${formatCoord(r, c)} 모서리에 첨탑 배치! 대각선 반대 모서리에 성당 본관을 놓으세요.`;
        setTurnNotice(msg);
        speakKorean(msg);
      } else if (nextStep === 2) {
        const secondPlayer = soloPlayers.find((p) => p.side === 2)!;
        setSoloTurn(2);
        const msg = `⛪ ${currentActor.name}님 교회 배치 완료! ${secondPlayer.name}님이 남은 두 모서리에 첨탑과 본관을 배치하세요.`;
        setTurnNotice(msg);
        speakKorean(msg);
      } else if (nextStep === 3) {
        const msg = `⛪ ${currentActor.name}님이 ${formatCoord(r, c)} 모서리에 첨탑 배치! 마지막 대각선 모서리에 본관을 놓으세요.`;
        setTurnNotice(msg);
        speakKorean(msg);
      } else {
        const firstPlayer = soloPlayers.find((p) => p.side === 1)!;
        setSoloPhase('SETUP_HOUSES');
        setSoloTurn(1);
        const msg = `🏡 교회 배치 완료! 이제 집(${HOUSES_PER_PLAYER}채씩)을 번갈아 놓습니다(직교 인접 금지). ${firstPlayer.name}님 차례!`;
        setTurnNotice(msg);
        speakKorean(msg);
      }
      return;
    }

    if (soloPhase === 'SETUP_HOUSES') {
      if (!canPlaceHouseAt(soloPieces, soloClergyman, soloTurn, r, c)) {
        showToast('자신의 기존 건물과 상하좌우(직교)로 인접한 칸에는 집을 놓을 수 없습니다!', 'danger');
        return;
      }
      const houseCount = soloPieces.filter(
        (p) => p.owner === soloTurn && p.kind === 'HOUSE'
      ).length;
      if (houseCount >= HOUSES_PER_PLAYER) return;

      playSound('place');
      const newHouse: VillagePiece = {
        uid: `solo_${soloTurn}_HOUSE_${houseCount}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        owner: soloTurn,
        kind: 'HOUSE',
        row: r,
        col: c,
        ridge: soloRidgeChoice,
      };
      const nextPieces = [...soloPieces, newHouse];
      setSoloPieces(nextPieces);
      setSoloLastMovedUid(newHouse.uid);
      setSoloRemainingSec(soloTimeoutSec);
      lastCountdownSpokenRef.current = null;

      const expectedTotal = 4 + HOUSES_PER_PLAYER * 2;
      if (nextPieces.length >= expectedTotal) {
        const firstPlayer = soloPlayers.find((p) => p.side === 1)!;
        setSoloPhase('MOVING');
        setSoloTurn(1);
        const msg = `🏘️ 모든 집 배치 완료! 이동 단계 시작 — 용마루 방향으로 이동 후 90° 회전합니다. ${firstPlayer.name}님 차례!`;
        setTurnNotice(msg);
        speakKorean(msg);
      } else {
        const nextSide: PlayerSide = soloTurn === 1 ? 2 : 1;
        const nextPlayer = soloPlayers.find((p) => p.side === nextSide)!;
        setSoloTurn(nextSide);
        const msg = `🏠 ${currentActor.name}님이 ${formatCoord(r, c)}에 집 배치 👉 ${nextPlayer.name}님 차례!`;
        setTurnNotice(msg);
        speakKorean(msg);
      }
      return;
    }

    // MOVING 단계
    const clickedPiece = findPieceAt(soloPieces, r, c);
    if (clickedPiece && clickedPiece.owner === soloTurn) {
      setSoloSelectedUid((prev) => (prev === clickedPiece.uid ? null : clickedPiece.uid));
      return;
    }

    if (!soloSelectedUid) return;
    const movingPiece = soloPieces.find(
      (p) => p.uid === soloSelectedUid && p.owner === soloTurn
    );
    if (!movingPiece) return;

    const options = getPieceMoveOptions(soloPieces, soloClergyman, movingPiece);
    const chosenOpt = options.find((o) => o.row === r && o.col === c);
    if (!chosenOpt) {
      showToast('용마루 방향의 열린 칸(또는 막힌 피스의 사제 자리 교환)만 선택할 수 있습니다!', 'danger');
      return;
    }

    playSound('move');
    let nextClergy = soloClergyman;
    if (chosenOpt.kind === 'CLERGY_SWAP') {
      nextClergy = { row: movingPiece.row, col: movingPiece.col };
      setSoloClergyman(nextClergy);
    }

    const nextRidge: RidgeDir = movingPiece.ridge === 'V' ? 'H' : 'V';
    const updatedPieces = soloPieces.map((p) =>
      p.uid === movingPiece.uid
        ? { ...p, row: chosenOpt.row, col: chosenOpt.col, ridge: nextRidge }
        : p
    );

    setSoloPieces(updatedPieces);
    setSoloSelectedUid(null);
    setSoloLastMovedUid(movingPiece.uid);

    if (checkVillageVictory(updatedPieces, soloTurn)) {
      settleSoloRound(soloTurn, updatedPieces);
      return;
    }

    const nextSide: PlayerSide = soloTurn === 1 ? 2 : 1;
    const nextPlayer = soloPlayers.find((p) => p.side === nextSide)!;
    const desc =
      chosenOpt.kind === 'CLERGY_SWAP'
        ? `사제와 자리 교환 후 ${formatCoord(r, c)} 이동 & 90° 회전`
        : `${formatCoord(r, c)}로 이동 & 90° 회전`;
    const msg = `🪵 ${currentActor.name}님 ${getPieceKindLabel(movingPiece.kind)} ${desc} 👉 ${nextPlayer.name}님 차례!`;
    setSoloTurn(nextSide);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setTurnNotice(msg);
    speakKorean(msg);
  };

  // =========================================================================
  // 원목 건축물 피스 렌더링 (첨탑 / 본관 / 집 + 지붕 용마루 방향)
  // =========================================================================
  const renderVillagePieceVisual = (
    piece: VillagePiece,
    isSelected: boolean,
    isLastMoved: boolean
  ): React.ReactElement => {
    const sideClass = piece.owner === 1 ? 'maple-light' : 'walnut-dark';
    const kindClass = `kind-${piece.kind.toLowerCase()}`;
    const ridgeClass = piece.ridge === 'V' ? 'ridge-vertical' : 'ridge-horizontal';

    return (
      <div
        className={`kirch-piece ${sideClass} ${kindClass} ${ridgeClass} ${
          isSelected ? 'selected-piece' : ''
        } ${isLastMoved ? 'last-moved-piece' : ''}`}
        title={`${piece.owner === 1 ? '밝은 원목' : '어두운 원목'} · ${getPieceKindLabel(
          piece.kind
        )} · 이동방향: ${piece.ridge === 'V' ? '상하(↕)' : '좌우(↔)'}`}
      >
        <div className="pitched-roof">
          <span className="ridge-crest" />
        </div>
        <div className="piece-body">
          <span className="ridge-arrow">{piece.ridge === 'V' ? '↕' : '↔'}</span>
        </div>
      </div>
    );
  };

  // =========================================================================
  // 7x7 원목 보드 렌더링
  // =========================================================================
  const renderKirchdorfBoard = (
    phase: NetPhase,
    currentTurn: PlayerSide,
    canInteract: boolean,
    pieces: VillagePiece[],
    clergyman: ClergymanPos,
    setupChurchStep: number,
    selectedPieceUid: string | null,
    lastMovedUid: string | null,
    onCellClick: (r: number, c: number) => void
  ): React.ReactElement => {
    const selectedPiece = selectedPieceUid
      ? pieces.find((p) => p.uid === selectedPieceUid) || null
      : null;
    const moveOptions =
      canInteract && phase === 'MOVING' && selectedPiece
        ? getPieceMoveOptions(pieces, clergyman, selectedPiece)
        : [];
    const moveMap = new Map<string, MoveOption['kind']>();
    for (const opt of moveOptions) {
      moveMap.set(`${opt.row},${opt.col}`, opt.kind);
    }

    const isCellHighlighted = (r: number, c: number): boolean => {
      if (!canInteract) return false;
      if (phase === 'SETUP_CHURCH') {
        if (!isCorner(r, c) || findPieceAt(pieces, r, c)) return false;
        if (setupChurchStep === 1) {
          const firstLight = pieces.find((p) => p.owner === 1);
          if (firstLight) {
            return (
              r === BOARD_SIZE - 1 - firstLight.row &&
              c === BOARD_SIZE - 1 - firstLight.col
            );
          }
        }
        if (setupChurchStep === 3) {
          const firstDark = pieces.find((p) => p.owner === 2);
          if (firstDark) {
            return (
              r === BOARD_SIZE - 1 - firstDark.row &&
              c === BOARD_SIZE - 1 - firstDark.col
            );
          }
        }
        return true;
      }
      if (phase === 'SETUP_HOUSES') {
        return canPlaceHouseAt(pieces, clergyman, currentTurn, r, c);
      }
      if (phase === 'MOVING') {
        if (moveMap.has(`${r},${c}`)) return true;
        const p = findPieceAt(pieces, r, c);
        return Boolean(p && p.owner === currentTurn);
      }
      return false;
    };

    return (
      <div className="kirch-board-frame">
        <div className="kirch-coord-top">
          <span className="coord-spacer" />
          {['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((colLabel) => (
            <span key={colLabel} className="kirch-coord-text">
              {colLabel}
            </span>
          ))}
        </div>

        <div className="kirch-board-body">
          <div className="kirch-coord-left">
            {[1, 2, 3, 4, 5, 6, 7].map((rowLabel) => (
              <span key={rowLabel} className="kirch-coord-text">
                {rowLabel}
              </span>
            ))}
          </div>

          <div className="kirch-grid-7x7">
            {Array.from({ length: BOARD_SIZE }, (_, r) =>
              Array.from({ length: BOARD_SIZE }, (_, c) => {
                const piece = findPieceAt(pieces, r, c);
                const hasClergy = clergyman.row === r && clergyman.col === c;
                const highlight = isCellHighlighted(r, c);
                const moveKind = moveMap.get(`${r},${c}`);
                const isCenter = r === CENTER_POS.row && c === CENTER_POS.col;
                const isEdgeZone = isEdgeOrCorner(r, c);

                return (
                  <button
                    key={`${r}-${c}`}
                    type="button"
                    disabled={!canInteract}
                    onClick={() => onCellClick(r, c)}
                    className={`kirch-cell ${isCenter ? 'center-square' : ''} ${
                      isEdgeZone ? 'edge-zone-square' : ''
                    } ${highlight ? 'cell-highlight' : ''} ${
                      moveKind === 'CLERGY_SWAP' ? 'cell-clergy-swap' : ''
                    }`}
                    aria-label={`${formatCoord(r, c)} 칸`}
                  >
                    {piece &&
                      renderVillagePieceVisual(
                        piece,
                        piece.uid === selectedPieceUid,
                        piece.uid === lastMovedUid
                      )}

                    {hasClergy && (
                      <div
                        className={`clergyman-pawn ${
                          moveKind === 'CLERGY_SWAP' ? 'swap-ready' : ''
                        }`}
                        title="사제(Pfarrer) — 막힌 건물과 자리 교환 가능"
                      >
                        <span className="clergy-head" />
                        <span className="clergy-robe" />
                      </div>
                    )}

                    {!piece && !hasClergy && highlight && (
                      <span
                        className={`target-dot ${
                          phase === 'SETUP_CHURCH' ? 'dot-church' : 'dot-move'
                        }`}
                      />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderRidgeSelector = (
    ridge: RidgeDir,
    onChange: (next: RidgeDir) => void
  ): React.ReactElement => (
    <div className="ridge-selector-row">
      <span className="ridge-selector-label">지붕 용마루 방향:</span>
      <button
        type="button"
        className={`ridge-pill ${ridge === 'V' ? 'active' : ''}`}
        onClick={() => onChange('V')}
      >
        ↕ 상하 이동 방향
      </button>
      <button
        type="button"
        className={`ridge-pill ${ridge === 'H' ? 'active' : ''}`}
        onClick={() => onChange('H')}
      >
        ↔ 좌우 이동 방향
      </button>
    </div>
  );

  const renderFireworksAndChips = (): React.ReactElement => (
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
      <div className="kd-container" style={{ background: WOOD_BG_THEMES[0] }}>
        <div className="setup-card home-entry-card">
          <div className="home-castle-icon">⛪🏡🪵</div>
          <h1 className="setup-title">Lass die Kirche im Dorf</h1>
          <p className="home-subtitle">
            마을에 교회를 세우자 · 직교 연결 &amp; 첨탑-본관 인접 · 7×7 원목 전략 보드게임
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
              <span className="mode-desc">2인 로컬 대국 · 마을 완성 승자 독식</span>
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
      <div className="kd-container" style={{ background: WOOD_BG_THEMES[0], padding: '16px' }}>
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
      <div className="kd-container" style={{ background: WOOD_BG_THEMES[0] }}>
        <div className="net-lobby-container">
          <div className="net-lobby-header">
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, fontSize: '20px', color: '#3e2723' }}>
              🌐 Kirche im Dorf 넷게임 (4개 대국실)
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
                statusBadgeText = isFull ? `🟠 대기중 (만석 2/2)` : `🟡 대기중 (${roomPlayers.length}/2명)`;
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
                    <span className="room-number-title">🪵 제 {room.roomId} 마을대국실</span>
                    <span className={`room-status-pill ${statusClass}`}>{statusBadgeText}</span>
                  </div>

                  <div className="room-rules-info">
                    <span>💰 동일 판돈: {room.anteBet.toLocaleString()}칩</span>
                    <span>⏱️ 제한: {room.baseTimeout}초</span>
                  </div>

                  <div className="room-members-box">
                    <div className="room-members-label">대국자 ({roomPlayers.length}/2):</div>
                    <div className="room-members-chips">
                      {roomPlayers.length === 0 ? (
                        <span className="empty-member-text">첫 번째 건축가를 기다리고 있습니다</span>
                      ) : (
                        roomPlayers.map((p) => (
                          <span key={p.id} className="member-chip">
                            <span className={`mini-wood-dot ${p.side === 1 ? 'light' : 'dark'}`} />
                            {p.name} ({p.wins || 0}승 · {(p.chips ?? INITIAL_CHIPS).toLocaleString()}칩)
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
              <h2 style={{ margin: '0 0 8px' }}>🪵 제 {joinModalRoom.roomId} 마을대국실 입장</h2>
              <p className="modal-subtext">
                동일 판돈 <strong>{joinModalRoom.anteBet.toLocaleString()}칩</strong>을 걸고 1:1
                대국이 진행됩니다.
              </p>

              <input
                type="text"
                className="player-input"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: '14px' }}
                placeholder="건축가 이름 입력 (예: 단풍마을)"
                value={joinPlayerName}
                autoFocus
                onChange={(e) => setJoinPlayerName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleEnterRoomSubmit(false);
                }}
              />

              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ flex: 1, background: '#0284c7', color: '#fff' }}
                  onClick={() => void handleEnterRoomSubmit(true)}
                >
                  👀 관전하기
                </button>
                <button
                  type="button"
                  className="btn btn-success"
                  style={{ flex: 2 }}
                  onClick={() => void handleEnterRoomSubmit(false)}
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
          className="kd-container"
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
        <div className="kd-container" style={{ background: WOOD_BG_THEMES[0] }}>
          <div className="setup-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '6px 12px', fontSize: '13px' }}
                onClick={() => void handleLeaveNetRoom()}
              >
                🚪 방 나가기
              </button>
              <span className="room-status-pill waiting">
                제 {activeNetRoom.roomId}실 · 대기 중 (⏱️ {countdownStr})
              </span>
            </div>

            <h1 className="setup-title" style={{ marginTop: '14px' }}>
              ⛪ Kirche im Dorf 대기실 {amISpectator ? '👀 [관전모드]' : ''}
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
                    onClick={() => void updateRoomSettings(val, activeNetRoom.baseTimeout)}
                  >
                    {val.toLocaleString()}칩
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-section">
              <label className="setting-label">
                ⏱️ 턴 제한시간: <strong>{activeNetRoom.baseTimeout}초</strong>{' '}
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
                    void updateRoomSettings(activeNetRoom.anteBet, Number(e.target.value))
                  }
                />
                <span style={{ fontSize: '12px', fontWeight: 700 }}>180초</span>
              </div>
            </div>

            <div className="setting-section">
              <label className="setting-label">🧭 입장한 건축가 (2명 입장 시 시작 가능)</label>
              <div className="player-list">
                {roomPlayers.map((p, idx) => (
                  <div key={p.id} className="player-item-a">
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className={`mini-wood-dot ${p.side === 1 ? 'light' : 'dark'}`} />
                      {p.name} ({p.side === 1 ? '밝은 원목' : '어두운 원목'}){' '}
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
              onClick={() => void handleStartNetRound(false)}
            >
              🚀 대국 시작! (전원 {activeNetRoom.anteBet.toLocaleString()}칩 동일 베팅)
            </button>
          </div>
        </div>
      );
    }

    const activeTurnPlayer = roomPlayers.find((p) => p.side === activeNetRoom.currentTurn);
    const isMyTurn =
      activeNetRoom.status === 'PLAYING' &&
      activeTurnPlayer?.id === mySessionId &&
      !amISpectator;
    const isRoundEnded =
      activeNetRoom.status === 'ROUND_OVER' || activeNetRoom.status === 'MATCH_OVER';

    const countSidePieces = (side: PlayerSide) =>
      (activeNetRoom.pieces || []).filter((p) => p.owner === side).length;

    return (
      <div className="kd-container" style={{ background: WOOD_BG_THEMES[0] }}>
        {renderFireworksAndChips()}

        {toast && (
          <div key={toast.id} className={`kd-toast ${toast.type}`}>
            {toast.text}
          </div>
        )}

        <div className="play-wrapper compact-tablet-mode">
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
                  activeNetRoom.status === 'PLAYING' && p.side === activeNetRoom.currentTurn;
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${isActive ? 'active-turn-spotlight' : ''}`}
                  >
                    <div className="player-badge-top">
                      <span className={`mini-wood-dot ${p.side === 1 ? 'light' : 'dark'}`} />
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '>'}
                        {p.name}
                        {p.id === mySessionId ? '(나)' : ''}
                      </strong>
                      <span className="disc-score-pill">
                        {countSidePieces(p.side)}/{TOTAL_PIECES_PER_PLAYER}
                      </span>
                      <span className="win-count-pill">🏆{p.wins || 0}승</span>
                      <span className="badge-score">💰{(p.chips ?? 0).toLocaleString()}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              className="btn btn-secondary btn-compact-setup"
              onClick={() => void handleLeaveNetRoom()}
              title="방 나가기"
            >
              🚪
            </button>
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

          <div className="kd-table-board">
            {isRoundEnded ? (
              <div className="winner-celebration-top-bar">
                <div className="winner-celebrate-title">{activeNetRoom.winnerAnnouncement}</div>
                <div className="winner-celebrate-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ padding: '6px 14px', fontSize: '13px' }}
                    onClick={() => void handleLeaveNetRoom()}
                  >
                    🚪 방 나가기
                  </button>
                  <button
                    type="button"
                    className="btn btn-success"
                    style={{ width: 'auto', padding: '6px 18px', fontSize: '14px' }}
                    onClick={() =>
                      void handleStartNetRound(activeNetRoom.status === 'ROUND_OVER')
                    }
                  >
                    {activeNetRoom.status === 'MATCH_OVER'
                      ? '🔄 새 매치 시작 (10,000칩 초기화)'
                      : `🔥 다음 대국 시작 (${activeNetRoom.anteBet.toLocaleString()}칩)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={activeNetRoom.turnNotice} className="kd-notice-banner">
                {activeNetRoom.turnNotice}
              </div>
            )}

            <div className="kd-scoreboard-strip">
              <div className="score-side">
                <span className="mini-wood-dot light" />
                <span>밝은 마을</span>
                <strong>{countSidePieces(1)}</strong>
              </div>

              <div className="center-pot-box">
                <span className="pot-label">💰 누적 POT</span>
                <strong className="pot-amount">
                  {(activeNetRoom.pot || 0).toLocaleString()} 칩
                </strong>
              </div>

              <div className="score-side">
                <strong>{countSidePieces(2)}</strong>
                <span>어두운 마을</span>
                <span className="mini-wood-dot dark" />
              </div>
            </div>

            {!isRoundEnded && activeNetRoom.phase !== 'MOVING' && (
              <div className="setup-ridge-bar">
                {renderRidgeSelector(netRidgeChoice, setNetRidgeChoice)}
              </div>
            )}

            <div className="board-center-stage">
              {renderKirchdorfBoard(
                activeNetRoom.phase,
                activeNetRoom.currentTurn,
                isMyTurn,
                activeNetRoom.pieces || [],
                activeNetRoom.clergyman || { ...CENTER_POS },
                activeNetRoom.setupChurchStep,
                activeNetRoom.selectedPieceUid,
                activeNetRoom.lastMovedUid,
                (r, c) => void handleNetCellClick(r, c)
              )}
            </div>
          </div>

          <div className="kd-bottom-dock">
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
                  {activeNetRoom.currentTurn === 1 ? '☀️ 밝은 원목' : '🌑 어두운 원목'}{' '}
                  {activeTurnPlayer?.name}님 차례 ·{' '}
                  {activeNetRoom.phase === 'SETUP_CHURCH'
                    ? '교회(첨탑·본관) 모서리 배치'
                    : activeNetRoom.phase === 'SETUP_HOUSES'
                    ? '집 배치(직교 인접 금지)'
                    : '건물 이동 & 90° 회전'}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // 5. 단독게임(SOLO) - 2인 로컬 대국
  // =========================================================================
  const currentSoloPlayer =
    soloPlayers.find((p) => p.side === soloTurn) || soloPlayers[0];
  const isSoloEnded = gameState === 'ROUND_OVER' || gameState === 'MATCH_OVER';

  return (
    <div className="kd-container" style={{ background: WOOD_BG_THEMES[0] }}>
      {renderFireworksAndChips()}

      {toast && (
        <div key={toast.id} className={`kd-toast ${toast.type}`}>
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
          <h1 className="setup-title">⛪ Kirche im Dorf (단독게임 설정)</h1>

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
            <label className="setting-label">🧭 건축가 이름 설정 (2인 대전)</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="player-item-a">
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="mini-wood-dot light" />
                  <span>선공 (밝은 원목)</span>
                </span>
                <input
                  type="text"
                  className="player-input"
                  style={{ maxWidth: '220px', padding: '6px 10px' }}
                  value={soloName1}
                  onChange={(e) => setSoloName1(e.target.value)}
                  placeholder="1번 건축가 이름"
                />
              </div>

              <div className="player-item-a">
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="mini-wood-dot dark" />
                  <span>후공 (어두운 원목)</span>
                </span>
                <input
                  type="text"
                  className="player-input"
                  style={{ maxWidth: '220px', padding: '6px 10px' }}
                  value={soloName2}
                  onChange={(e) => setSoloName2(e.target.value)}
                  placeholder="2번 건축가 이름"
                />
              </div>
            </div>
          </div>

          <button type="button" className="btn btn-success" onClick={goToSoloReady}>
            ➡️ 선공/후공 배정 확인하러 가기
          </button>
        </div>
      )}

      {gameState === 'READY' && (
        <div className="order-panel">
          <div className="order-header">
            <h2 style={{ margin: 0, fontSize: '20px', color: '#3e2723' }}>
              📋 마을 색상 및 순서를 확인하세요
            </h2>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: '8px 14px', fontSize: '13px' }}
              onClick={swapSoloOrder}
            >
              🔄 순서 맞바꾸기
            </button>
          </div>

          <div className="order-list">
            {soloPlayers.map((player) => (
              <div key={player.id} className="order-item">
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span className={`mini-wood-dot ${player.side === 1 ? 'light' : 'dark'}`} />
                  <strong>{player.side === 1 ? '선공 (밝은 원목)' : '후공 (어두운 원목)'}</strong>
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
            <button
              type="button"
              className="btn btn-success"
              onClick={() => startSoloRound(false)}
            >
              🚀 대국 시작! (전원 {soloAnteBet.toLocaleString()}칩 동일 베팅)
            </button>
          </div>
        </div>
      )}

      {(gameState === 'PLAYING' || gameState === 'ROUND_OVER' || gameState === 'MATCH_OVER') && (
        <div className="play-wrapper compact-tablet-mode">
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
                const isActive = !isSoloEnded && p.side === soloTurn;
                const count = soloPieces.filter((pc) => pc.owner === p.side).length;
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${
                      isActive ? 'active-turn-spotlight' : 'active-turn-unlight'
                    }`}
                  >
                    <div className="player-badge-top">
                      <span className={`mini-wood-dot ${p.side === 1 ? 'light' : 'dark'}`} />
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '>'}
                        {p.name}
                      </strong>
                      <span className="disc-score-pill">
                        {count}/{TOTAL_PIECES_PER_PLAYER}
                      </span>
                      <span className="win-count-pill">🏆{p.wins}승</span>
                      <span className="badge-score">💰{p.chips.toLocaleString()}</span>
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

          <div className="kd-table-board">
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
                      : `🔥 다음 대국 시작 (${soloAnteBet.toLocaleString()}칩)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={turnNotice} className="kd-notice-banner">
                {turnNotice}
              </div>
            )}

            <div className="kd-scoreboard-strip">
              <div className="score-side">
                <span className="mini-wood-dot light" />
                <span>밝은 마을</span>
                <strong>{soloPieces.filter((p) => p.owner === 1).length}</strong>
              </div>

              <div className="center-pot-box">
                <span className="pot-label">💰 누적 POT</span>
                <strong className="pot-amount">{soloPot.toLocaleString()} 칩</strong>
              </div>

              <div className="score-side">
                <strong>{soloPieces.filter((p) => p.owner === 2).length}</strong>
                <span>어두운 마을</span>
                <span className="mini-wood-dot dark" />
              </div>
            </div>

            {!isSoloEnded && soloPhase !== 'MOVING' && (
              <div className="setup-ridge-bar">
                {renderRidgeSelector(soloRidgeChoice, setSoloRidgeChoice)}
              </div>
            )}

            <div className="board-center-stage">
              {renderKirchdorfBoard(
                soloPhase,
                soloTurn,
                gameState === 'PLAYING',
                soloPieces,
                soloClergyman,
                soloSetupChurchStep,
                soloSelectedUid,
                soloLastMovedUid,
                handleSoloCellClick
              )}
            </div>
          </div>

          <div className="kd-bottom-dock">
            <div className="dock-top-status">
              {isSoloEnded ? (
                <span className="waiting-dock-msg">
                  🎉 대국 종료! <strong>[다음 대국 시작]</strong>을 눌러 선공/후공을 교대해 계속
                  대국하세요!
                </span>
              ) : (
                <span className="turn-owner-pill large-turn-pill">
                  {soloTurn === 1 ? '☀️ 밝은 원목' : '🌑 어두운 원목'} {currentSoloPlayer.name}님
                  차례 · 🏆{currentSoloPlayer.wins}승 · 💰{currentSoloPlayer.chips.toLocaleString()}
                  칩
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}