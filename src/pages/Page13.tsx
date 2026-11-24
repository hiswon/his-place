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
import './Page13.css';

// 0: 빈 칸, 1: 블루 칩(선공), 2: 그린 칩(후공)
type ChipOwner = 0 | 1 | 2;

interface SequencePlayer {
  id: string;
  name: string;
  chipColor: 1 | 2; // 1: 파랑, 2: 초록
  chips: number; // 보유 판돈 머니
  wins: number; // 누적 승수
  currentBet: number;
  isEliminated: boolean;
  hand: string[]; // 보유 카드 패 (7장)
}

interface WaitlistPlayer {
  id: string;
  name: string;
}

interface SpectatorPlayer {
  id: string;
  name: string;
}

interface SequenceLine {
  indices: number[];
  owner: 1 | 2;
}

interface NetSequenceRoomData {
  roomId: number;
  status: 'EMPTY' | 'WAITING' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER';
  players: SequencePlayer[];
  pot: number;
  waitlist: WaitlistPlayer[];
  spectators: SpectatorPlayer[];
  baseTimeout: number;
  anteBet: number;
  roundNumber: number;
  boardTokens: ChipOwner[]; // 100칸 (10x10)
  deck: string[];
  discardPile: string[];
  lockedIndices: number[]; // 완성된 5목(시퀀스)에 포함된 인덱스 (제거 불가)
  blueSeqCount: number;
  greenSeqCount: number;
  currentTurn: 1 | 2;
  lastMoveIdx: number | null;
  lastActionType: 'PLACE' | 'REMOVE' | null;
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

// 사진 속 밝은 오크/단풍나무 원목 테이블 배경
const WOOD_BG_THEMES = [
  'radial-gradient(circle at top, #d9a875 0%, #bd8650 58%, #966232 100%)',
];

const INITIAL_CHIPS = 10000;
const DEFAULT_TIMEOUT_SEC = 60;
const HAND_SIZE = 7; // 2인 대전 정식 핸드 수 7장
const TARGET_SEQUENCES = 2; // 2인 대전 정식 승리 조건: 2줄(5목 x 2) 완성

/**
 * 정통 시퀀스 10x10 (100칸) 보드 레이아웃
 * 'FREE': 네 모서리 와일드 칸 (양 플레이어 모두 공용 5번째 칸으로 사용 가능)
 * J(잭) 카드는 보드판에 존재하지 않음 (두눈박이 J=와일드 착수, 외눈박이 J=상대 칩 제거)
 */
const SEQUENCE_BOARD_LAYOUT: readonly string[] = [
  'FREE', '2S', '3S', '4S', '5S', '6S', '7S', '8S', '9S', 'FREE',
  '6C', '5C', '4C', '3C', '2C', 'AH', 'KH', 'QH', '10H', '10S',
  '7C', 'AS', '2D', '3D', '4D', '5D', '6D', '7D', '9H', 'QS',
  '8C', 'KS', '6C', '5C', '4C', '3C', '2C', '8D', '8H', 'KS',
  '9C', 'QS', '7C', '6H', '5H', '4H', 'AH', '9D', '7H', 'AS',
  '10C', '10S', '8C', '7H', '2H', '3H', 'KH', '10D', '6H', '2D',
  'QC', '9S', '9C', '8H', '9H', '10H', 'QH', 'QD', '5H', '3D',
  'KC', '8S', '10C', 'QC', 'KC', 'AC', 'AD', 'KD', '4H', '4D',
  'AC', '7S', '6S', '5S', '4S', '3S', '2S', '2H', '3H', '5D',
  'FREE', 'AD', 'KD', 'QD', '10D', '9D', '8D', '7D', '6D', 'FREE',
];

const CORNER_INDICES = new Set([0, 9, 90, 99]);

const SUITS = ['S', 'H', 'D', 'C'] as const;
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;

/**
 * 104장(트럼프 2덱) 생성 및 셔플
 */
function createShuffledDoubleDeck(): string[] {
  const deck: string[] = [];
  for (let d = 0; d < 2; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push(`${rank}${suit}`);
      }
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * 두눈박이 잭(와일드 착수): JD, JC
 * 외눈박이 잭(상대 칩 제거): JH, JS
 */
function isTwoEyedJack(card: string): boolean {
  return card === 'JD' || card === 'JC';
}

function isOneEyedJack(card: string): boolean {
  return card === 'JH' || card === 'JS';
}

function getSuitSymbol(suit: string): string {
  switch (suit) {
    case 'S':
      return '♠';
    case 'H':
      return '♥';
    case 'D':
      return '♦';
    case 'C':
      return '♣';
    default:
      return '';
  }
}

function isRedSuit(suit: string): boolean {
  return suit === 'H' || suit === 'D';
}

function formatCardKorean(card: string): string {
  if (card === 'JD') return '♦J (두눈박이·와일드)';
  if (card === 'JC') return '♣J (두눈박이·와일드)';
  if (card === 'JH') return '♥J (외눈박이·칩제거)';
  if (card === 'JS') return '♠J (외눈박이·칩제거)';
  const suit = card.slice(-1);
  const rank = card.slice(0, -1);
  return `${getSuitSymbol(suit)}${rank}`;
}

function formatCoord10(idx: number): string {
  const col = String.fromCharCode(65 + (idx % 10));
  const row = Math.floor(idx / 10) + 1;
  return `${col}${row}`;
}

/**
 * 특정 카드가 보드 위에서 사용 가능한지 확인 (데드 카드 판별용)
 */
function isCardPlayableOnBoard(
  card: string,
  boardTokens: ChipOwner[],
  myColor: 1 | 2,
  lockedSet: Set<number>
): boolean {
  if (isTwoEyedJack(card)) {
    return boardTokens.some((tok, idx) => !CORNER_INDICES.has(idx) && tok === 0);
  }
  if (isOneEyedJack(card)) {
    const opponent: 1 | 2 = myColor === 1 ? 2 : 1;
    return boardTokens.some(
      (tok, idx) => !CORNER_INDICES.has(idx) && tok === opponent && !lockedSet.has(idx)
    );
  }
  for (let i = 0; i < 100; i++) {
    if (SEQUENCE_BOARD_LAYOUT[i] === card && boardTokens[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * 선택된 카드(selectedCard)로 보드 위에서 착수/제거 가능한 유효 칸 인덱스 목록 반환
 */
function getValidBoardTargetsForCard(
  card: string | null,
  boardTokens: ChipOwner[],
  myColor: 1 | 2,
  lockedIndices: number[]
): number[] {
  if (!card) return [];
  const lockedSet = new Set(lockedIndices);
  const targets: number[] = [];

  if (isTwoEyedJack(card)) {
    for (let i = 0; i < 100; i++) {
      if (!CORNER_INDICES.has(i) && boardTokens[i] === 0) {
        targets.push(i);
      }
    }
    return targets;
  }

  if (isOneEyedJack(card)) {
    const opponent: 1 | 2 = myColor === 1 ? 2 : 1;
    for (let i = 0; i < 100; i++) {
      if (!CORNER_INDICES.has(i) && boardTokens[i] === opponent && !lockedSet.has(i)) {
        targets.push(i);
      }
    }
    return targets;
  }

  for (let i = 0; i < 100; i++) {
    if (SEQUENCE_BOARD_LAYOUT[i] === card && boardTokens[i] === 0) {
      targets.push(i);
    }
  }
  return targets;
}

/**
 * 10x10 보드에서 완성된 5목(시퀀스) 라인 탐지
 * 정통 규칙: 두 번째 시퀀스는 첫 번째 시퀀스와 최대 1칸까지만 교차 허용
 */
function evaluateSequences(
  boardTokens: ChipOwner[],
  color: 1 | 2
): { count: number; locked: number[] } {
  const dirs: readonly [number, number][] = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  const isOwnedOrFree = (r: number, c: number): boolean => {
    const idx = r * 10 + c;
    return CORNER_INDICES.has(idx) || boardTokens[idx] === color;
  };

  const candidates: SequenceLine[] = [];

  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      for (const [dr, dc] of dirs) {
        const endR = r + dr * 4;
        const endC = c + dc * 4;
        if (endR < 0 || endR >= 10 || endC < 0 || endC >= 10) continue;

        const line: number[] = [];
        let valid = true;
        for (let step = 0; step < 5; step++) {
          const nr = r + dr * step;
          const nc = c + dc * step;
          if (!isOwnedOrFree(nr, nc)) {
            valid = false;
            break;
          }
          line.push(nr * 10 + nc);
        }
        if (valid) {
          candidates.push({ indices: line, owner: color });
        }
      }
    }
  }

  if (candidates.length === 0) {
    return { count: 0, locked: [] };
  }

  // 첫 번째 라인 선택
  const chosen: SequenceLine[] = [candidates[0]];
  const firstSet = new Set(candidates[0].indices);

  // 첫 번째 라인과 1칸 이하로만 겹치는 두 번째 라인 탐색
  for (let i = 1; i < candidates.length; i++) {
    const overlap = candidates[i].indices.filter((idx) => firstSet.has(idx)).length;
    if (overlap <= 1) {
      chosen.push(candidates[i]);
      break;
    }
  }

  const lockedSet = new Set<number>();
  for (const seq of chosen) {
    for (const idx of seq.indices) {
      if (!CORNER_INDICES.has(idx)) {
        lockedSet.add(idx);
      }
    }
  }

  return {
    count: chosen.length,
    locked: Array.from(lockedSet),
  };
}

/**
 * 덱에서 카드 1장 보충 (덱 소진 시 버린 카드 셔플 재활용)
 */
function drawOneCard(
  deck: string[],
  discardPile: string[]
): { card: string | null; nextDeck: string[]; nextDiscard: string[] } {
  const d = [...deck];
  let disc = [...discardPile];
  if (d.length === 0 && disc.length > 0) {
    for (let i = disc.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [disc[i], disc[j]] = [disc[j], disc[i]];
    }
    d.push(...disc);
    disc = [];
  }
  const card = d.pop() ?? null;
  return { card, nextDeck: d, nextDiscard: disc };
}

function createDefaultSequenceRoom(roomId: number): NetSequenceRoomData {
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
    boardTokens: Array(100).fill(0),
    deck: [],
    discardPile: [],
    lockedIndices: [],
    blueSeqCount: 0,
    greenSeqCount: 0,
    currentTurn: 1,
    lastMoveIdx: null,
    lastActionType: null,
    turnDeadline: null,
    turnNotice: '',
    winnerAnnouncement: '',
    roundWinnerId: null,
    waitingSince: null,
  };
}

export default function Page13() {
  const [appMode, setAppMode] = useState<
    'HOME' | 'SOLO' | 'NET_LOBBY' | 'NET_ROOM' | 'HALL_OF_FAME'
  >('HOME');

  const [mySessionId] = useState<string>(() => {
    const saved = sessionStorage.getItem('sequence_net_uid');
    if (saved) return saved;
    const generated = `seq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('sequence_net_uid', generated);
    return generated;
  });

  // 넷게임 상태
  const [rooms, setRooms] = useState<NetSequenceRoomData[]>(
    [1, 2, 3, 4].map(createDefaultSequenceRoom)
  );
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [joinModalRoom, setJoinModalRoom] = useState<NetSequenceRoomData | null>(null);
  const [joinPlayerName, setJoinPlayerName] = useState<string>('');
  const [remainingSeconds, setRemainingSeconds] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [waitingCountdownSec, setWaitingCountdownSec] = useState<number>(420);
  const [netSelectedCardIdx, setNetSelectedCardIdx] = useState<number | null>(null);
  const timeoutHandledRef = useRef<number | null>(null);
  const lastSpokenNoticeRef = useRef<string>('');
  const lastCountdownSpokenRef = useRef<number | null>(null);

  // 단독게임(SOLO) 상태
  const [gameState, setGameState] = useState<
    'SETUP' | 'READY' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER'
  >('SETUP');
  const [soloPlayers, setSoloPlayers] = useState<SequencePlayer[]>([
    {
      id: '1',
      name: '블루킹',
      chipColor: 1,
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
      hand: [],
    },
    {
      id: '2',
      name: '그린퀸',
      chipColor: 2,
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
      hand: [],
    },
  ]);

  const [soloName1, setSoloName1] = useState('블루킹');
  const [soloName2, setSoloName2] = useState('그린퀸');
  const [soloAnteBet, setSoloAnteBet] = useState<number>(1000);
  const [soloTimeoutSec, setSoloTimeoutSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRemainingSec, setSoloRemainingSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRoundNum, setSoloRoundNum] = useState<number>(1);
  const [soloPot, setSoloPot] = useState<number>(0);

  const [soloBoardTokens, setSoloBoardTokens] = useState<ChipOwner[]>(Array(100).fill(0));
  const [soloDeck, setSoloDeck] = useState<string[]>([]);
  const [soloDiscard, setSoloDiscard] = useState<string[]>([]);
  const [soloLockedIndices, setSoloLockedIndices] = useState<number[]>([]);
  const [soloBlueSeq, setSoloBlueSeq] = useState<number>(0);
  const [soloGreenSeq, setSoloGreenSeq] = useState<number>(0);
  const [soloTurn, setSoloTurn] = useState<1 | 2>(1);
  const [soloSelectedCardIdx, setSoloSelectedCardIdx] = useState<number | null>(null);
  const [soloLastMoveIdx, setSoloLastMoveIdx] = useState<number | null>(null);
  const [, setSoloLastAction] = useState<'PLACE' | 'REMOVE' | null>(null);
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

  const playSound = (kind: 'place' | 'remove' | 'chip' | 'win' | 'tick') => {
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
        place: [320, 480],
        remove: [420, 260],
        chip: [880, 1174.66],
        win: [523.25, 659.25, 783.99, 1046.5, 1318.5],
        tick: [987.77],
      };

      notesMap[kind].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === 'place' ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.055);
        gain.gain.setValueAtTime(0.18, ctx.currentTime + idx * 0.055);
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
    const key = type === 'SOLO' ? 'sequence_hof_solo' : 'sequence_hof_net';
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
    const key = type === 'SOLO' ? 'sequence_hof_solo' : 'sequence_hof_net';
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
      const roomRef = ref(db, `sequence_rooms/room_${roomIdToLeave}`);
      try {
        await runTransaction(roomRef, (roomData) => {
          if (!roomData) return roomData;
          const room = roomData as NetSequenceRoomData;
          const filteredPlayers = (room.players || []).filter((p) => p.id !== mySessionId);
          const filteredWaitlist = (room.waitlist || []).filter((w) => w.id !== mySessionId);
          const filteredSpectators = (room.spectators || []).filter((s) => s.id !== mySessionId);

          if (filteredPlayers.length === 0 && filteredSpectators.length === 0) {
            return createDefaultSequenceRoom(room.roomId);
          }

          room.players = filteredPlayers.map((p, idx) => ({
            ...p,
            chipColor: idx === 0 ? 1 : 2,
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

    const presenceRef = ref(db, `sequence_presence/room_${selectedRoomId}/${mySessionId}`);
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
        const roomRef = ref(db, `sequence_rooms/room_${id}`);
        const snap = await get(roomRef);
        if (!snap.exists()) {
          await set(roomRef, createDefaultSequenceRoom(id));
        }
      }
    };
    ensureRoomsExist();

    const roomsRef = ref(db, 'sequence_rooms');
    const unsubscribe = onValue(roomsRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      const loadedRooms: NetSequenceRoomData[] = [1, 2, 3, 4].map((id) => {
        const rData = data[`room_${id}`];
        const def = createDefaultSequenceRoom(id);
        if (!rData) return def;

        const normalizedBoard: ChipOwner[] = Array.from({ length: 100 }, (_, i) => {
          const val = rData.boardTokens?.[i];
          return val === 1 || val === 2 ? val : 0;
        });

        return {
          ...def,
          ...rData,
          players: (rData.players || []).map((p: SequencePlayer, idx: number) => ({
            ...p,
            chipColor: p.chipColor === 2 ? 2 : idx === 0 ? 1 : 2,
            chips: typeof p.chips === 'number' ? p.chips : INITIAL_CHIPS,
            wins: typeof p.wins === 'number' ? p.wins : 0,
            currentBet: typeof p.currentBet === 'number' ? p.currentBet : 0,
            isEliminated: Boolean(p.isEliminated),
            hand: Array.isArray(p.hand) ? p.hand : [],
          })),
          pot: typeof rData.pot === 'number' ? rData.pot : 0,
          waitlist: rData.waitlist || [],
          spectators: rData.spectators || [],
          boardTokens: normalizedBoard,
          deck: Array.isArray(rData.deck) ? rData.deck : [],
          discardPile: Array.isArray(rData.discardPile) ? rData.discardPile : [],
          lockedIndices: Array.isArray(rData.lockedIndices) ? rData.lockedIndices : [],
          blueSeqCount: typeof rData.blueSeqCount === 'number' ? rData.blueSeqCount : 0,
          greenSeqCount: typeof rData.greenSeqCount === 'number' ? rData.greenSeqCount : 0,
          currentTurn: rData.currentTurn === 2 ? 2 : 1,
          lastMoveIdx: typeof rData.lastMoveIdx === 'number' ? rData.lastMoveIdx : null,
          lastActionType: rData.lastActionType || null,
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
          const roomRef = ref(db, `sequence_rooms/room_${activeNetRoom.roomId}`);
          await set(roomRef, createDefaultSequenceRoom(activeNetRoom.roomId));
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
          handleSoloAutoMove();
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [appMode, gameState, soloBoardTokens, soloTurn, soloPlayers, soloLockedIndices]);

  const handleEnterRoomSubmit = async (asSpectator = false) => {
    if (!joinModalRoom) return;
    const trimmedName = joinPlayerName ? joinPlayerName.trim() : '';
    if (!trimmedName) {
      alert('참가할 이름을 입력해주세요!');
      return;
    }

    const roomRef = ref(db, `sequence_rooms/room_${joinModalRoom.roomId}`);

    try {
      let joinResultType = 'PLAYER';

      await runTransaction(roomRef, (roomData) => {
        const room: NetSequenceRoomData =
          roomData || createDefaultSequenceRoom(joinModalRoom.roomId);
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
          const chipColor: 1 | 2 = room.players.length === 0 ? 1 : 2;
          const newPlayer: SequencePlayer = {
            id: mySessionId,
            name: trimmedName,
            chipColor,
            chips: INITIAL_CHIPS,
            wins: 0,
            currentBet: 0,
            isEliminated: false,
            hand: [],
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
    const roomRef = ref(db, `sequence_rooms/room_${activeNetRoom.roomId}`);
    await update(roomRef, {
      anteBet: newAnteBet,
      baseTimeout: clampedTimeout,
      waitingSince: Date.now(),
    });
  };

  /**
   * 넷게임 라운드 시작 (7장씩 배분 + 동일 판돈 베팅)
   */
  const handleStartNetRound = async (isNextRound = false) => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `sequence_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetSequenceRoomData;
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
            hand: [],
          }))
        : room.players.map((p) => ({
            ...p,
            isEliminated: p.isEliminated || p.chips <= 0,
            hand: [],
          }));

      const survivingPlayers = basePlayers.filter((p) => !p.isEliminated);
      const waitlist = [...room.waitlist];
      const nextActive: SequencePlayer[] = [...survivingPlayers];
      const remainingWaitlist: WaitlistPlayer[] = [];

      for (const w of waitlist) {
        if (nextActive.length < 2) {
          nextActive.push({
            id: w.id,
            name: w.name,
            chipColor: 2,
            chips: INITIAL_CHIPS,
            wins: 0,
            currentBet: 0,
            isEliminated: false,
            hand: [],
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

      const freshDeck = createShuffledDoubleDeck();
      const preparedPlayers: SequencePlayer[] = orderedActive.map((p, idx) => {
        collectedPot += equalStake;
        const dealtHand = freshDeck.splice(0, HAND_SIZE);
        return {
          ...p,
          chipColor: idx === 0 ? 1 : 2,
          chips: p.chips - equalStake,
          currentBet: equalStake,
          isEliminated: false,
          hand: dealtHand,
        };
      });

      room.status = 'PLAYING';
      room.roundNumber = nextRound;
      room.players = preparedPlayers;
      room.pot = collectedPot;
      room.waitlist = remainingWaitlist;
      room.boardTokens = Array(100).fill(0);
      room.deck = freshDeck;
      room.discardPile = [];
      room.lockedIndices = [];
      room.blueSeqCount = 0;
      room.greenSeqCount = 0;
      room.currentTurn = 1; // 블루 칩 선공
      room.lastMoveIdx = null;
      room.lastActionType = null;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.winnerAnnouncement = '';
      room.roundWinnerId = null;
      room.turnNotice = `🃏 [${nextRound}국] 카드 7장 배분 & 동일 판돈 ${equalStake.toLocaleString()}원 베팅! 🔵블루 ${preparedPlayers[0].name}님 선공!`;
      room.waitingSince = null;

      return room;
    });

    setNetSelectedCardIdx(0);
    triggerChipAnimation('전원', activeNetRoom.anteBet, '#1d4ed8');
  };

  /**
   * 넷게임 라운드 정산 (시퀀스 2줄 완성 또는 무승부)
   */
  const settleNetSequenceRound = (
    room: NetSequenceRoomData,
    winnerColor: 1 | 2 | 0,
    blueCount: number,
    greenCount: number
  ) => {
    const wonPot = room.pot || 0;

    if (winnerColor === 0) {
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
      room.winnerAnnouncement = `🤝 덱 소진 무승부! 판돈 ${wonPot.toLocaleString()}원을 반씩 반환합니다.`;
      return;
    }

    const winner =
      room.players.find((p) => p.chipColor === winnerColor) || room.players[winnerColor - 1];

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
      room.winnerAnnouncement = `👑 최종 우승! ${winner.name}님이 시퀀스 2줄(🔵${blueCount} : 🟢${greenCount})을 완성해 상대 판돈을 모두 획득했습니다!`;
    } else {
      room.status = 'ROUND_OVER';
      room.winnerAnnouncement = `🎊 ${winner.name}님 시퀀스 2줄 완성 승리! (🔵${blueCount} : 🟢${greenCount}) 판돈 ${wonPot.toLocaleString()}원 독식! (${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}원)`;
    }

    saveHallOfFameRecord('NET', {
      name: winner.name,
      scoreOrLevel: `${winnerObj.wins}승 · 보유 ${winnerObj.chips.toLocaleString()}원`,
    });
  };

  /**
   * 넷게임 데드 카드(보드에 더 이상 빈 자리가 없는 카드) 교체
   */
  const handleNetDiscardDeadCard = async (handIdx: number) => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const actor = activeNetRoom.players.find((p) => p.chipColor === activeNetRoom.currentTurn);
    if (!actor || actor.id !== mySessionId) return;

    const card = actor.hand[handIdx];
    if (!card) return;
    const lockedSet = new Set(activeNetRoom.lockedIndices);
    if (isCardPlayableOnBoard(card, activeNetRoom.boardTokens, actor.chipColor, lockedSet)) {
      showToast('아직 사용할 수 있는 칸이 있는 카드입니다!', 'danger');
      return;
    }

    const roomRef = ref(db, `sequence_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetSequenceRoomData;
      if (room.status !== 'PLAYING') return room;

      const pIdx = room.players.findIndex((p) => p.chipColor === room.currentTurn);
      if (pIdx === -1 || room.players[pIdx].id !== mySessionId) return room;

      const targetCard = room.players[pIdx].hand[handIdx];
      if (!targetCard) return room;

      const discardNext = [...(room.discardPile || []), targetCard];
      const drawn = drawOneCard(room.deck || [], discardNext);
      const nextHand = [...room.players[pIdx].hand];
      if (drawn.card) {
        nextHand.splice(handIdx, 1, drawn.card);
      } else {
        nextHand.splice(handIdx, 1);
      }

      room.players[pIdx].hand = nextHand;
      room.deck = drawn.nextDeck;
      room.discardPile = drawn.nextDiscard;
      room.turnNotice = `♻️ ${room.players[pIdx].name}님이 데드 카드(${formatCardKorean(targetCard)})를 새 카드로 교체했습니다!`;
      return room;
    });
  };

  /**
   * 넷게임 보드 칸 클릭 착수 처리
   */
  const handleNetCellClick = async (idx: number) => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const actor = activeNetRoom.players.find((p) => p.chipColor === activeNetRoom.currentTurn);
    if (!actor || actor.id !== mySessionId) return;

    if (netSelectedCardIdx === null || !actor.hand[netSelectedCardIdx]) {
      showToast('먼저 하단 패에서 사용할 카드를 선택하세요!', 'danger');
      return;
    }

    const selectedCard = actor.hand[netSelectedCardIdx];
    const validTargets = getValidBoardTargetsForCard(
      selectedCard,
      activeNetRoom.boardTokens,
      actor.chipColor,
      activeNetRoom.lockedIndices
    );

    if (!validTargets.includes(idx)) {
      showToast('선택한 카드로는 해당 위치에 놓을 수 없습니다!', 'danger');
      return;
    }

    const isRemoveAction = isOneEyedJack(selectedCard);
    playSound(isRemoveAction ? 'remove' : 'place');

    const roomRef = ref(db, `sequence_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetSequenceRoomData;
      if (room.status !== 'PLAYING') return room;

      const pIdx = room.players.findIndex((p) => p.chipColor === room.currentTurn);
      if (pIdx === -1 || room.players[pIdx].id !== mySessionId) return room;

      const currentActor = room.players[pIdx];
      const usedCard = currentActor.hand[netSelectedCardIdx];
      if (!usedCard) return room;

      const tokensCopy: ChipOwner[] = Array.from({ length: 100 }, (_, i) =>
        room.boardTokens?.[i] === 1 || room.boardTokens?.[i] === 2 ? room.boardTokens[i] : 0
      );

      const targets = getValidBoardTargetsForCard(
        usedCard,
        tokensCopy,
        currentActor.chipColor,
        room.lockedIndices || []
      );
      if (!targets.includes(idx)) return room;

      const removing = isOneEyedJack(usedCard);
      tokensCopy[idx] = removing ? 0 : currentActor.chipColor;

      // 카드 버리고 1장 드로우
      const discardNext = [...(room.discardPile || []), usedCard];
      const drawn = drawOneCard(room.deck || [], discardNext);
      const updatedHand = [...currentActor.hand];
      if (drawn.card) {
        updatedHand.splice(netSelectedCardIdx, 1, drawn.card);
      } else {
        updatedHand.splice(netSelectedCardIdx, 1);
      }
      room.players[pIdx].hand = updatedHand;
      room.deck = drawn.nextDeck;
      room.discardPile = drawn.nextDiscard;

      // 양 플레이어 시퀀스(5목) 줄 수 재계산
      const blueEval = evaluateSequences(tokensCopy, 1);
      const greenEval = evaluateSequences(tokensCopy, 2);
      const combinedLocked = Array.from(new Set([...blueEval.locked, ...greenEval.locked]));

      room.boardTokens = tokensCopy;
      room.lockedIndices = combinedLocked;
      room.blueSeqCount = blueEval.count;
      room.greenSeqCount = greenEval.count;
      room.lastMoveIdx = idx;
      room.lastActionType = removing ? 'REMOVE' : 'PLACE';

      // 승리 판정 (2줄 완성)
      if (blueEval.count >= TARGET_SEQUENCES) {
        settleNetSequenceRound(room, 1, blueEval.count, greenEval.count);
        return room;
      }
      if (greenEval.count >= TARGET_SEQUENCES) {
        settleNetSequenceRound(room, 2, blueEval.count, greenEval.count);
        return room;
      }

      // 양쪽 모두 손패가 비어 더 이상 진행 불가 시 무승부 처리
      if (room.players.every((pl) => pl.hand.length === 0)) {
        settleNetSequenceRound(room, 0, blueEval.count, greenEval.count);
        return room;
      }

      const nextColor: 1 | 2 = currentActor.chipColor === 1 ? 2 : 1;
      const nextPlayer = room.players.find((pl) => pl.chipColor === nextColor);
      const actionText = removing
        ? `외눈박이 J(${formatCardKorean(usedCard)})로 ${formatCoord10(idx)} 상대 칩 제거`
        : `${formatCardKorean(usedCard)} 카드로 ${formatCoord10(idx)}에 칩 착수`;

      room.currentTurn = nextColor;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `🃏 ${currentActor.name}님 ${actionText} 👉 ${nextPlayer?.name}님 차례!`;
      return room;
    });

    setNetSelectedCardIdx(0);
  };

  /**
   * 넷게임 시간 초과 자동 착수
   */
  const handleNetTurnTimeout = async (room: NetSequenceRoomData) => {
    const roomRef = ref(db, `sequence_rooms/room_${room.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const r = roomData as NetSequenceRoomData;
      if (r.status !== 'PLAYING') return r;

      const pIdx = r.players.findIndex((p) => p.chipColor === r.currentTurn);
      if (pIdx === -1) return r;
      const actor = r.players[pIdx];

      const tokensCopy: ChipOwner[] = Array.from({ length: 100 }, (_, i) =>
        r.boardTokens?.[i] === 1 || r.boardTokens?.[i] === 2 ? r.boardTokens[i] : 0
      );

      let chosenHandIdx = -1;
      let chosenBoardIdx = -1;

      for (let h = 0; h < actor.hand.length; h++) {
        const targets = getValidBoardTargetsForCard(
          actor.hand[h],
          tokensCopy,
          actor.chipColor,
          r.lockedIndices || []
        );
        if (targets.length > 0) {
          chosenHandIdx = h;
          chosenBoardIdx = targets[Math.floor(Math.random() * targets.length)];
          break;
        }
      }

      if (chosenHandIdx === -1 || chosenBoardIdx === -1) {
        settleNetSequenceRound(r, 0, r.blueSeqCount || 0, r.greenSeqCount || 0);
        return r;
      }

      const usedCard = actor.hand[chosenHandIdx];
      const removing = isOneEyedJack(usedCard);
      tokensCopy[chosenBoardIdx] = removing ? 0 : actor.chipColor;

      const discardNext = [...(r.discardPile || []), usedCard];
      const drawn = drawOneCard(r.deck || [], discardNext);
      const updatedHand = [...actor.hand];
      if (drawn.card) {
        updatedHand.splice(chosenHandIdx, 1, drawn.card);
      } else {
        updatedHand.splice(chosenHandIdx, 1);
      }
      r.players[pIdx].hand = updatedHand;
      r.deck = drawn.nextDeck;
      r.discardPile = drawn.nextDiscard;

      const blueEval = evaluateSequences(tokensCopy, 1);
      const greenEval = evaluateSequences(tokensCopy, 2);
      r.boardTokens = tokensCopy;
      r.lockedIndices = Array.from(new Set([...blueEval.locked, ...greenEval.locked]));
      r.blueSeqCount = blueEval.count;
      r.greenSeqCount = greenEval.count;
      r.lastMoveIdx = chosenBoardIdx;
      r.lastActionType = removing ? 'REMOVE' : 'PLACE';

      if (blueEval.count >= TARGET_SEQUENCES) {
        settleNetSequenceRound(r, 1, blueEval.count, greenEval.count);
        return r;
      }
      if (greenEval.count >= TARGET_SEQUENCES) {
        settleNetSequenceRound(r, 2, blueEval.count, greenEval.count);
        return r;
      }

      const nextColor: 1 | 2 = actor.chipColor === 1 ? 2 : 1;
      const nextPlayer = r.players.find((pl) => pl.chipColor === nextColor);
      r.currentTurn = nextColor;
      r.turnDeadline = Date.now() + r.baseTimeout * 1000;
      r.turnNotice = `⏰ 시간 초과로 ${actor.name}님이 ${formatCoord10(chosenBoardIdx)}에 자동 착수! 👉 ${nextPlayer?.name}님 차례!`;
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
    const p1Name = soloName1.trim() || '블루킹';
    const p2Name = soloName2.trim() || '그린퀸';
    setSoloPlayers([
      {
        id: '1',
        name: p1Name,
        chipColor: 1,
        chips: INITIAL_CHIPS,
        wins: 0,
        currentBet: 0,
        isEliminated: false,
        hand: [],
      },
      {
        id: '2',
        name: p2Name,
        chipColor: 2,
        chips: INITIAL_CHIPS,
        wins: 0,
        currentBet: 0,
        isEliminated: false,
        hand: [],
      },
    ]);
    setGameState('READY');
  };

  const swapSoloOrder = () => {
    setSoloPlayers((prev) => [
      { ...prev[1], chipColor: 1 },
      { ...prev[0], chipColor: 2 },
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
      hand: [],
    }));

    const orderedPlayers =
      isNextRound && !isFreshMatch
        ? [
            { ...basePlayers[1], chipColor: 1 as const },
            { ...basePlayers[0], chipColor: 2 as const },
          ]
        : [
            { ...basePlayers[0], chipColor: 1 as const },
            { ...basePlayers[1], chipColor: 2 as const },
          ];

    const equalStake = Math.min(soloAnteBet, ...orderedPlayers.map((p) => p.chips));
    let totalPot = isFreshMatch ? 0 : soloPot;
    const freshDeck = createShuffledDoubleDeck();

    const preparedPlayers = orderedPlayers.map((p) => {
      totalPot += equalStake;
      return {
        ...p,
        chips: p.chips - equalStake,
        currentBet: equalStake,
        hand: freshDeck.splice(0, HAND_SIZE),
      };
    });

    triggerChipAnimation('전원', equalStake, '#1d4ed8');
    const notice = `🃏 [${nextRound}국] 카드 7장 배분 & 동일 판돈 ${equalStake.toLocaleString()}원 베팅! 🔵블루 ${preparedPlayers[0].name}님 선공!`;

    setSoloRoundNum(nextRound);
    setSoloPot(totalPot);
    setSoloPlayers(preparedPlayers);
    setSoloBoardTokens(Array(100).fill(0));
    setSoloDeck(freshDeck);
    setSoloDiscard([]);
    setSoloLockedIndices([]);
    setSoloBlueSeq(0);
    setSoloGreenSeq(0);
    setSoloTurn(1);
    setSoloSelectedCardIdx(0);
    setSoloLastMoveIdx(null);
    setSoloLastAction(null);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setWinnerAnnouncement('');
    setShowFireworks(false);
    setTurnNotice(notice);
    speakKorean(notice);
    setGameState('PLAYING');
  };

  const settleSoloSequenceRound = (
    winnerColor: 1 | 2 | 0,
    blueCount: number,
    greenCount: number
  ) => {
    if (winnerColor === 0) {
      const halfPot = Math.floor(soloPot / 2);
      setSoloPlayers((prev) => prev.map((p) => ({ ...p, chips: p.chips + halfPot })));
      setSoloPot(0);
      setTurnNotice('');
      const msg = `🤝 덱 소진 무승부! 판돈 ${soloPot.toLocaleString()}원을 반씩 반환합니다.`;
      setWinnerAnnouncement(msg);
      setGameState('ROUND_OVER');
      speakKorean(msg);
      return;
    }

    const winner =
      soloPlayers.find((p) => p.chipColor === winnerColor) || soloPlayers[winnerColor - 1];

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
      ? `👑 최종 우승! ${winner.name}님이 시퀀스 2줄(🔵${blueCount} : 🟢${greenCount})을 완성해 상대 판돈을 모두 획득했습니다!`
      : `🎊 ${winner.name}님 시퀀스 2줄 완성 승리! (🔵${blueCount} : 🟢${greenCount}) 판돈 ${soloPot.toLocaleString()}원 독식! (${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}원)`;

    setSoloPlayers(settledPlayers);
    setSoloPot(0);
    setTurnNotice('');
    setWinnerAnnouncement(announcement);
    setGameState(anyBusted ? 'MATCH_OVER' : 'ROUND_OVER');
    triggerFireworksCelebration(announcement);

    saveHallOfFameRecord('SOLO', {
      name: winner.name,
      scoreOrLevel: `${winnerObj.wins}승 · 보유 ${winnerObj.chips.toLocaleString()}원`,
    });
  };

  const handleSoloDiscardDeadCard = (handIdx: number) => {
    if (gameState !== 'PLAYING') return;
    const actorIdx = soloPlayers.findIndex((p) => p.chipColor === soloTurn);
    if (actorIdx === -1) return;
    const actor = soloPlayers[actorIdx];
    const card = actor.hand[handIdx];
    if (!card) return;

    const lockedSet = new Set(soloLockedIndices);
    if (isCardPlayableOnBoard(card, soloBoardTokens, actor.chipColor, lockedSet)) {
      showToast('아직 사용할 수 있는 칸이 있는 카드입니다!', 'danger');
      return;
    }

    const drawn = drawOneCard(soloDeck, [...soloDiscard, card]);
    const nextHand = [...actor.hand];
    if (drawn.card) {
      nextHand.splice(handIdx, 1, drawn.card);
    } else {
      nextHand.splice(handIdx, 1);
    }

    const updatedPlayers = [...soloPlayers];
    updatedPlayers[actorIdx] = { ...actor, hand: nextHand };

    setSoloPlayers(updatedPlayers);
    setSoloDeck(drawn.nextDeck);
    setSoloDiscard(drawn.nextDiscard);
    const notice = `♻️ ${actor.name}님이 데드 카드(${formatCardKorean(card)})를 새 카드로 교체했습니다!`;
    setTurnNotice(notice);
    speakKorean(notice);
  };

  const executeSoloMove = (handIdx: number, boardIdx: number, isAuto = false) => {
    if (gameState !== 'PLAYING') return;
    const actorIdx = soloPlayers.findIndex((p) => p.chipColor === soloTurn);
    if (actorIdx === -1) return;
    const actor = soloPlayers[actorIdx];
    const usedCard = actor.hand[handIdx];
    if (!usedCard) return;

    const validTargets = getValidBoardTargetsForCard(
      usedCard,
      soloBoardTokens,
      actor.chipColor,
      soloLockedIndices
    );
    if (!validTargets.includes(boardIdx)) {
      if (!isAuto) showToast('선택한 카드로는 해당 위치에 놓을 수 없습니다!', 'danger');
      return;
    }

    const removing = isOneEyedJack(usedCard);
    playSound(removing ? 'remove' : 'place');

    const nextTokens = [...soloBoardTokens];
    nextTokens[boardIdx] = removing ? 0 : actor.chipColor;

    const drawn = drawOneCard(soloDeck, [...soloDiscard, usedCard]);
    const nextHand = [...actor.hand];
    if (drawn.card) {
      nextHand.splice(handIdx, 1, drawn.card);
    } else {
      nextHand.splice(handIdx, 1);
    }

    const updatedPlayers = [...soloPlayers];
    updatedPlayers[actorIdx] = { ...actor, hand: nextHand };

    const blueEval = evaluateSequences(nextTokens, 1);
    const greenEval = evaluateSequences(nextTokens, 2);
    const combinedLocked = Array.from(new Set([...blueEval.locked, ...greenEval.locked]));

    setSoloPlayers(updatedPlayers);
    setSoloBoardTokens(nextTokens);
    setSoloDeck(drawn.nextDeck);
    setSoloDiscard(drawn.nextDiscard);
    setSoloLockedIndices(combinedLocked);
    setSoloBlueSeq(blueEval.count);
    setSoloGreenSeq(greenEval.count);
    setSoloLastMoveIdx(boardIdx);
    setSoloLastAction(removing ? 'REMOVE' : 'PLACE');

    if (blueEval.count >= TARGET_SEQUENCES) {
      settleSoloSequenceRound(1, blueEval.count, greenEval.count);
      return;
    }
    if (greenEval.count >= TARGET_SEQUENCES) {
      settleSoloSequenceRound(2, blueEval.count, greenEval.count);
      return;
    }
    if (updatedPlayers.every((pl) => pl.hand.length === 0)) {
      settleSoloSequenceRound(0, blueEval.count, greenEval.count);
      return;
    }

    const nextColor: 1 | 2 = actor.chipColor === 1 ? 2 : 1;
    const nextPlayer = updatedPlayers.find((pl) => pl.chipColor === nextColor)!;
    const prefix = isAuto ? '⏰ 시간 초과 자동 착수! ' : '🃏 ';
    const actionDesc = removing
      ? `외눈박이 J로 ${formatCoord10(boardIdx)} 상대 칩 제거`
      : `${formatCardKorean(usedCard)} 카드로 ${formatCoord10(boardIdx)}에 칩 착수`;
    const notice = `${prefix}${actor.name}님 ${actionDesc} 👉 ${nextPlayer.name}님 차례!`;

    setSoloTurn(nextColor);
    setSoloSelectedCardIdx(0);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setTurnNotice(notice);
    speakKorean(notice);
  };

  const handleSoloAutoMove = () => {
    const actor = soloPlayers.find((p) => p.chipColor === soloTurn);
    if (!actor) return;
    for (let h = 0; h < actor.hand.length; h++) {
      const targets = getValidBoardTargetsForCard(
        actor.hand[h],
        soloBoardTokens,
        actor.chipColor,
        soloLockedIndices
      );
      if (targets.length > 0) {
        const randTarget = targets[Math.floor(Math.random() * targets.length)];
        executeSoloMove(h, randTarget, true);
        return;
      }
    }
    settleSoloSequenceRound(0, soloBlueSeq, soloGreenSeq);
  };

  // =========================================================================
  // 사진 디자인 재현: 10x10 정통 SEQUENCE 보드판 + 카드 손패 UI 헬퍼
  // =========================================================================
  const renderSequenceBoard = (
    boardTokens: ChipOwner[],
    lockedIndices: number[],
    validTargets: number[],
    lastMoveIdx: number | null,
    activeColor: 1 | 2,
    canInteract: boolean,
    onCellClick: (idx: number) => void
  ) => {
    const validSet = new Set(canInteract ? validTargets : []);
    const lockedSet = new Set(lockedIndices);

    return (
      <div className="seq-board-frame">
        {/* 상단 역방향 SEQUENCE 타이틀 배너 (사진 디테일 재현) */}
        <div className="seq-board-banner top-inverted">
          <span className="seq-banner-rule-tag">2 SEQUENCES TO WIN</span>
          <span className="seq-logo-text">SEQUENCE</span>
          <span className="seq-banner-rule-tag">FIVE IN A ROW</span>
        </div>

        {/* 10x10 정통 카드 격자 */}
        <div className="seq-grid-10x10">
          {SEQUENCE_BOARD_LAYOUT.map((cardCode, idx) => {
            const isCorner = CORNER_INDICES.has(idx);
            const token = boardTokens[idx];
            const isValid = validSet.has(idx);
            const isLocked = lockedSet.has(idx);
            const isLast = lastMoveIdx === idx;

            const suit = isCorner ? '' : cardCode.slice(-1);
            const rank = isCorner ? 'FREE' : cardCode.slice(0, -1);
            const red = !isCorner && isRedSuit(suit);

            return (
              <button
                key={idx}
                type="button"
                disabled={!isValid}
                onClick={() => onCellClick(idx)}
                className={`seq-card-cell ${isCorner ? 'corner-free-cell' : ''} ${
                  isValid ? 'valid-highlight' : ''
                } ${isLocked ? 'locked-seq-cell' : ''} ${isLast ? 'last-moved-cell' : ''}`}
                aria-label={`${formatCoord10(idx)} ${cardCode}`}
              >
                {isCorner ? (
                  <div className="free-corner-emblem">
                    <span className="corner-ring">★</span>
                    <span className="corner-text">FREE</span>
                  </div>
                ) : (
                  <div className={`mini-board-card ${red ? 'red-card' : 'black-card'}`}>
                    <div className="mini-card-corner top-left">
                      <span>{rank}</span>
                      <span>{getSuitSymbol(suit)}</span>
                    </div>
                    <div className="mini-card-center-pip">{getSuitSymbol(suit)}</div>
                    <div className="mini-card-corner bottom-right">
                      <span>{rank}</span>
                      <span>{getSuitSymbol(suit)}</span>
                    </div>
                  </div>
                )}

                {/* 착수 가능 가이드 하이라이트 */}
                {isValid && showValidHints && (
                  <span
                    className={`seq-target-ring ${
                      activeColor === 1 ? 'blue-ring' : 'green-ring'
                    }`}
                  />
                )}

                {/* 사진 속 원형 플라스틱 시퀀스 칩 (파랑 / 초록) */}
                {token !== 0 && (
                  <span
                    className={`seq-plastic-chip ${
                      token === 1 ? 'blue-chip' : 'green-chip'
                    } ${isLast ? 'chip-drop-anim' : ''} ${isLocked ? 'locked-chip' : ''}`}
                  >
                    <i className="chip-ridge-inner" />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* 하단 정방향 SEQUENCE 타이틀 배너 */}
        <div className="seq-board-banner bottom-normal">
          <span className="seq-banner-rule-tag">TWO-EYED J = WILD</span>
          <span className="seq-logo-text">SEQUENCE</span>
          <span className="seq-banner-rule-tag">ONE-EYED J = REMOVE</span>
        </div>
      </div>
    );
  };

  const renderPlayerHandDock = (
    hand: string[],
    selectedIdx: number | null,
    canInteract: boolean,
    boardTokens: ChipOwner[],
    myColor: 1 | 2,
    lockedIndices: number[],
    onSelectCard: (idx: number) => void,
    onDiscardDead: (idx: number) => void
  ) => {
    const lockedSet = new Set(lockedIndices);

    return (
      <div className="seq-hand-cards-row">
        {hand.map((card, idx) => {
          const suit = card.slice(-1);
          const rank = card.slice(0, -1);
          const red = isRedSuit(suit);
          const selected = selectedIdx === idx;
          const twoEyed = isTwoEyedJack(card);
          const oneEyed = isOneEyedJack(card);
          const playable = isCardPlayableOnBoard(card, boardTokens, myColor, lockedSet);

          return (
            <div key={`${card}_${idx}`} className="hand-card-slot">
              <button
                type="button"
                disabled={!canInteract}
                onClick={() => onSelectCard(idx)}
                className={`seq-hand-card ${red ? 'red-suit' : 'black-suit'} ${
                  selected ? 'selected-hand-card' : ''
                } ${!playable ? 'dead-hand-card' : ''}`}
              >
                <div className="hand-card-top">
                  <strong>{rank}</strong>
                  <span>{getSuitSymbol(suit)}</span>
                </div>
                <div className="hand-card-mid">
                  {twoEyed ? '👀J' : oneEyed ? '👁️J' : getSuitSymbol(suit)}
                </div>
                <div className="hand-card-tag">
                  {twoEyed ? '와일드' : oneEyed ? '제거' : !playable ? '데드' : ''}
                </div>
              </button>

              {canInteract && !playable && (
                <button
                  type="button"
                  className="dead-card-swap-btn"
                  onClick={() => onDiscardDead(idx)}
                  title="보드에 빈칸이 없는 데드 카드 무료 교체"
                >
                  ♻️교체
                </button>
              )}
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
              <strong>{chip.amount.toLocaleString()}원</strong>
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
          <div className="home-castle-icon">🔵🃏🟢</div>
          <h1 className="setup-title">시퀀스 보드게임 (SEQUENCE)</h1>
          <p className="home-subtitle">
            원목 테이블 10×10 카드 배열 · 5목 2줄 완성 승리 · 동일 판돈 승자 독식
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
              <span className="mode-desc">실시간 4개 원목 테이블 대전 &amp; 관전</span>
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
                      <span style={{ color: '#15803d', fontWeight: 800 }}>{rec.scoreOrLevel}</span>
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
              🌐 시퀀스 넷게임 (4개 대국실)
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
                    <span className="room-number-title">🃏 제 {room.roomId} 시퀀스실</span>
                    <span className={`room-status-pill ${statusClass}`}>{statusBadgeText}</span>
                  </div>

                  <div className="room-rules-info">
                    <span>💰 동일 판돈: {room.anteBet.toLocaleString()}원</span>
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
                                p.chipColor === 1 ? 'blue' : 'green'
                              }`}
                            />
                            {p.name} ({p.wins || 0}승 ·{' '}
                            {(p.chips ?? INITIAL_CHIPS).toLocaleString()}원)
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
              <h2 style={{ margin: '0 0 8px' }}>🃏 제 {joinModalRoom.roomId} 시퀀스실 입장</h2>
              <p className="modal-subtext">
                동일 판돈 <strong>{joinModalRoom.anteBet.toLocaleString()}원</strong>을 걸고 1:1
                시퀀스 대국이 진행됩니다.
              </p>

              <input
                type="text"
                className="player-input"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: '14px' }}
                placeholder="대국자 이름 입력 (예: 블루킹)"
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
              🃏 시퀀스 대기실 {amISpectator ? '👀 [관전모드]' : ''}
            </h1>

            <div className="setting-section">
              <label className="setting-label">
                💰 동일 판돈 설정 (초기 10,000원 · 전원 동일 베팅){' '}
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
                    {val.toLocaleString()}원
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
                      <span
                        className={`mini-disc-icon large ${
                          p.chipColor === 1 ? 'blue' : 'green'
                        }`}
                      />
                      {p.name} ({p.chipColor === 1 ? '🔵블루칩' : '🟢그린칩'}){' '}
                      {idx === 0 && '👑(방장)'} {p.id === mySessionId && '(나)'}
                    </span>
                    <span style={{ fontSize: '12px', color: '#15803d' }}>
                      🏆{p.wins || 0}승 · {(p.chips ?? INITIAL_CHIPS).toLocaleString()}원
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
              🚀 대국 시작! (전원 {activeNetRoom.anteBet.toLocaleString()}원 동일 베팅)
            </button>
          </div>
        </div>
      );
    }

    const activeTurnPlayer = roomPlayers.find((p) => p.chipColor === activeNetRoom.currentTurn);
    const myPlayerObj = roomPlayers.find((p) => p.id === mySessionId) || roomPlayers[0];
    const isMyTurn =
      activeNetRoom.status === 'PLAYING' &&
      activeTurnPlayer?.id === mySessionId &&
      !amISpectator;
    const isRoundEnded =
      activeNetRoom.status === 'ROUND_OVER' || activeNetRoom.status === 'MATCH_OVER';

    const mySelectedCard =
      myPlayerObj && netSelectedCardIdx !== null ? myPlayerObj.hand[netSelectedCardIdx] : null;
    const netValidTargets = isMyTurn
      ? getValidBoardTargetsForCard(
          mySelectedCard,
          activeNetRoom.boardTokens,
          myPlayerObj.chipColor,
          activeNetRoom.lockedIndices
        )
      : [];

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
                  activeNetRoom.status === 'PLAYING' && p.chipColor === activeNetRoom.currentTurn;
                const seqCount =
                  p.chipColor === 1 ? activeNetRoom.blueSeqCount : activeNetRoom.greenSeqCount;
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${isActive ? 'active-turn-spotlight' : ''}`}
                  >
                    <div className="player-badge-top">
                      <span
                        className={`mini-disc-icon ${p.chipColor === 1 ? 'blue' : 'green'}`}
                      />
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '>'}
                        {p.name}
                        {p.id === mySessionId ? '(나)' : ''}
                      </strong>
                      <span className="disc-score-pill">{seqCount}/2줄</span>
                      <span className="win-count-pill">🏆{p.wins || 0}승</span>
                      <span className="badge-score">💰{(p.chips ?? 0).toLocaleString()}원</span>
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
                      ? '🔄 새 매치 시작 (10,000원 초기화)'
                      : `🔥 다음 대국 시작 (선/후공 교대 · ${activeNetRoom.anteBet.toLocaleString()}원)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={activeNetRoom.turnNotice} className="oth-notice-banner">
                {activeNetRoom.turnNotice}
              </div>
            )}

            {/* 판돈 및 실시간 시퀀스 줄 수 스코어보드 */}
            <div className="oth-scoreboard-strip">
              <div className="score-side">
                <span className="mini-disc-icon large blue" />
                <span>블루 시퀀스</span>
                <strong>{activeNetRoom.blueSeqCount}/2</strong>
              </div>

              <div className="center-pot-box">
                <span className="pot-label">💰 누적 판돈</span>
                <strong className="pot-amount">
                  {(activeNetRoom.pot || 0).toLocaleString()} 원
                </strong>
              </div>

              <div className="score-side">
                <strong>{activeNetRoom.greenSeqCount}/2</strong>
                <span>그린 시퀀스</span>
                <span className="mini-disc-icon large green" />
              </div>
            </div>

            {/* 10x10 시퀀스 보드판 */}
            <div className="board-center-stage">
              {renderSequenceBoard(
                activeNetRoom.boardTokens,
                activeNetRoom.lockedIndices,
                netValidTargets,
                activeNetRoom.lastMoveIdx,
                activeNetRoom.currentTurn,
                isMyTurn,
                handleNetCellClick
              )}
            </div>
          </div>

          {/* 하단 카드 패 도크 */}
          <div className="oth-bottom-dock">
            <div className="dock-top-status" style={{ marginBottom: '6px' }}>
              {amISpectator ? (
                <span className="waiting-dock-msg">👀 관전 모드로 대국을 지켜보고 있습니다.</span>
              ) : isRoundEnded ? (
                <span className="waiting-dock-msg">
                  🏆 대국 종료! 상단의 <strong>[다음 대국 시작]</strong> 버튼을 눌러주세요!
                </span>
              ) : (
                <span className="turn-owner-pill large-turn-pill">
                  {activeNetRoom.currentTurn === 1 ? '🔵 블루칩' : '🟢 그린칩'}{' '}
                  {activeTurnPlayer?.name}님 차례
                  {isMyTurn
                    ? ' · 아래 카드를 고른 뒤 보드의 하이라이트 칸을 누르세요!'
                    : ' · 상대방 수 고민 중...'}
                </span>
              )}
            </div>

            {!amISpectator &&
              myPlayerObj &&
              renderPlayerHandDock(
                myPlayerObj.hand,
                netSelectedCardIdx,
                isMyTurn,
                activeNetRoom.boardTokens,
                myPlayerObj.chipColor,
                activeNetRoom.lockedIndices,
                (idx) => setNetSelectedCardIdx(idx),
                handleNetDiscardDeadCard
              )}
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // 5. 단독게임(SOLO) - 2인 로컬 시퀀스 연승 매치
  // =========================================================================
  const currentSoloPlayer =
    soloPlayers.find((p) => p.chipColor === soloTurn) || soloPlayers[0];
  const isSoloEnded = gameState === 'ROUND_OVER' || gameState === 'MATCH_OVER';
  const soloSelectedCard =
    soloSelectedCardIdx !== null ? currentSoloPlayer.hand[soloSelectedCardIdx] : null;
  const soloValidTargets =
    gameState === 'PLAYING'
      ? getValidBoardTargetsForCard(
          soloSelectedCard,
          soloBoardTokens,
          currentSoloPlayer.chipColor,
          soloLockedIndices
        )
      : [];

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
          <h1 className="setup-title">🃏 시퀀스 보드게임 (단독게임 설정)</h1>

          <div className="setting-section">
            <label className="setting-label">
              💰 매 대국 동일 판돈 설정 (초기 지급 10,000원)
            </label>
            <div className="piece-count-selector">
              {[1000, 2000, 3000, 5000].map((val) => (
                <button
                  key={val}
                  type="button"
                  className={`count-btn ${soloAnteBet === val ? 'active' : ''}`}
                  onClick={() => setSoloAnteBet(val)}
                >
                  {val.toLocaleString()}원
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
                  <span className="mini-disc-icon large blue" />
                  <span>선공 (블루 칩)</span>
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
                  <span className="mini-disc-icon large green" />
                  <span>후공 (그린 칩)</span>
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
            ➡️ 블루/그린 선공 확인하러 가기
          </button>
        </div>
      )}

      {gameState === 'READY' && (
        <div className="order-panel">
          <div className="order-header">
            <h2 style={{ margin: 0, fontSize: '20px', color: '#3e2723' }}>
              📋 블루/그린 칩 배정을 확인하세요
            </h2>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: '8px 14px', fontSize: '13px' }}
              onClick={swapSoloOrder}
            >
              🔄 선공 맞바꾸기
            </button>
          </div>

          <div className="order-list">
            {soloPlayers.map((player) => (
              <div key={player.id} className="order-item">
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span
                    className={`mini-disc-icon large ${
                      player.chipColor === 1 ? 'blue' : 'green'
                    }`}
                  />
                  <strong>
                    {player.chipColor === 1 ? '선공 (🔵 블루 칩)' : '후공 (🟢 그린 칩)'}
                  </strong>
                  <span>{player.name}</span>
                </span>
                <span style={{ fontSize: '13px', color: '#5d4037', fontWeight: 800 }}>
                  초기 {player.chips.toLocaleString()}원
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
              🚀 대국 시작! (전원 {soloAnteBet.toLocaleString()}원 동일 베팅)
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
                const isActive = !isSoloEnded && p.chipColor === soloTurn;
                const seqCount = p.chipColor === 1 ? soloBlueSeq : soloGreenSeq;
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${
                      isActive ? 'active-turn-spotlight' : 'active-turn-unlight'
                    }`}
                  >
                    <div className="player-badge-top">
                      <span
                        className={`mini-disc-icon ${p.chipColor === 1 ? 'blue' : 'green'}`}
                      />
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '>'}
                        {p.name}
                      </strong>
                      <span className="disc-score-pill">{seqCount}/2줄</span>
                      <span className="win-count-pill">🏆{p.wins}승</span>
                      <span className="badge-score">💰{p.chips.toLocaleString()}원</span>
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
                      ? '🔄 새 매치 시작 (10,000원 초기화)'
                      : `🔥 다음 대국 시작 (선/후공 교대 · ${soloAnteBet.toLocaleString()}원)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={turnNotice} className="oth-notice-banner">
                {turnNotice}
              </div>
            )}

            {/* 판돈 및 실시간 시퀀스 줄 수 카운터 */}
            <div className="oth-scoreboard-strip">
              <div className="score-side">
                <span className="mini-disc-icon large blue" />
                <span>블루 시퀀스</span>
                <strong>{soloBlueSeq}/2</strong>
              </div>

              <div className="center-pot-box">
                <span className="pot-label">💰 누적 판돈</span>
                <strong className="pot-amount">{soloPot.toLocaleString()} 원</strong>
              </div>

              <div className="score-side">
                <strong>{soloGreenSeq}/2</strong>
                <span>그린 시퀀스</span>
                <span className="mini-disc-icon large green" />
              </div>
            </div>

            {/* 10x10 시퀀스 보드판 */}
            <div className="board-center-stage">
              {renderSequenceBoard(
                soloBoardTokens,
                soloLockedIndices,
                soloValidTargets,
                soloLastMoveIdx,
                soloTurn,
                gameState === 'PLAYING',
                (boardIdx) => {
                  if (soloSelectedCardIdx === null) {
                    showToast('하단 카드 패에서 먼저 카드를 선택하세요!', 'danger');
                    return;
                  }
                  executeSoloMove(soloSelectedCardIdx, boardIdx, false);
                }
              )}
            </div>
          </div>

          {/* 하단 현재 차례 플레이어 카드 패 도크 */}
          <div className="oth-bottom-dock">
            <div className="dock-top-status" style={{ marginBottom: '6px' }}>
              {isSoloEnded ? (
                <span className="waiting-dock-msg">
                  🎉 대국 종료! <strong>[다음 대국 시작]</strong>을 눌러 선/후공을 교대해 계속
                  대국하세요!
                </span>
              ) : (
                <span className="turn-owner-pill large-turn-pill">
                  {soloTurn === 1 ? '🔵 블루칩' : '🟢 그린칩'} {currentSoloPlayer.name}님 카드패 ·
                  🏆{currentSoloPlayer.wins}승 · 💰{currentSoloPlayer.chips.toLocaleString()}원
                </span>
              )}
            </div>

            {!isSoloEnded &&
              renderPlayerHandDock(
                currentSoloPlayer.hand,
                soloSelectedCardIdx,
                gameState === 'PLAYING',
                soloBoardTokens,
                currentSoloPlayer.chipColor,
                soloLockedIndices,
                (idx) => setSoloSelectedCardIdx(idx),
                handleSoloDiscardDeadCard
              )}
          </div>
        </div>
      )}
    </div>
  );
}