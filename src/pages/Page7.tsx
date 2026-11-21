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
import './Page7.css';

export type TileColor = 'RED' | 'BLUE' | 'ORANGE' | 'BLACK' | 'JOKER';

export interface RummiTile {
  id: string;
  color: TileColor;
  number: number; // 1~13, 조커는 0
  isJoker: boolean;
}

export interface TableSet {
  id: string;
  tiles: RummiTile[];
}

interface RummiPlayer {
  id: string;
  name: string;
  badgeColor: string;
  hand: RummiTile[];
  hasMelded: boolean; // 첫 등록(30점 이상) 완료 여부
  chips: number;
  wins: number;
  score: number; // 누적 승점
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

interface NetRummiRoomData {
  roomId: number;
  status: 'EMPTY' | 'WAITING' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER';
  players: RummiPlayer[];
  pot: number;
  waitlist: WaitlistPlayer[];
  spectators: SpectatorPlayer[];
  baseTimeout: number;
  anteBet: number;
  roundNumber: number;
  pool: RummiTile[]; // 타일 주머니 (106장 중 남은 타일)
  tableSets: TableSet[]; // 테이블에 등록된 세트들
  turnStartTableSets: TableSet[]; // 이번 턴 시작 시 테이블 백업
  turnStartHand: RummiTile[]; // 이번 턴 시작 시 현재 플레이어 손패 백업
  turnAddedFromHandIds: string[]; // 이번 턴에 손패에서 테이블로 낸 타일 ID 목록
  currentPlayerIdx: number;
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

const PLAYER_BG_COLORS = [
  'linear-gradient(135deg, #fee2e2 0%, #fef3c7 50%, #f0fdf4 100%)',
  'linear-gradient(135deg, #e0f2fe 0%, #f0f9ff 50%, #faf5ff 100%)',
  'linear-gradient(135deg, #dcfce7 0%, #f0fdf4 50%, #fef9c3 100%)',
  'linear-gradient(135deg, #fef3c7 0%, #ffedd5 50%, #fce7f3 100%)',
];

const PIECE_COLORS = ['#dc2626', '#2563eb', '#059669', '#d97706'];
const TILE_COLORS: Exclude<TileColor, 'JOKER'>[] = ['RED', 'BLUE', 'ORANGE', 'BLACK'];
const INITIAL_CHIPS = 10000;
const DEFAULT_TIMEOUT_SEC = 90;

function getShortName(name: string): string {
  const trimmed = name ? name.trim() : '';
  return trimmed ? trimmed.slice(0, 2) : '?';
}

/**
 * 루미큐브 타일 106장 생성 및 셔플 (4색 x 1~13 x 2세트 = 104장 + 조커 2장)
 */
function createRummikubDeck(): RummiTile[] {
  const tiles: RummiTile[] = [];
  for (let copy = 1; copy <= 2; copy++) {
    for (const color of TILE_COLORS) {
      for (let num = 1; num <= 13; num++) {
        tiles.push({
          id: `${color}_${num}_${copy}`,
          color,
          number: num,
          isJoker: false,
        });
      }
    }
  }
  tiles.push({ id: 'JOKER_1', color: 'JOKER', number: 0, isJoker: true });
  tiles.push({ id: 'JOKER_2', color: 'JOKER', number: 0, isJoker: true });

  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles;
}

function sortTilesByColor(tiles: RummiTile[]): RummiTile[] {
  const order: Record<TileColor, number> = {
    RED: 1,
    BLUE: 2,
    ORANGE: 3,
    BLACK: 4,
    JOKER: 5,
  };
  return [...tiles].sort((a, b) => {
    if (order[a.color] !== order[b.color]) return order[a.color] - order[b.color];
    return a.number - b.number;
  });
}

function sortTilesByNumber(tiles: RummiTile[]): RummiTile[] {
  const order: Record<TileColor, number> = {
    RED: 1,
    BLUE: 2,
    ORANGE: 3,
    BLACK: 4,
    JOKER: 5,
  };
  return [...tiles].sort((a, b) => {
    if (a.isJoker && !b.isJoker) return 1;
    if (!a.isJoker && b.isJoker) return -1;
    if (a.number !== b.number) return a.number - b.number;
    return order[a.color] - order[b.color];
  });
}

/**
 * 단일 세트(그룹 또는 런) 유효성 및 점수 계산
 * - 그룹: 3~4장, 모든 일반 타일 숫자가 동일, 색상이 모두 다름
 * - 런: 3~13장, 모든 일반 타일 색상이 동일, 1씩 증가하는 연속 숫자 (1~13 범위 내)
 */
function validateRummikubSet(tiles: RummiTile[]): {
  valid: boolean;
  type: 'GROUP' | 'RUN' | 'INVALID';
  points: number;
  orderedTiles: RummiTile[];
} {
  if (!tiles || tiles.length < 3) {
    return { valid: false, type: 'INVALID', points: 0, orderedTiles: tiles || [] };
  }

  const normals = tiles.filter((t) => !t.isJoker);
  const jokers = tiles.filter((t) => t.isJoker);

  if (normals.length === 0) {
    return { valid: false, type: 'INVALID', points: 0, orderedTiles: tiles };
  }

  // 1. 그룹(Group) 검사: 3~4장, 숫자 동일, 색상 중복 불가
  if (tiles.length <= 4) {
    const targetNum = normals[0].number;
    const allSameNum = normals.every((t) => t.number === targetNum);
    const uniqueColors = new Set(normals.map((t) => t.color));
    if (allSameNum && uniqueColors.size === normals.length) {
      return {
        valid: true,
        type: 'GROUP',
        points: targetNum * tiles.length,
        orderedTiles: [...normals, ...jokers],
      };
    }
  }

  // 2. 런(Run) 검사: 같은 색상, 연속 숫자
  const targetColor = normals[0].color;
  const allSameColor = normals.every((t) => t.color === targetColor);
  if (allSameColor && tiles.length <= 13) {
    const sortedNormals = [...normals].sort((a, b) => a.number - b.number);
    let hasDuplicateNum = false;
    let internalGaps = 0;

    for (let i = 1; i < sortedNormals.length; i++) {
      const diff = sortedNormals[i].number - sortedNormals[i - 1].number;
      if (diff === 0) {
        hasDuplicateNum = true;
        break;
      }
      internalGaps += diff - 1;
    }

    if (!hasDuplicateNum && internalGaps <= jokers.length) {
      const minNum = sortedNormals[0].number;
      const maxNum = sortedNormals[sortedNormals.length - 1].number;
      const remainingJokers = jokers.length - internalGaps;

      // 남은 조커를 뒤쪽(큰 숫자)에 우선 배치하여 점수를 극대화하되 13을 넘으면 앞쪽에 배치
      const appendRight = Math.min(remainingJokers, 13 - maxNum);
      const prependLeft = remainingJokers - appendRight;
      const startNum = minNum - prependLeft;

      if (startNum >= 1 && startNum + tiles.length - 1 <= 13) {
        const arranged: RummiTile[] = [];
        const jokerQueue = [...jokers];
        const normalMap = new Map<number, RummiTile>();
        sortedNormals.forEach((n) => normalMap.set(n.number, n));

        let sumPoints = 0;
        for (let n = startNum; n < startNum + tiles.length; n++) {
          sumPoints += n;
          const found = normalMap.get(n);
          if (found) {
            arranged.push(found);
          } else {
            const jk = jokerQueue.shift();
            if (jk) arranged.push(jk);
          }
        }

        return {
          valid: true,
          type: 'RUN',
          points: sumPoints,
          orderedTiles: arranged,
        };
      }
    }
  }

  return { valid: false, type: 'INVALID', points: 0, orderedTiles: tiles };
}

/**
 * 라운드 종료 시 손패에 남은 벌점 계산 (조커는 30점)
 */
function calculateHandPenalty(hand: RummiTile[]): number {
  return (hand || []).reduce((acc, t) => acc + (t.isJoker ? 30 : t.number), 0);
}

function getNextAlivePlayerIdx(players: RummiPlayer[], currentIdx: number): number {
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

function createDefaultRummiRoom(roomId: number): NetRummiRoomData {
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
    pool: [],
    tableSets: [],
    turnStartTableSets: [],
    turnStartHand: [],
    turnAddedFromHandIds: [],
    currentPlayerIdx: 0,
    turnDeadline: null,
    turnNotice: '',
    winnerAnnouncement: '',
    roundWinnerId: null,
    waitingSince: null,
  };
}

export default function Page7() {
  const [appMode, setAppMode] = useState<
    'HOME' | 'SOLO' | 'NET_LOBBY' | 'NET_ROOM' | 'HALL_OF_FAME'
  >('HOME');

  const [mySessionId] = useState<string>(() => {
    const saved = sessionStorage.getItem('rummikub_net_uid');
    if (saved) return saved;
    const generated = `rk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('rummikub_net_uid', generated);
    return generated;
  });

  // 넷게임 상태
  const [rooms, setRooms] = useState<NetRummiRoomData[]>(
    [1, 2, 3, 4].map(createDefaultRummiRoom)
  );
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [joinModalRoom, setJoinModalRoom] = useState<NetRummiRoomData | null>(null);
  const [joinPlayerName, setJoinPlayerName] = useState<string>('');
  const [remainingSeconds, setRemainingSeconds] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [waitingCountdownSec, setWaitingCountdownSec] = useState<number>(420);
  const timeoutHandledRef = useRef<number | null>(null);
  const lastSpokenNoticeRef = useRef<string>('');
  const lastCountdownSpokenRef = useRef<number | null>(null);

  // 손패 선택 타일 ID 목록 (로컬 UI 선택 상태)
  const [selectedHandIds, setSelectedHandIds] = useState<string[]>([]);

  // 단독게임(SOLO) 상태
  const [gameState, setGameState] = useState<
    'SETUP' | 'READY' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER'
  >('SETUP');
  const [players, setPlayers] = useState<RummiPlayer[]>([
    {
      id: '1',
      name: '타짜',
      badgeColor: PIECE_COLORS[0],
      hand: [],
      hasMelded: false,
      chips: INITIAL_CHIPS,
      wins: 0,
      score: 0,
      currentBet: 0,
      isEliminated: false,
    },
    {
      id: '2',
      name: '고니',
      badgeColor: PIECE_COLORS[1],
      hand: [],
      hasMelded: false,
      chips: INITIAL_CHIPS,
      wins: 0,
      score: 0,
      currentBet: 0,
      isEliminated: false,
    },
    {
      id: '3',
      name: '아귀',
      badgeColor: PIECE_COLORS[2],
      hand: [],
      hasMelded: false,
      chips: INITIAL_CHIPS,
      wins: 0,
      score: 0,
      currentBet: 0,
      isEliminated: false,
    },
  ]);

  const [inputName, setInputName] = useState('');
  const [soloAnteBet, setSoloAnteBet] = useState<number>(1000);
  const [soloTimeoutSec, setSoloTimeoutSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRemainingSec, setSoloRemainingSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRoundNum, setSoloRoundNum] = useState<number>(1);
  const [soloPot, setSoloPot] = useState<number>(0);

  const [pool, setPool] = useState<RummiTile[]>([]);
  const [tableSets, setTableSets] = useState<TableSet[]>([]);
  const [turnStartTableSets, setTurnStartTableSets] = useState<TableSet[]>([]);
  const [turnStartHand, setTurnStartHand] = useState<RummiTile[]>([]);
  const [turnAddedFromHandIds, setTurnAddedFromHandIds] = useState<string[]>([]);

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

  const playSound = (kind: 'place' | 'draw' | 'chip' | 'win' | 'tick') => {
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
        place: [523.25, 659.25],
        draw: [392.0, 329.63],
        chip: [880, 1174.66],
        win: [523.25, 659.25, 783.99, 1046.5, 1318.5],
        tick: [987.77],
      };

      notesMap[kind].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === 'draw' ? 'triangle' : kind === 'chip' ? 'sine' : 'triangle';
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
    const key = type === 'SOLO' ? 'rummikub_hof_solo' : 'rummikub_hof_net';
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
    const key = type === 'SOLO' ? 'rummikub_hof_solo' : 'rummikub_hof_net';
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
      const roomRef = ref(db, `rummikub_rooms/room_${roomIdToLeave}`);
      try {
        await runTransaction(roomRef, (roomData) => {
          if (!roomData) return roomData;
          const room = roomData as NetRummiRoomData;
          const filteredPlayers = (room.players || []).filter((p) => p.id !== mySessionId);
          const filteredWaitlist = (room.waitlist || []).filter((w) => w.id !== mySessionId);
          const filteredSpectators = (room.spectators || []).filter((s) => s.id !== mySessionId);

          if (filteredPlayers.length === 0 && filteredSpectators.length === 0) {
            return createDefaultRummiRoom(room.roomId);
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

    const presenceRef = ref(db, `rummikub_presence/room_${selectedRoomId}/${mySessionId}`);
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
        const roomRef = ref(db, `rummikub_rooms/room_${id}`);
        const snap = await get(roomRef);
        if (!snap.exists()) {
          await set(roomRef, createDefaultRummiRoom(id));
        }
      }
    };
    ensureRoomsExist();

    const roomsRef = ref(db, 'rummikub_rooms');
    const unsubscribe = onValue(roomsRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      const loadedRooms: NetRummiRoomData[] = [1, 2, 3, 4].map((id) => {
        const rData = data[`room_${id}`];
        const def = createDefaultRummiRoom(id);
        if (!rData) return def;
        return {
          ...def,
          ...rData,
          players: (rData.players || []).map((p: RummiPlayer) => ({
            ...p,
            hand: p.hand || [],
            hasMelded: Boolean(p.hasMelded),
            chips: typeof p.chips === 'number' ? p.chips : INITIAL_CHIPS,
            wins: typeof p.wins === 'number' ? p.wins : 0,
            score: typeof p.score === 'number' ? p.score : 0,
            currentBet: typeof p.currentBet === 'number' ? p.currentBet : 0,
            isEliminated: Boolean(p.isEliminated),
          })),
          pot: typeof rData.pot === 'number' ? rData.pot : 0,
          waitlist: rData.waitlist || [],
          spectators: rData.spectators || [],
          pool: rData.pool || [],
          tableSets: (rData.tableSets || []).map((s: TableSet) => ({
            ...s,
            tiles: s.tiles || [],
          })),
          turnStartTableSets: (rData.turnStartTableSets || []).map((s: TableSet) => ({
            ...s,
            tiles: s.tiles || [],
          })),
          turnStartHand: rData.turnStartHand || [],
          turnAddedFromHandIds: rData.turnAddedFromHandIds || [],
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
    setSelectedHandIds([]);
  }, [activeNetRoom?.currentPlayerIdx, activeNetRoom?.roundNumber, currentPlayerIdx, soloRoundNum]);

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
          const roomRef = ref(db, `rummikub_rooms/room_${activeNetRoom.roomId}`);
          await set(roomRef, createDefaultRummiRoom(activeNetRoom.roomId));
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
          handleSoloRevertAndDraw(true);
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [appMode, gameState, currentPlayerIdx, soloTimeoutSec, players, pool]);

  const handleEnterRoomSubmit = async (asSpectator = false) => {
    if (!joinModalRoom) return;
    const trimmedName = joinPlayerName ? joinPlayerName.trim() : '';
    if (!trimmedName) {
      alert('참가할 이름을 입력해주세요!');
      return;
    }

    const roomRef = ref(db, `rummikub_rooms/room_${joinModalRoom.roomId}`);

    try {
      let joinResultType = 'PLAYER';

      await runTransaction(roomRef, (roomData) => {
        const room: NetRummiRoomData =
          roomData || createDefaultRummiRoom(joinModalRoom.roomId);
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
          const newPlayer: RummiPlayer = {
            id: mySessionId,
            name: trimmedName,
            badgeColor: PIECE_COLORS[idx],
            hand: [],
            hasMelded: false,
            chips: INITIAL_CHIPS,
            wins: 0,
            score: 0,
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
        showToast('👀 관망모드로 입장했습니다! 플레이어 손패는 비공개 보호됩니다.', 'info');
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
    const clampedTimeout = Math.min(180, Math.max(30, newTimeout));
    const roomRef = ref(db, `rummikub_rooms/room_${activeNetRoom.roomId}`);
    await update(roomRef, {
      anteBet: newAnteBet,
      baseTimeout: clampedTimeout,
      waitingSince: Date.now(),
    });
  };

  /**
   * 라운드 종료 정산 헬퍼 (승리자 ID 또는 타일 주머니 소진 시 최저 벌점자 승리)
   */
  const settleRummikubRound = (room: NetRummiRoomData, directWinnerId: string | null) => {
    const alivePlayers = room.players.filter((p) => !p.isEliminated);
    let winner = alivePlayers.find((p) => p.id === directWinnerId) || alivePlayers[0];

    if (!directWinnerId) {
      let minPenalty = Infinity;
      for (const p of alivePlayers) {
        const penalty = calculateHandPenalty(p.hand);
        if (penalty < minPenalty) {
          minPenalty = penalty;
          winner = p;
        }
      }
    }

    let totalLoserPenalties = 0;
    for (const p of alivePlayers) {
      if (p.id !== winner.id) {
        totalLoserPenalties += calculateHandPenalty(p.hand);
      }
    }

    const wonPot = room.pot || 0;
    room.players = room.players.map((p) => {
      if (p.isEliminated) return p;
      const isWinner = p.id === winner.id;
      const penalty = calculateHandPenalty(p.hand);
      const scoreDelta = isWinner ? totalLoserPenalties : -penalty;
      const updatedChips = isWinner ? p.chips + wonPot : p.chips;
      const busted = updatedChips <= 0;
      return {
        ...p,
        chips: updatedChips,
        wins: isWinner ? (p.wins || 0) + 1 : p.wins || 0,
        score: (p.score || 0) + scoreDelta,
        isEliminated: busted,
      };
    });

    const remainingAlive = room.players.filter((p) => !p.isEliminated);
    const bustedNames = room.players.filter((p) => p.isEliminated).map((p) => p.name);
    const bustText =
      bustedNames.length > 0 ? ` · 💀 ${bustedNames.join(', ')}님 판돈 소진 아웃!` : '';

    const winnerObj = room.players.find((p) => p.id === winner.id)!;
    room.pot = 0;
    room.turnDeadline = null;
    room.turnNotice = '';
    room.roundWinnerId = winner.id;

    const reasonText = directWinnerId
      ? '루미큐브(손패 0장) 달성'
      : '타일 소진 최저 벌점 승리';

    if (remainingAlive.length <= 1) {
      room.status = 'MATCH_OVER';
      room.winnerAnnouncement = `👑 최종 우승! ${winner.name}님이 ${reasonText}(+${totalLoserPenalties}점)로 판돈 ${wonPot.toLocaleString()}칩을 독식했습니다!${bustText}`;
    } else {
      room.status = 'ROUND_OVER';
      room.winnerAnnouncement = `🎊 ${winner.name}님 ${reasonText} (+${totalLoserPenalties}점)! 판돈 ${wonPot.toLocaleString()}칩 독식! (${winnerObj.wins}승 · 누적 ${winnerObj.chips.toLocaleString()}칩)${bustText}`;
    }

    saveHallOfFameRecord('NET', {
      name: winnerObj.name,
      scoreOrLevel: `${winnerObj.wins}승 (${winnerObj.score}점) · ${winnerObj.chips.toLocaleString()}칩`,
    });
  };

  /**
   * 넷게임 라운드 시작
   */
  const handleStartNetRound = async (isNextRound = false) => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `rummikub_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetRummiRoomData;
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
            score: 0,
            isEliminated: false,
          }))
        : room.players.map((p) => ({
            ...p,
            isEliminated: p.isEliminated || p.chips <= 0,
          }));

      const survivingPlayers = basePlayers.filter((p) => !p.isEliminated);
      const eliminatedPlayers = basePlayers.filter((p) => p.isEliminated);

      const waitlist = [...room.waitlist];
      const nextActive: RummiPlayer[] = [...survivingPlayers];
      const remainingWaitlist: WaitlistPlayer[] = [];

      for (const w of waitlist) {
        if (nextActive.length + eliminatedPlayers.length < 4) {
          nextActive.push({
            id: w.id,
            name: w.name,
            badgeColor: PIECE_COLORS[0],
            hand: [],
            hasMelded: false,
            chips: INITIAL_CHIPS,
            wins: 0,
            score: 0,
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
      const deckCopy = createRummikubDeck();

      const activeWithHand = nextActive.map((p) => {
        const pay = equalStake;
        collectedPot += pay;
        const dealtHand = sortTilesByColor(deckCopy.splice(0, 14));
        return {
          ...p,
          hand: dealtHand,
          hasMelded: false,
          chips: p.chips - pay,
          currentBet: pay,
          isEliminated: false,
        };
      });

      const mergedPlayers = [...activeWithHand, ...eliminatedPlayers].map((p, idx) => ({
        ...p,
        badgeColor: PIECE_COLORS[idx % PIECE_COLORS.length],
      }));

      room.status = 'PLAYING';
      room.roundNumber = nextRound;
      room.players = mergedPlayers;
      room.pot = collectedPot;
      room.waitlist = remainingWaitlist;
      room.pool = deckCopy;
      room.tableSets = [];
      room.turnStartTableSets = [];
      room.turnStartHand = mergedPlayers[0].hand;
      room.turnAddedFromHandIds = [];
      room.currentPlayerIdx = 0;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.winnerAnnouncement = '';
      room.roundWinnerId = null;
      room.turnNotice = `💰 [${nextRound}라운드] 전원 ${equalStake.toLocaleString()}칩 베팅! 각자 14장 분배 완료! ${mergedPlayers[0].name}님 차례 (첫 등록 30점 이상)`;
      room.waitingSince = null;

      return room;
    });

    triggerChipAnimation('전원', activeNetRoom.anteBet, '#f59e0b');
  };

  /**
   * 넷게임: 선택한 손패 타일을 새 세트로 테이블에 내리기
   */
  const handleNetCreateNewSet = async () => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    if (selectedHandIds.length === 0) {
      showToast('손패에서 테이블로 내릴 타일을 먼저 선택해주세요.', 'info');
      return;
    }

    const roomRef = ref(db, `rummikub_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetRummiRoomData;
      if (room.status !== 'PLAYING') return room;
      const cIdx = room.currentPlayerIdx;
      const p = room.players[cIdx];
      if (!p || p.id !== mySessionId) return room;

      const movingTiles = p.hand.filter((t) => selectedHandIds.includes(t.id));
      if (movingTiles.length === 0) return room;

      const remainingHand = p.hand.filter((t) => !selectedHandIds.includes(t.id));
      const { orderedTiles } = validateRummikubSet(movingTiles);

      const newSet: TableSet = {
        id: `set_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        tiles: orderedTiles,
      };

      room.players[cIdx] = { ...p, hand: remainingHand };
      room.tableSets = [...(room.tableSets || []), newSet];
      room.turnAddedFromHandIds = [
        ...(room.turnAddedFromHandIds || []),
        ...movingTiles.map((t) => t.id),
      ];
      return room;
    });

    playSound('place');
    setSelectedHandIds([]);
  };

  /**
   * 넷게임: 선택한 손패 타일을 기존 테이블 세트에 붙이기
   */
  const handleNetAppendToSet = async (targetSetId: string) => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const cIdx = activeNetRoom.currentPlayerIdx;
    const actor = activeNetRoom.players[cIdx];
    if (!actor || actor.id !== mySessionId) return;

    if (!actor.hasMelded) {
      showToast('첫 등록(30점 이상) 완료 전에는 기존 테이블 세트를 건드릴 수 없습니다!', 'danger');
      return;
    }
    if (selectedHandIds.length === 0) {
      showToast('붙일 손패 타일을 먼저 선택하거나, 세트의 타일을 클릭해 가져오세요.', 'info');
      return;
    }

    const roomRef = ref(db, `rummikub_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetRummiRoomData;
      if (room.status !== 'PLAYING') return room;
      const idx = room.currentPlayerIdx;
      const p = room.players[idx];
      if (!p || p.id !== mySessionId || !p.hasMelded) return room;

      const movingTiles = p.hand.filter((t) => selectedHandIds.includes(t.id));
      if (movingTiles.length === 0) return room;

      room.players[idx] = {
        ...p,
        hand: p.hand.filter((t) => !selectedHandIds.includes(t.id)),
      };
      room.tableSets = (room.tableSets || []).map((s) => {
        if (s.id !== targetSetId) return s;
        const merged = [...s.tiles, ...movingTiles];
        const { orderedTiles } = validateRummikubSet(merged);
        return { ...s, tiles: orderedTiles };
      });
      room.turnAddedFromHandIds = [
        ...(room.turnAddedFromHandIds || []),
        ...movingTiles.map((t) => t.id),
      ];
      return room;
    });

    playSound('place');
    setSelectedHandIds([]);
  };

  /**
   * 넷게임: 테이블 위의 타일 1개를 손패로 가져와 재조합하기
   */
  const handleNetPickFromTable = async (setId: string, tileId: string) => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const cIdx = activeNetRoom.currentPlayerIdx;
    const actor = activeNetRoom.players[cIdx];
    if (!actor || actor.id !== mySessionId) return;

    const isMyOwnUncommittedTile = (activeNetRoom.turnAddedFromHandIds || []).includes(tileId);
    if (!actor.hasMelded && !isMyOwnUncommittedTile) {
      showToast('첫 등록(30점 이상) 전에는 기존 테이블 타일을 가져올 수 없습니다!', 'danger');
      return;
    }

    const roomRef = ref(db, `rummikub_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetRummiRoomData;
      if (room.status !== 'PLAYING') return room;
      const idx = room.currentPlayerIdx;
      const p = room.players[idx];
      if (!p || p.id !== mySessionId) return room;

      let pickedTile: RummiTile | null = null;
      const updatedSets: TableSet[] = [];

      for (const s of room.tableSets || []) {
        const found = s.tiles.find((t) => t.id === tileId);
        if (s.id === setId && found) {
          pickedTile = found;
          const rest = s.tiles.filter((t) => t.id !== tileId);
          if (rest.length > 0) {
            updatedSets.push({ ...s, tiles: rest });
          }
        } else {
          updatedSets.push(s);
        }
      }

      if (!pickedTile) return room;

      room.tableSets = updatedSets;
      room.players[idx] = {
        ...p,
        hand: [...p.hand, pickedTile],
      };
      room.turnAddedFromHandIds = (room.turnAddedFromHandIds || []).filter((id) => id !== tileId);
      return room;
    });

    playSound('place');
  };

  /**
   * 넷게임: 이번 턴 원상복구 (Undo)
   */
  const handleNetRevertTurn = async () => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const cIdx = activeNetRoom.currentPlayerIdx;
    const actor = activeNetRoom.players[cIdx];
    if (!actor || actor.id !== mySessionId) return;

    const roomRef = ref(db, `rummikub_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetRummiRoomData;
      const idx = room.currentPlayerIdx;
      const p = room.players[idx];
      if (!p || p.id !== mySessionId) return room;

      room.tableSets = room.turnStartTableSets || [];
      room.players[idx] = {
        ...p,
        hand: room.turnStartHand || p.hand,
      };
      room.turnAddedFromHandIds = [];
      return room;
    });

    setSelectedHandIds([]);
    showToast('↩️ 이번 턴 시작 상태로 타일을 원상복구했습니다.', 'info');
  };

  /**
   * 넷게임: 턴 완료 검증 및 제출 (또는 타일 1장 뽑고 패스)
   */
  const handleNetEndTurnOrDraw = async () => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const cIdx = activeNetRoom.currentPlayerIdx;
    const actor = activeNetRoom.players[cIdx];
    if (!actor || actor.id !== mySessionId) return;

    const addedCount = (activeNetRoom.turnAddedFromHandIds || []).length;
    const currentSets = activeNetRoom.tableSets || [];

    // 1. 손패에서 1장 이상 테이블에 낸 경우 -> 유효성 검증
    if (addedCount > 0) {
      let totalPoints = 0;
      for (const s of currentSets) {
        const res = validateRummikubSet(s.tiles);
        if (!res.valid) {
          showToast(
            '❌ 테이블에 규칙에 맞지 않는 세트(3장 미만 또는 색상/숫자 오류)가 있습니다!',
            'danger'
          );
          return;
        }
        totalPoints += res.points;
      }

      if (!actor.hasMelded) {
        // 첫 등록 시 현재 테이블 세트들의 합계가 30점 이상인지 확인 (자기 손패만으로 낸 세트들)
        const startSetIds = new Set((activeNetRoom.turnStartTableSets || []).map((s) => s.id));
        const newlyAddedSets = currentSets.filter((s) => !startSetIds.has(s.id));
        const meldScore = newlyAddedSets.reduce(
          (acc, s) => acc + validateRummikubSet(s.tiles).points,
          0
        );
        if (meldScore < 30) {
          showToast(
            `❌ 첫 등록은 본인 손패만으로 합계 30점 이상이어야 합니다! (현재 ${meldScore}점)`,
            'danger'
          );
          return;
        }
      }

      playSound('place');
      const roomRef = ref(db, `rummikub_rooms/room_${activeNetRoom.roomId}`);
      await runTransaction(roomRef, (roomData) => {
        if (!roomData) return roomData;
        const room = roomData as NetRummiRoomData;
        const idx = room.currentPlayerIdx;
        const p = room.players[idx];
        if (!p || p.id !== mySessionId) return room;

        const normalizedSets = (room.tableSets || []).map((s) => ({
          ...s,
          tiles: validateRummikubSet(s.tiles).orderedTiles,
        }));

        room.tableSets = normalizedSets;
        room.players[idx] = {
          ...p,
          hasMelded: true,
        };

        // 손패 0장 달성 시 즉시 승리
        if (p.hand.length === 0) {
          settleRummikubRound(room, p.id);
          return room;
        }

        const nextIdx = getNextAlivePlayerIdx(room.players, idx);
        const nextPlayer = room.players[nextIdx];
        room.currentPlayerIdx = nextIdx;
        room.turnStartTableSets = normalizedSets;
        room.turnStartHand = nextPlayer.hand;
        room.turnAddedFromHandIds = [];
        room.turnDeadline = Date.now() + room.baseTimeout * 1000;
        room.turnNotice = `✅ ${p.name}님이 타일 ${addedCount}장을 등록했습니다! (남은 손패 ${p.hand.length}장) 👉 ${nextPlayer.name}님 차례!`;
        return room;
      });
      setSelectedHandIds([]);
      return;
    }

    // 2. 손패에서 낸 타일이 0장인 경우 -> 원상복구 후 주머니에서 1장 뽑고 턴 종료
    playSound('draw');
    const roomRef = ref(db, `rummikub_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetRummiRoomData;
      const idx = room.currentPlayerIdx;
      const p = room.players[idx];
      if (!p || p.id !== mySessionId) return room;

      const restoredSets = room.turnStartTableSets || [];
      const restoredHand = [...(room.turnStartHand || p.hand)];
      const poolCopy = [...(room.pool || [])];

      if (poolCopy.length === 0) {
        room.tableSets = restoredSets;
        room.players[idx] = { ...p, hand: restoredHand };
        settleRummikubRound(room, null);
        return room;
      }

      const drawnTile = poolCopy.shift()!;
      const updatedHand = [...restoredHand, drawnTile];

      room.pool = poolCopy;
      room.tableSets = restoredSets;
      room.players[idx] = { ...p, hand: updatedHand };

      const nextIdx = getNextAlivePlayerIdx(room.players, idx);
      const nextPlayer = room.players[nextIdx];
      room.currentPlayerIdx = nextIdx;
      room.turnStartTableSets = restoredSets;
      room.turnStartHand = nextPlayer.hand;
      room.turnAddedFromHandIds = [];
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `🀄 ${p.name}님이 타일 1장을 뽑고 턴을 마쳤습니다. (남은 타일 ${poolCopy.length}장) 👉 ${nextPlayer.name}님 차례!`;
      return room;
    });
    setSelectedHandIds([]);
  };

  const handleNetTurnTimeout = async (room: NetRummiRoomData) => {
    const roomRef = ref(db, `rummikub_rooms/room_${room.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const r = roomData as NetRummiRoomData;
      if (r.status !== 'PLAYING') return r;

      const idx = r.currentPlayerIdx;
      const p = r.players[idx];
      if (!p) return r;

      const restoredSets = r.turnStartTableSets || [];
      const restoredHand = [...(r.turnStartHand || p.hand)];
      const poolCopy = [...(r.pool || [])];

      if (poolCopy.length === 0) {
        r.tableSets = restoredSets;
        r.players[idx] = { ...p, hand: restoredHand };
        settleRummikubRound(r, null);
        return r;
      }

      const drawn = poolCopy.shift()!;
      r.pool = poolCopy;
      r.tableSets = restoredSets;
      r.players[idx] = { ...p, hand: [...restoredHand, drawn] };

      const nextIdx = getNextAlivePlayerIdx(r.players, idx);
      const nextPlayer = r.players[nextIdx];
      r.currentPlayerIdx = nextIdx;
      r.turnStartTableSets = restoredSets;
      r.turnStartHand = nextPlayer.hand;
      r.turnAddedFromHandIds = [];
      r.turnDeadline = Date.now() + r.baseTimeout * 1000;
      r.turnNotice = `⏰ 시간 초과로 ${p.name}님의 조작이 원상복구되고 타일 1장을 받았습니다. 👉 ${nextPlayer.name}님 차례!`;
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
        hasMelded: false,
        chips: INITIAL_CHIPS,
        wins: 0,
        score: 0,
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
      showToast('루미큐브는 최소 2명 이상의 플레이어가 필요합니다!', 'info');
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
        hand: [] as RummiTile[],
        hasMelded: false,
        chips,
        wins: isFreshMatch ? 0 : p.wins,
        score: isFreshMatch ? 0 : p.score,
        currentBet: 0,
        isEliminated: eliminated,
      };
    });

    const alivePlayers = checkedPlayers.filter((p) => !p.isEliminated);
    if (alivePlayers.length < 2) return;

    const equalStake = Math.min(soloAnteBet, ...alivePlayers.map((p) => p.chips));
    let totalPot = isFreshMatch ? 0 : soloPot;
    const deckCopy = createRummikubDeck();

    const preparedPlayers = checkedPlayers.map((p) => {
      if (p.isEliminated) return p;
      totalPot += equalStake;
      return {
        ...p,
        hand: sortTilesByColor(deckCopy.splice(0, 14)),
        chips: p.chips - equalStake,
        currentBet: equalStake,
      };
    });

    const firstAliveIdx = preparedPlayers.findIndex((p) => !p.isEliminated);
    triggerChipAnimation('전원', equalStake, '#f59e0b');
    const notice = `💰 [${nextRound}라운드] 전원 ${equalStake.toLocaleString()}칩 베팅! 각자 14장 분배 완료! ${preparedPlayers[firstAliveIdx].name}님 차례 (첫 등록 30점 이상)`;

    setSoloRoundNum(nextRound);
    setSoloPot(totalPot);
    setPlayers(preparedPlayers);
    setPool(deckCopy);
    setTableSets([]);
    setTurnStartTableSets([]);
    setTurnStartHand(preparedPlayers[firstAliveIdx].hand);
    setTurnAddedFromHandIds([]);
    setSelectedHandIds([]);
    setCurrentPlayerIdx(firstAliveIdx);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setWinnerAnnouncement('');
    setShowFireworks(false);
    setTurnNotice(notice);
    speakKorean(notice);
    setGameState('PLAYING');
  };

  const settleSoloRound = (finalPlayers: RummiPlayer[], directWinnerId: string | null) => {
    const alive = finalPlayers.filter((p) => !p.isEliminated);
    let winner = alive.find((p) => p.id === directWinnerId) || alive[0];

    if (!directWinnerId) {
      let minPenalty = Infinity;
      for (const p of alive) {
        const penalty = calculateHandPenalty(p.hand);
        if (penalty < minPenalty) {
          minPenalty = penalty;
          winner = p;
        }
      }
    }

    let totalLoserPenalties = 0;
    for (const p of alive) {
      if (p.id !== winner.id) {
        totalLoserPenalties += calculateHandPenalty(p.hand);
      }
    }

    const settledPlayers = finalPlayers.map((p) => {
      if (p.isEliminated) return p;
      const isWinner = p.id === winner.id;
      const penalty = calculateHandPenalty(p.hand);
      const scoreDelta = isWinner ? totalLoserPenalties : -penalty;
      const updatedChips = isWinner ? p.chips + soloPot : p.chips;
      const busted = updatedChips <= 0;
      return {
        ...p,
        chips: updatedChips,
        wins: isWinner ? p.wins + 1 : p.wins,
        score: p.score + scoreDelta,
        isEliminated: busted,
      };
    });

    const winnerObj = settledPlayers.find((p) => p.id === winner.id)!;
    const remainingAlive = settledPlayers.filter((p) => !p.isEliminated);
    const bustedNames = settledPlayers.filter((p) => p.isEliminated).map((p) => p.name);
    const bustText =
      bustedNames.length > 0 ? ` · 💀 ${bustedNames.join(', ')}님 판돈 소진 아웃!` : '';

    const reasonText = directWinnerId
      ? '루미큐브(손패 0장) 달성'
      : '타일 소진 최저 벌점 승리';

    const announcement =
      remainingAlive.length <= 1
        ? `👑 최종 우승! ${winner.name}님이 ${reasonText}(+${totalLoserPenalties}점)로 판돈 ${soloPot.toLocaleString()}칩을 독식했습니다!${bustText}`
        : `🎊 ${winner.name}님 ${reasonText} (+${totalLoserPenalties}점)! 판돈 ${soloPot.toLocaleString()}칩 독식! (${winnerObj.wins}승 · 누적 ${winnerObj.chips.toLocaleString()}칩)${bustText}`;

    setPlayers(settledPlayers);
    setSoloPot(0);
    setTurnNotice('');
    setWinnerAnnouncement(announcement);
    setGameState(remainingAlive.length <= 1 ? 'MATCH_OVER' : 'ROUND_OVER');
    triggerFireworksCelebration(announcement);

    saveHallOfFameRecord('SOLO', {
      name: winnerObj.name,
      scoreOrLevel: `${winnerObj.wins}승 (${winnerObj.score}점) · ${winnerObj.chips.toLocaleString()}칩`,
    });
  };

  const handleSoloCreateNewSet = () => {
    if (gameState !== 'PLAYING') return;
    if (selectedHandIds.length === 0) {
      showToast('손패에서 테이블로 내릴 타일을 먼저 선택해주세요.', 'info');
      return;
    }

    const actor = players[currentPlayerIdx];
    const movingTiles = actor.hand.filter((t) => selectedHandIds.includes(t.id));
    if (movingTiles.length === 0) return;

    const { orderedTiles } = validateRummikubSet(movingTiles);
    const newSet: TableSet = {
      id: `set_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      tiles: orderedTiles,
    };

    const updatedPlayers = players.map((p, idx) =>
      idx === currentPlayerIdx
        ? { ...p, hand: p.hand.filter((t) => !selectedHandIds.includes(t.id)) }
        : p
    );

    playSound('place');
    setPlayers(updatedPlayers);
    setTableSets([...tableSets, newSet]);
    setTurnAddedFromHandIds([...turnAddedFromHandIds, ...movingTiles.map((t) => t.id)]);
    setSelectedHandIds([]);
  };

  const handleSoloAppendToSet = (targetSetId: string) => {
    if (gameState !== 'PLAYING') return;
    const actor = players[currentPlayerIdx];
    if (!actor.hasMelded) {
      showToast('첫 등록(30점 이상) 완료 전에는 기존 테이블 세트를 건드릴 수 없습니다!', 'danger');
      return;
    }
    if (selectedHandIds.length === 0) {
      showToast('붙일 손패 타일을 먼저 선택하거나, 세트의 타일을 클릭해 가져오세요.', 'info');
      return;
    }

    const movingTiles = actor.hand.filter((t) => selectedHandIds.includes(t.id));
    if (movingTiles.length === 0) return;

    const updatedPlayers = players.map((p, idx) =>
      idx === currentPlayerIdx
        ? { ...p, hand: p.hand.filter((t) => !selectedHandIds.includes(t.id)) }
        : p
    );

    const updatedSets = tableSets.map((s) => {
      if (s.id !== targetSetId) return s;
      const merged = [...s.tiles, ...movingTiles];
      return { ...s, tiles: validateRummikubSet(merged).orderedTiles };
    });

    playSound('place');
    setPlayers(updatedPlayers);
    setTableSets(updatedSets);
    setTurnAddedFromHandIds([...turnAddedFromHandIds, ...movingTiles.map((t) => t.id)]);
    setSelectedHandIds([]);
  };

  const handleSoloPickFromTable = (setId: string, tileId: string) => {
    if (gameState !== 'PLAYING') return;
    const actor = players[currentPlayerIdx];
    const isMyOwnUncommittedTile = turnAddedFromHandIds.includes(tileId);
    if (!actor.hasMelded && !isMyOwnUncommittedTile) {
      showToast('첫 등록(30점 이상) 전에는 기존 테이블 타일을 가져올 수 없습니다!', 'danger');
      return;
    }

    let pickedTile: RummiTile | null = null;
    const updatedSets: TableSet[] = [];

    for (const s of tableSets) {
      const found = s.tiles.find((t) => t.id === tileId);
      if (s.id === setId && found) {
        pickedTile = found;
        const rest = s.tiles.filter((t) => t.id !== tileId);
        if (rest.length > 0) {
          updatedSets.push({ ...s, tiles: rest });
        }
      } else {
        updatedSets.push(s);
      }
    }

    if (!pickedTile) return;

    const updatedPlayers = players.map((p, idx) =>
      idx === currentPlayerIdx ? { ...p, hand: [...p.hand, pickedTile!] } : p
    );

    playSound('place');
    setTableSets(updatedSets);
    setPlayers(updatedPlayers);
    setTurnAddedFromHandIds(turnAddedFromHandIds.filter((id) => id !== tileId));
  };

  const handleSoloRevertTurn = () => {
    if (gameState !== 'PLAYING') return;
    const updatedPlayers = players.map((p, idx) =>
      idx === currentPlayerIdx ? { ...p, hand: turnStartHand } : p
    );
    setTableSets(turnStartTableSets);
    setPlayers(updatedPlayers);
    setTurnAddedFromHandIds([]);
    setSelectedHandIds([]);
    showToast('↩️ 이번 턴 시작 상태로 원상복구했습니다.', 'info');
  };

  const handleSoloRevertAndDraw = (isTimeout = false) => {
    if (gameState !== 'PLAYING') return;
    const actor = players[currentPlayerIdx];
    const poolCopy = [...pool];

    if (poolCopy.length === 0) {
      const restoredPlayers = players.map((p, idx) =>
        idx === currentPlayerIdx ? { ...p, hand: turnStartHand } : p
      );
      setTableSets(turnStartTableSets);
      settleSoloRound(restoredPlayers, null);
      return;
    }

    playSound('draw');
    const drawnTile = poolCopy.shift()!;
    const updatedPlayers = players.map((p, idx) =>
      idx === currentPlayerIdx ? { ...p, hand: [...turnStartHand, drawnTile] } : p
    );

    const nextIdx = getNextAlivePlayerIdx(updatedPlayers, currentPlayerIdx);
    const nextPlayer = updatedPlayers[nextIdx];
    const notice = isTimeout
      ? `⏰ 시간 초과로 ${actor.name}님이 원상복구 후 타일 1장을 받았습니다. 👉 ${nextPlayer.name}님 차례!`
      : `🀄 ${actor.name}님이 타일 1장을 뽑고 턴을 마쳤습니다. (남은 타일 ${poolCopy.length}장) 👉 ${nextPlayer.name}님 차례!`;

    setPool(poolCopy);
    setTableSets(turnStartTableSets);
    setPlayers(updatedPlayers);
    setTurnStartTableSets(turnStartTableSets);
    setTurnStartHand(nextPlayer.hand);
    setTurnAddedFromHandIds([]);
    setSelectedHandIds([]);
    setCurrentPlayerIdx(nextIdx);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setTurnNotice(notice);
    speakKorean(notice);
  };

  const handleSoloEndTurn = () => {
    if (gameState !== 'PLAYING') return;
    const actor = players[currentPlayerIdx];
    const addedCount = turnAddedFromHandIds.length;

    if (addedCount === 0) {
      handleSoloRevertAndDraw(false);
      return;
    }

    for (const s of tableSets) {
      const res = validateRummikubSet(s.tiles);
      if (!res.valid) {
        showToast(
          '❌ 테이블에 규칙에 맞지 않는 세트(3장 미만 또는 색상/숫자 오류)가 있습니다!',
          'danger'
        );
        return;
      }
    }

    if (!actor.hasMelded) {
      const startSetIds = new Set(turnStartTableSets.map((s) => s.id));
      const newlyAddedSets = tableSets.filter((s) => !startSetIds.has(s.id));
      const meldScore = newlyAddedSets.reduce(
        (acc, s) => acc + validateRummikubSet(s.tiles).points,
        0
      );
      if (meldScore < 30) {
        showToast(
          `❌ 첫 등록은 본인 손패만으로 합계 30점 이상이어야 합니다! (현재 ${meldScore}점)`,
          'danger'
        );
        return;
      }
    }

    playSound('place');
    const normalizedSets = tableSets.map((s) => ({
      ...s,
      tiles: validateRummikubSet(s.tiles).orderedTiles,
    }));

    const updatedPlayers = players.map((p, idx) =>
      idx === currentPlayerIdx ? { ...p, hasMelded: true } : p
    );

    if (actor.hand.length === 0) {
      setTableSets(normalizedSets);
      settleSoloRound(updatedPlayers, actor.id);
      return;
    }

    const nextIdx = getNextAlivePlayerIdx(updatedPlayers, currentPlayerIdx);
    const nextPlayer = updatedPlayers[nextIdx];
    const notice = `✅ ${actor.name}님이 타일 ${addedCount}장을 등록했습니다! (남은 손패 ${actor.hand.length}장) 👉 ${nextPlayer.name}님 차례!`;

    setTableSets(normalizedSets);
    setPlayers(updatedPlayers);
    setTurnStartTableSets(normalizedSets);
    setTurnStartHand(nextPlayer.hand);
    setTurnAddedFromHandIds([]);
    setSelectedHandIds([]);
    setCurrentPlayerIdx(nextIdx);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setTurnNotice(notice);
    speakKorean(notice);
  };

  // =========================================================================
  // 공용 UI 렌더링 헬퍼 (루미큐브 타일, 테이블 세트, 랙, 폭죽/칩 이펙트)
  // =========================================================================
  const toggleHandTileSelection = (tileId: string) => {
    setSelectedHandIds((prev) =>
      prev.includes(tileId) ? prev.filter((id) => id !== tileId) : [...prev, tileId]
    );
  };

  const renderRummiTile = (
    tile: RummiTile,
    options?: {
      selected?: boolean;
      mini?: boolean;
      onClick?: () => void;
    }
  ) => {
    const colorClass = tile.isJoker ? 'joker' : tile.color.toLowerCase();
    return (
      <button
        key={tile.id}
        type="button"
        className={`rk-tile ${colorClass} ${options?.selected ? 'selected' : ''} ${
          options?.mini ? 'mini' : ''
        }`}
        onClick={options?.onClick}
      >
        <span className="rk-tile-num">{tile.isJoker ? '😊' : tile.number}</span>
        <span className="rk-tile-dot" />
      </button>
    );
  };

  const renderTableSetsArea = (
    sets: TableSet[],
    canInteract: boolean,
    onPickTile: (setId: string, tileId: string) => void,
    onAppendSet: (setId: string) => void
  ) => {
    if (!sets || sets.length === 0) {
      return (
        <div className="rk-empty-table-hint">
          테이블이 비어 있습니다. 손패에서 <strong>합계 30점 이상</strong>의 세트를 선택해 첫 등록을
          진행하세요!
        </div>
      );
    }

    return (
      <div className="rk-table-sets-wrap">
        {sets.map((setItem) => {
          const check = validateRummikubSet(setItem.tiles);
          return (
            <div
              key={setItem.id}
              className={`rk-set-group ${check.valid ? 'valid' : 'invalid'}`}
            >
              <div className="rk-set-tiles">
                {setItem.tiles.map((t) =>
                  renderRummiTile(t, {
                    mini: true,
                    onClick: canInteract ? () => onPickTile(setItem.id, t.id) : undefined,
                  })
                )}
              </div>
              {canInteract && selectedHandIds.length > 0 && (
                <button
                  type="button"
                  className="rk-append-btn"
                  onClick={() => onAppendSet(setItem.id)}
                  title="선택한 손패 타일을 이 세트에 합치기"
                >
                  ➕ 합치기
                </button>
              )}
              {!check.valid && <span className="rk-invalid-tag">⚠️ 미완성</span>}
            </div>
          );
        })}
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
      <div className="rk-container" style={{ background: PLAYER_BG_COLORS[0] }}>
        <div className="setup-card home-entry-card">
          <div className="home-castle-icon">🀄😊💰</div>
          <h1 className="setup-title">루미큐브 (RUMMIKUB)</h1>
          <p className="home-subtitle">
            동일 판돈 승자 독식 · 106장 숫자 타일 조합 · 파산 시 즉시 아웃
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
              <span className="mode-desc">2~4인 로컬 동일 판돈 서바이벌 루미큐브</span>
            </button>

            <button
              type="button"
              className="mode-select-btn net"
              onClick={() => setAppMode('NET_LOBBY')}
            >
              <span className="mode-icon">🌐</span>
              <strong>넷게임</strong>
              <span className="mode-desc">실시간 4개 테이블 대전 (창 닫기 시 자동 퇴장)</span>
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
      <div className="rk-container" style={{ background: PLAYER_BG_COLORS[0], padding: '16px' }}>
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
              <h3
                style={{
                  margin: '0 0 8px',
                  fontSize: '15px',
                  color: '#1e3a8a',
                  textAlign: 'center',
                }}
              >
                🎮 단독 플레이 TOP 10
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
              <h3
                style={{
                  margin: '0 0 8px',
                  fontSize: '15px',
                  color: '#b45309',
                  textAlign: 'center',
                }}
              >
                🌐 넷플레이 TOP 10
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
      <div className="rk-container" style={{ background: PLAYER_BG_COLORS[0] }}>
        <div className="net-lobby-container">
          <div className="net-lobby-header">
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, fontSize: '20px', color: '#0f172a' }}>
              🌐 루미큐브 넷게임 (4개 테이블)
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

              let statusBadgeText = '🟢 빈 테이블';
              let statusClass = 'empty';
              if (isPlaying) {
                statusBadgeText = `🔥 ${room.roundNumber}판째 진행중`;
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
                    <span className="room-number-title">🀄 제 {room.roomId} 루미큐브룸</span>
                    <span className={`room-status-pill ${statusClass}`}>{statusBadgeText}</span>
                  </div>

                  <div className="room-rules-info">
                    <span>💰 동일 판돈: {room.anteBet.toLocaleString()}칩</span>
                    <span>⏱️ 턴 제한: {room.baseTimeout}초</span>
                  </div>

                  <div className="room-members-box">
                    <div className="room-members-label">참가자 ({roomPlayers.length}/4):</div>
                    <div className="room-members-chips">
                      {roomPlayers.length === 0 ? (
                        <span className="empty-member-text">첫 번째 승부사를 기다리고 있습니다</span>
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
                      ⏳ 다음 판 예약 ({roomWaitlist.length}명):{' '}
                      {roomWaitlist.map((w) => w.name).join(', ')}
                    </div>
                  )}

                  <div className="room-enter-cta">
                    {isEmpty
                      ? '👉 클릭하여 테이블 열기 또는 관망하기'
                      : isPlaying || isFull
                      ? '👉 클릭하여 다음 판 예약 또는 관망하기'
                      : '👉 클릭하여 참가하기 또는 관망하기'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {joinModalRoom && (
          <div className="modal-overlay" onClick={() => setJoinModalRoom(null)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h2 style={{ margin: '0 0 8px' }}>🀄 제 {joinModalRoom.roomId} 루미큐브룸 입장</h2>
              <p className="modal-subtext">
                전원 동일 판돈 <strong>{joinModalRoom.anteBet.toLocaleString()}칩</strong>을 걸고
                승부가 진행됩니다.
              </p>

              <input
                type="text"
                className="player-input"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: '14px' }}
                placeholder="내 이름 입력 (예: 타짜)"
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
                  🚀 참가하기 / 예약하기
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
          className="rk-container"
          style={{
            background: PLAYER_BG_COLORS[0],
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div className="setup-card" style={{ textAlign: 'center' }}>
            <h2>⏳ 방 정보를 불러오는 중입니다...</h2>
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
        <div className="rk-container" style={{ background: PLAYER_BG_COLORS[0] }}>
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
              🀄 루미큐브 대기실 {amISpectator ? '👀 [관망모드]' : ''}
            </h1>

            <div className="setting-section">
              <label className="setting-label">
                💰 동일 판돈 설정 (초기 10,000칩 · 전원 동일 금액 베팅){' '}
                {isHost ? '(방장 설정 가능)' : '(방장 설정 중)'}
              </label>
              <div className="piece-count-selector" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
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
                ⏱️ 턴 제한시간: <strong>{activeNetRoom.baseTimeout}초</strong>{' '}
                {isHost ? '(방장 설정 가능)' : ''}
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700 }}>30초</span>
                <input
                  type="range"
                  min={30}
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
              <label className="setting-label">🧭 입장한 플레이어 (2명 이상 시 시작 가능)</label>
              <div className="player-list">
                {roomPlayers.map((p, idx) => (
                  <div key={p.id} className="player-item">
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="squircle-dot" style={{ backgroundColor: PIECE_COLORS[idx] }}>
                        {getShortName(p.name)}
                      </span>
                      {p.name} {idx === 0 && '👑(방장)'} {p.id === mySessionId && '(나)'}
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
              🚀 루미큐브 시작! (전원 {activeNetRoom.anteBet.toLocaleString()}칩 동일 베팅)
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

    const selectedTilesPreview = myPlayerObj
      ? myPlayerObj.hand.filter((t) => selectedHandIds.includes(t.id))
      : [];
    const previewValidation = validateRummikubSet(selectedTilesPreview);
    const addedCountThisTurn = (activeNetRoom.turnAddedFromHandIds || []).length;

    const handleNetSortHand = async (mode: 'COLOR' | 'NUMBER') => {
      if (!myPlayerObj) return;
      const roomRef = ref(db, `rummikub_rooms/room_${activeNetRoom.roomId}`);
      await runTransaction(roomRef, (roomData) => {
        if (!roomData) return roomData;
        const room = roomData as NetRummiRoomData;
        room.players = (room.players || []).map((p) =>
          p.id === mySessionId
            ? {
                ...p,
                hand: mode === 'COLOR' ? sortTilesByColor(p.hand) : sortTilesByNumber(p.hand),
              }
            : p
        );
        return room;
      });
    };

    return (
      <div
        className="rk-container"
        style={{ background: PLAYER_BG_COLORS[netCurrIdx % PLAYER_BG_COLORS.length] }}
      >
        {renderFireworksAndChips()}

        {toast && (
          <div key={toast.id} className={`rk-toast ${toast.type}`}>
            {toast.text}
          </div>
        )}

        <div className="play-wrapper compact-tablet-mode">
          <div className="game-header compact-header">
            <div className="net-level-timer-box">
              <span className="net-level-badge">
                {activeNetRoom.roundNumber}판째 {amISpectator ? '👀[관망]' : ''}
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
                          <span className="tile-count-pill">🀄{p.hand.length}장</span>
                          <span className={`meld-pill ${p.hasMelded ? 'done' : 'wait'}`}>
                            {p.hasMelded ? '등록완료' : '미등록'}
                          </span>
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
                ? '⏳ 현재 다음 판 예약 대기 중입니다! 이번 판이 끝나면 빈자리에 자동 참가됩니다.'
                : `⏳ 다음 판 예약자 (${roomWaitlist.length}명): ${roomWaitlist
                    .map((w) => w.name)
                    .join(', ')}`}
            </div>
          )}

          {/* 중앙 공용 루미큐브 보드 */}
          <div className="rk-table-board">
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
                      : `🔥 다음 게임 시작 (동일 판돈 ${activeNetRoom.anteBet.toLocaleString()}칩 누적)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={activeNetRoom.turnNotice} className="rk-notice-banner">
                {activeNetRoom.turnNotice}
              </div>
            )}

            <div className="rk-table-top-meta">
              <div className="center-pot-box">
                <span className="pot-label">💰 POT</span>
                <strong className="pot-amount">
                  {(activeNetRoom.pot || 0).toLocaleString()} 칩
                </strong>
              </div>
              <div className="center-pool-badge">
                🀄 남은 타일 주머니: <strong>{activeNetRoom.pool.length}장</strong>
              </div>
            </div>

            <div className="rk-table-felt-surface">
              {renderTableSetsArea(
                activeNetRoom.tableSets,
                isMyTurn,
                handleNetPickFromTable,
                handleNetAppendToSet
              )}
            </div>
          </div>

          {amISpectator && (
            <div className="rk-bottom-dock">
              <div className="waiting-dock-msg">
                👀 관망모드에서는 각 플레이어의 개인 손패 타일이 비공개 보호됩니다.
              </div>
            </div>
          )}

          {myPlayerObj && !amISpectator && (
            <div
              className="rk-bottom-dock"
              style={{ borderTop: `4px solid ${myPlayerObj.badgeColor}` }}
            >
              {myPlayerObj.isEliminated ? (
                <div className="waiting-dock-msg" style={{ color: '#dc2626' }}>
                  💀 보유한 판돈을 모두 소진하여 아웃되었습니다. 다음 매치가 열릴 때까지 관전합니다.
                </div>
              ) : (
                <>
                  <div className="rk-rack-header">
                    <span className="rk-rack-title">
                      내 손패 ({myPlayerObj.hand.length}장 ·{' '}
                      {myPlayerObj.hasMelded ? '✅ 첫 등록 완료' : '🔒 첫 등록 30점 이상 필요'})
                    </span>
                    <div className="rk-sort-btns">
                      <button
                        type="button"
                        className="rk-mini-tool-btn"
                        onClick={() => handleNetSortHand('COLOR')}
                      >
                        🎨 색깔순
                      </button>
                      <button
                        type="button"
                        className="rk-mini-tool-btn"
                        onClick={() => handleNetSortHand('NUMBER')}
                      >
                        🔢 숫자순
                      </button>
                    </div>
                  </div>

                  <div className="rk-hand-rack">
                    {myPlayerObj.hand.map((t) =>
                      renderRummiTile(t, {
                        selected: selectedHandIds.includes(t.id),
                        onClick: () => toggleHandTileSelection(t.id),
                      })
                    )}
                  </div>

                  {activeNetRoom.status === 'PLAYING' && (
                    <div className="rk-actions-row">
                      <button
                        type="button"
                        className="rk-act-btn place"
                        disabled={!isMyTurn || selectedHandIds.length === 0}
                        onClick={handleNetCreateNewSet}
                      >
                        📤 새 세트로 내리기{' '}
                        {selectedHandIds.length > 0 &&
                          `(${selectedHandIds.length}장 · ${
                            previewValidation.valid ? `${previewValidation.points}점` : '미완성'
                          })`}
                      </button>

                      <button
                        type="button"
                        className="rk-act-btn revert"
                        disabled={!isMyTurn}
                        onClick={handleNetRevertTurn}
                      >
                        ↩️ 이번 턴 원상복구
                      </button>

                      <button
                        type="button"
                        className={`rk-act-btn ${addedCountThisTurn > 0 ? 'submit' : 'draw'}`}
                        disabled={!isMyTurn}
                        onClick={handleNetEndTurnOrDraw}
                      >
                        {addedCountThisTurn > 0
                          ? `✅ 등록 완료 (${addedCountThisTurn}장 제출)`
                          : '🀄 1장 뽑고 패스'}
                      </button>
                    </div>
                  )}

                  {isRoundEnded && (
                    <div className="waiting-dock-msg">
                      🏆 라운드 종료! 상단의 <strong>[다음 게임 시작]</strong> 버튼으로 승수와 판돈을
                      이어가세요!
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
  // 5. 단독게임(SOLO) - 2~4인 로컬 동일 판돈 누적 & 파산 아웃 서바이벌
  // =========================================================================
  const currentPlayer = players[currentPlayerIdx] || players[0];
  const currentBackground =
    gameState === 'PLAYING' && players.length > 0
      ? PLAYER_BG_COLORS[currentPlayerIdx % PLAYER_BG_COLORS.length]
      : PLAYER_BG_COLORS[0];
  const isSoloEnded = gameState === 'ROUND_OVER' || gameState === 'MATCH_OVER';

  const soloSelectedTiles = currentPlayer
    ? currentPlayer.hand.filter((t) => selectedHandIds.includes(t.id))
    : [];
  const soloPreviewValidation = validateRummikubSet(soloSelectedTiles);

  const handleSoloSortHand = (mode: 'COLOR' | 'NUMBER') => {
    setPlayers(
      players.map((p, idx) =>
        idx === currentPlayerIdx
          ? {
              ...p,
              hand: mode === 'COLOR' ? sortTilesByColor(p.hand) : sortTilesByNumber(p.hand),
            }
          : p
      )
    );
  };

  return (
    <div className="rk-container" style={{ background: currentBackground }}>
      {renderFireworksAndChips()}

      {toast && (
        <div key={toast.id} className={`rk-toast ${toast.type}`}>
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
          <h1 className="setup-title">🀄 루미큐브 (단독게임 · 동일 판돈 독식)</h1>

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
              <span style={{ fontSize: '12px', fontWeight: 700 }}>30초</span>
              <input
                type="range"
                min={30}
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
              🧭 플레이어 등록 (2~4명 · 판돈 0칩 시 즉시 아웃)
            </label>
            <div className="input-group">
              <input
                type="text"
                className="player-input"
                placeholder="플레이어 이름 입력 후 추가"
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
            <h2 style={{ margin: 0, fontSize: '20px' }}>📋 진행 순서를 정해주세요</h2>
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
              🚀 루미큐브 시작! (전원 {soloAnteBet.toLocaleString()}칩 동일 베팅)
            </button>
          </div>
        </div>
      )}

      {(gameState === 'PLAYING' || gameState === 'ROUND_OVER' || gameState === 'MATCH_OVER') &&
        currentPlayer && (
          <div className="play-wrapper compact-tablet-mode">
            <div className="game-header compact-header">
              <div className="net-level-timer-box">
                <span className="net-level-badge">{soloRoundNum}판째</span>
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
                            <span className="tile-count-pill">🀄{p.hand.length}장</span>
                            <span className={`meld-pill ${p.hasMelded ? 'done' : 'wait'}`}>
                              {p.hasMelded ? '등록완료' : '미등록'}
                            </span>
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

            <div className="rk-table-board">
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
                        : `🔥 다음 게임 시작 (동일 판돈 ${soloAnteBet.toLocaleString()}칩 누적)`}
                    </button>
                  </div>
                </div>
              ) : (
                <div key={turnNotice} className="rk-notice-banner">
                  {turnNotice}
                </div>
              )}

              <div className="rk-table-top-meta">
                <div className="center-pot-box">
                  <span className="pot-label">💰 POT</span>
                  <strong className="pot-amount">{soloPot.toLocaleString()} 칩</strong>
                </div>
                <div className="center-pool-badge">
                  🀄 남은 타일 주머니: <strong>{pool.length}장</strong>
                </div>
              </div>

              <div className="rk-table-felt-surface">
                {renderTableSetsArea(
                  tableSets,
                  gameState === 'PLAYING',
                  handleSoloPickFromTable,
                  handleSoloAppendToSet
                )}
              </div>
            </div>

            <div
              className="rk-bottom-dock"
              style={{ borderTop: `4px solid ${currentPlayer.badgeColor}` }}
            >
              <div className="rk-rack-header">
                <span
                  className="turn-owner-pill large-turn-pill"
                  style={{ backgroundColor: currentPlayer.badgeColor }}
                >
                  👉 {currentPlayer.name}님 ({currentPlayer.hand.length}장 ·{' '}
                  {currentPlayer.hasMelded ? '등록완료' : '첫등록 30점↑'})
                </span>
                <div className="rk-sort-btns">
                  <button
                    type="button"
                    className="rk-mini-tool-btn"
                    onClick={() => handleSoloSortHand('COLOR')}
                  >
                    🎨 색깔순
                  </button>
                  <button
                    type="button"
                    className="rk-mini-tool-btn"
                    onClick={() => handleSoloSortHand('NUMBER')}
                  >
                    🔢 숫자순
                  </button>
                </div>
              </div>

              <div className="rk-hand-rack">
                {currentPlayer.hand.map((t) =>
                  renderRummiTile(t, {
                    selected: selectedHandIds.includes(t.id),
                    onClick: () => toggleHandTileSelection(t.id),
                  })
                )}
              </div>

              {gameState === 'PLAYING' && (
                <div className="rk-actions-row">
                  <button
                    type="button"
                    className="rk-act-btn place"
                    disabled={selectedHandIds.length === 0}
                    onClick={handleSoloCreateNewSet}
                  >
                    📤 새 세트로 내리기{' '}
                    {selectedHandIds.length > 0 &&
                      `(${selectedHandIds.length}장 · ${
                        soloPreviewValidation.valid
                          ? `${soloPreviewValidation.points}점`
                          : '미완성'
                      })`}
                  </button>

                  <button
                    type="button"
                    className="rk-act-btn revert"
                    onClick={handleSoloRevertTurn}
                  >
                    ↩️ 이번 턴 원상복구
                  </button>

                  <button
                    type="button"
                    className={`rk-act-btn ${turnAddedFromHandIds.length > 0 ? 'submit' : 'draw'}`}
                    onClick={handleSoloEndTurn}
                  >
                    {turnAddedFromHandIds.length > 0
                      ? `✅ 등록 완료 (${turnAddedFromHandIds.length}장 제출)`
                      : '🀄 1장 뽑고 패스'}
                  </button>
                </div>
              )}

              {isSoloEnded && (
                <div className="waiting-dock-msg">
                  🎉 라운드 종료! <strong>[다음 게임 시작]</strong>을 눌러 승수와 판돈을 계속
                  이어가세요!
                </div>
              )}
            </div>
          </div>
        )}
    </div>
  );
}