import { useState, useRef, useEffect } from 'react';
import {
  ref,
  onValue,
  set,
  update,
  get,
  runTransaction,
} from 'firebase/database';
import { db } from './firebase';
import './Page5.css';

type UnoColor = 'RED' | 'YELLOW' | 'GREEN' | 'BLUE' | 'WILD';
type UnoCardType = 'NUMBER' | 'SKIP' | 'REVERSE' | 'DRAW2' | 'WILD' | 'WILD4';

interface UnoCard {
  id: string;
  color: UnoColor;
  type: UnoCardType;
  value?: number; // 0 ~ 9 (NUMBER 타입일 때)
}

interface UnoPlayer {
  id: string;
  name: string;
  badgeColor: string;
  hand: UnoCard[];
  chips: number;
  wins: number;
  currentBet: number;
  hasPlacedBet: boolean;
  calledUno: boolean;
  isEliminated: boolean; // 판돈을 다 쓰면 아웃
}

interface WaitlistPlayer {
  id: string;
  name: string;
}

interface SpectatorPlayer {
  id: string;
  name: string;
}

interface NetUnoRoomData {
  roomId: number;
  status: 'EMPTY' | 'WAITING' | 'BETTING' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER';
  players: UnoPlayer[];
  pot: number;
  waitlist: WaitlistPlayer[];
  spectators: SpectatorPlayer[];
  baseTimeout: number;
  minBet: number;
  roundNumber: number;
  deck: UnoCard[];
  discardPile: UnoCard[];
  activeColor: Exclude<UnoColor, 'WILD'>;
  direction: 1 | -1;
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
const INITIAL_CHIPS = 10000;
const DEFAULT_TIMEOUT_SEC = 120;
const INITIAL_HAND_SIZE = 7;

const COLOR_LABELS: Record<Exclude<UnoColor, 'WILD'>, string> = {
  RED: '빨강 🔴',
  YELLOW: '노랑 🟡',
  GREEN: '초록 🟢',
  BLUE: '파랑 🔵',
};

function getShortName(name: string): string {
  const trimmed = name ? name.trim() : '';
  return trimmed ? trimmed.slice(0, 2) : '?';
}

function createUnoDeck(): UnoCard[] {
  const colors: Array<Exclude<UnoColor, 'WILD'>> = ['RED', 'YELLOW', 'GREEN', 'BLUE'];
  const deck: UnoCard[] = [];

  for (const color of colors) {
    // 0은 색상별 1장
    deck.push({
      id: `uno-${color}-0-${Math.random().toString(36).slice(2, 6)}`,
      color,
      type: 'NUMBER',
      value: 0,
    });

    // 1~9는 색상별 2장씩
    for (let num = 1; num <= 9; num++) {
      for (let copy = 0; copy < 2; copy++) {
        deck.push({
          id: `uno-${color}-${num}-${copy}-${Math.random().toString(36).slice(2, 6)}`,
          color,
          type: 'NUMBER',
          value: num,
        });
      }
    }

    // 액션 카드(SKIP, REVERSE, DRAW2) 색상별 2장씩
    const actions: Array<Exclude<UnoCardType, 'NUMBER' | 'WILD' | 'WILD4'>> = [
      'SKIP',
      'REVERSE',
      'DRAW2',
    ];
    for (const act of actions) {
      for (let copy = 0; copy < 2; copy++) {
        deck.push({
          id: `uno-${color}-${act}-${copy}-${Math.random().toString(36).slice(2, 6)}`,
          color,
          type: act,
        });
      }
    }
  }

  // 와일드 / 와일드 드로우4 각각 4장씩
  for (let i = 0; i < 4; i++) {
    deck.push({
      id: `uno-WILD-${i}-${Math.random().toString(36).slice(2, 6)}`,
      color: 'WILD',
      type: 'WILD',
    });
    deck.push({
      id: `uno-WILD4-${i}-${Math.random().toString(36).slice(2, 6)}`,
      color: 'WILD',
      type: 'WILD4',
    });
  }

  return deck.sort(() => Math.random() - 0.5);
}

function drawCardsFromDeck(
  deck: UnoCard[],
  discardPile: UnoCard[],
  count: number
): { drawn: UnoCard[]; nextDeck: UnoCard[]; nextDiscard: UnoCard[] } {
  const dCopy = [...deck];
  let discCopy = [...discardPile];
  const drawn: UnoCard[] = [];

  for (let i = 0; i < count; i++) {
    if (dCopy.length === 0) {
      if (discCopy.length <= 1) break;
      const topCard = discCopy[discCopy.length - 1];
      const reshuffled = discCopy.slice(0, -1).sort(() => Math.random() - 0.5);
      dCopy.push(...reshuffled);
      discCopy = [topCard];
    }
    const card = dCopy.shift();
    if (card) drawn.push(card);
  }

  return { drawn, nextDeck: dCopy, nextDiscard: discCopy };
}

function canPlayUnoCard(
  card: UnoCard,
  topCard: UnoCard | undefined,
  activeColor: Exclude<UnoColor, 'WILD'>
): boolean {
  if (!topCard) return true;
  if (card.color === 'WILD') return true;
  if (card.color === activeColor) return true;
  if (card.type === 'NUMBER' && topCard.type === 'NUMBER' && card.value === topCard.value) {
    return true;
  }
  if (card.type !== 'NUMBER' && card.type === topCard.type) {
    return true;
  }
  return false;
}

function getNextAlivePlayerIdx(
  players: UnoPlayer[],
  currentIdx: number,
  direction: 1 | -1,
  steps = 1
): number {
  const total = players.length;
  if (total === 0) return 0;
  let idx = currentIdx;
  let moved = 0;
  let safety = 0;

  while (moved < steps && safety < total * 4) {
    idx = (idx + direction + total) % total;
    if (!players[idx].isEliminated) {
      moved += 1;
    }
    safety += 1;
  }
  return idx;
}

function getCardSymbolLabel(card: UnoCard): { top: string; center: string } {
  switch (card.type) {
    case 'NUMBER':
      return { top: String(card.value ?? 0), center: String(card.value ?? 0) };
    case 'SKIP':
      return { top: '🚫', center: 'SKIP' };
    case 'REVERSE':
      return { top: '🔄', center: 'REV' };
    case 'DRAW2':
      return { top: '+2', center: '+2' };
    case 'WILD':
      return { top: '🌈', center: 'WILD' };
    case 'WILD4':
      return { top: '+4', center: '+4' };
  }
}

function createDefaultUnoRoom(roomId: number): NetUnoRoomData {
  return {
    roomId,
    status: 'EMPTY',
    players: [],
    pot: 0,
    waitlist: [],
    spectators: [],
    baseTimeout: DEFAULT_TIMEOUT_SEC,
    minBet: 500,
    roundNumber: 1,
    deck: [],
    discardPile: [],
    activeColor: 'RED',
    direction: 1,
    currentPlayerIdx: 0,
    turnDeadline: null,
    turnNotice: '',
    winnerAnnouncement: '',
    roundWinnerId: null,
    waitingSince: null,
  };
}

export default function Page5() {
  const [appMode, setAppMode] = useState<'HOME' | 'SOLO' | 'NET_LOBBY' | 'NET_ROOM' | 'HALL_OF_FAME'>('HOME');

  const [mySessionId] = useState<string>(() => {
    const saved = sessionStorage.getItem('uno_net_uid');
    if (saved) return saved;
    const generated = `uno_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('uno_net_uid', generated);
    return generated;
  });

  // 넷게임 상태
  const [rooms, setRooms] = useState<NetUnoRoomData[]>([1, 2, 3, 4].map(createDefaultUnoRoom));
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [joinModalRoom, setJoinModalRoom] = useState<NetUnoRoomData | null>(null);
  const [joinPlayerName, setJoinPlayerName] = useState<string>('');
  const [remainingSeconds, setRemainingSeconds] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [waitingCountdownSec, setWaitingCountdownSec] = useState<number>(420);
  const timeoutHandledRef = useRef<number | null>(null);
  const lastSpokenNoticeRef = useRef<string>('');
  const lastCountdownSpokenRef = useRef<number | null>(null);

  // 와일드 카드 색상 선택 모달
  const [pendingWildCardId, setPendingWildCardId] = useState<string | null>(null);

  // 단독게임(SOLO) 상태
  const [gameState, setGameState] = useState<
    'SETUP' | 'READY' | 'BETTING' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER'
  >('SETUP');
  const [players, setPlayers] = useState<UnoPlayer[]>([
    {
      id: '1',
      name: '타짜',
      badgeColor: PIECE_COLORS[0],
      hand: [],
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      hasPlacedBet: false,
      calledUno: false,
      isEliminated: false,
    },
    {
      id: '2',
      name: '고니',
      badgeColor: PIECE_COLORS[1],
      hand: [],
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      hasPlacedBet: false,
      calledUno: false,
      isEliminated: false,
    },
  ]);

  const [inputName, setInputName] = useState('');
  const [minBetOption, setMinBetOption] = useState<number>(500);
  const [soloTimeoutSec, setSoloTimeoutSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRemainingSec, setSoloRemainingSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRoundNum, setSoloRoundNum] = useState<number>(1);
  const [soloPot, setSoloPot] = useState<number>(0);
  const [soloSelectedBet, setSoloSelectedBet] = useState<number>(500);
  const [netSelectedBet, setNetSelectedBet] = useState<number>(500);

  const [deck, setDeck] = useState<UnoCard[]>([]);
  const [discardPile, setDiscardPile] = useState<UnoCard[]>([]);
  const [activeColor, setActiveColor] = useState<Exclude<UnoColor, 'WILD'>>('RED');
  const [direction, setDirection] = useState<1 | -1>(1);
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

  const playSound = (kind: 'play' | 'draw' | 'chip' | 'uno' | 'win' | 'tick') => {
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
        play: [523.25, 659.25],
        draw: [392.0, 329.63],
        chip: [880, 1174.66],
        uno: [783.99, 1046.5, 1318.5],
        win: [523.25, 659.25, 783.99, 1046.5, 1318.5],
        tick: [987.77],
      };

      notesMap[kind].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === 'draw' ? 'sawtooth' : kind === 'chip' ? 'sine' : 'triangle';
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

  const saveHallOfFameRecord = (type: 'SOLO' | 'NET', record: { name: string; scoreOrLevel: string }) => {
    const key = type === 'SOLO' ? 'uno_hof_solo' : 'uno_hof_net';
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
    const key = type === 'SOLO' ? 'uno_hof_solo' : 'uno_hof_net';
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      return [];
    }
  };

  // =========================================================================
  // Firebase 실시간 넷게임 동기화
  // =========================================================================
  useEffect(() => {
    if (appMode !== 'NET_LOBBY' && appMode !== 'NET_ROOM') return;

    const ensureRoomsExist = async () => {
      for (const id of [1, 2, 3, 4]) {
        const roomRef = ref(db, `uno_rooms/room_${id}`);
        const snap = await get(roomRef);
        if (!snap.exists()) {
          await set(roomRef, createDefaultUnoRoom(id));
        }
      }
    };
    ensureRoomsExist();

    const roomsRef = ref(db, 'uno_rooms');
    const unsubscribe = onValue(roomsRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      const loadedRooms: NetUnoRoomData[] = [1, 2, 3, 4].map((id) => {
        const rData = data[`room_${id}`];
        const def = createDefaultUnoRoom(id);
        if (!rData) return def;
        return {
          ...def,
          ...rData,
          players: (rData.players || []).map((p: UnoPlayer) => ({
            ...p,
            hand: p.hand || [],
            chips: typeof p.chips === 'number' ? p.chips : INITIAL_CHIPS,
            wins: typeof p.wins === 'number' ? p.wins : 0,
            isEliminated: Boolean(p.isEliminated),
            calledUno: Boolean(p.calledUno),
          })),
          pot: typeof rData.pot === 'number' ? rData.pot : 0,
          waitlist: rData.waitlist || [],
          spectators: rData.spectators || [],
          deck: rData.deck || [],
          discardPile: rData.discardPile || [],
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

    if (
      activeNetRoom.turnNotice &&
      lastSpokenNoticeRef.current !== activeNetRoom.turnNotice
    ) {
      lastSpokenNoticeRef.current = activeNetRoom.turnNotice;
      speakKorean(activeNetRoom.turnNotice);
    }
  }, [appMode, activeNetRoom?.turnNotice, activeNetRoom?.status, activeNetRoom?.winnerAnnouncement]);

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
          const roomRef = ref(db, `uno_rooms/room_${activeNetRoom.roomId}`);
          await set(roomRef, createDefaultUnoRoom(activeNetRoom.roomId));
          showToast('⏳ 대기 시간이 7분을 초과하여 방이 초기화되었습니다.', 'info');
          setSelectedRoomId(null);
          setAppMode('NET_LOBBY');
          return;
        }
      }

      if (
        (activeNetRoom.status === 'PLAYING' || activeNetRoom.status === 'BETTING') &&
        activeNetRoom.turnDeadline
      ) {
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
    if (appMode !== 'SOLO' || (gameState !== 'BETTING' && gameState !== 'PLAYING')) {
      return;
    }

    const timer = window.setInterval(() => {
      setSoloRemainingSec((prev) => {
        const next = Math.max(0, prev - 1);
        handleCountdownCue(next);
        if (next === 0) {
          if (gameState === 'BETTING') {
            handleSoloPlaceBet(minBetOption);
          } else if (gameState === 'PLAYING') {
            handleSoloDrawCard();
          }
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [appMode, gameState, currentPlayerIdx, soloTimeoutSec]);

  const handleEnterRoomSubmit = async (asSpectator = false) => {
    if (!joinModalRoom) return;
    const trimmedName = joinPlayerName ? joinPlayerName.trim() : '';
    if (!trimmedName) {
      alert('참가할 이름을 입력해주세요!');
      return;
    }

    const roomRef = ref(db, `uno_rooms/room_${joinModalRoom.roomId}`);

    try {
      let joinResultType = 'PLAYER';

      await runTransaction(roomRef, (roomData) => {
        const room: NetUnoRoomData = roomData || createDefaultUnoRoom(joinModalRoom.roomId);
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
          const newPlayer: UnoPlayer = {
            id: mySessionId,
            name: trimmedName,
            badgeColor: PIECE_COLORS[idx],
            hand: [],
            chips: INITIAL_CHIPS,
            wins: 0,
            currentBet: 0,
            hasPlacedBet: false,
            calledUno: false,
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
        showToast('👀 관망모드로 입장했습니다! 패는 비공개로 보호됩니다.', 'info');
      } else if (joinResultType === 'WAITLIST') {
        showToast('⏳ 다음 판 예약자로 등록되었습니다!', 'info');
      }
    } catch (err) {
      console.error(err);
      alert('방 입장 중 오류가 발생했습니다.');
    }
  };

  const updateRoomSettings = async (newMinBet: number, newTimeout: number) => {
    if (!activeNetRoom) return;
    const clampedTimeout = Math.min(180, Math.max(30, newTimeout));
    const roomRef = ref(db, `uno_rooms/room_${activeNetRoom.roomId}`);
    await update(roomRef, {
      minBet: newMinBet,
      baseTimeout: clampedTimeout,
      waitingSince: Date.now(),
    });
  };

  /**
   * 넷게임 라운드 시작 (파산 아웃된 플레이어 제외 후 생존자 + 대기자 편성)
   */
  const handleStartNetBettingPhase = async (isNextRound = false) => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `uno_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetUnoRoomData;
      if (!room.players) room.players = [];
      if (!room.waitlist) room.waitlist = [];

      const isNewMatch = room.status === 'MATCH_OVER' || !isNextRound;
      const nextRound = isNewMatch ? 1 : (room.roundNumber || 1) + 1;

      const survivingPlayers = isNewMatch
        ? room.players.map((p) => ({ ...p, chips: INITIAL_CHIPS, wins: 0, isEliminated: false }))
        : room.players.filter((p) => !p.isEliminated && p.chips > 0);

      const waitlist = [...room.waitlist];
      let nextParticipants: UnoPlayer[] = [...survivingPlayers];
      let remainingWaitlist: WaitlistPlayer[] = [];

      for (const w of waitlist) {
        if (nextParticipants.length < 4) {
          nextParticipants.push({
            id: w.id,
            name: w.name,
            badgeColor: PIECE_COLORS[0],
            hand: [],
            chips: INITIAL_CHIPS,
            wins: 0,
            currentBet: 0,
            hasPlacedBet: false,
            calledUno: false,
            isEliminated: false,
          });
        } else {
          remainingWaitlist.push(w);
        }
      }

      if (nextParticipants.length < 2) {
        room.status = nextParticipants.length === 0 ? 'EMPTY' : 'WAITING';
        room.players = nextParticipants;
        room.waitlist = remainingWaitlist;
        return room;
      }

      const resetPlayers = nextParticipants.map((p, idx) => ({
        ...p,
        badgeColor: PIECE_COLORS[idx % PIECE_COLORS.length],
        hand: [],
        currentBet: 0,
        hasPlacedBet: false,
        calledUno: false,
        isEliminated: false,
      }));

      room.status = 'BETTING';
      room.roundNumber = nextRound;
      room.players = resetPlayers;
      room.pot = 0;
      room.waitlist = remainingWaitlist;
      room.deck = createUnoDeck();
      room.discardPile = [];
      room.activeColor = 'RED';
      room.direction = 1;
      room.currentPlayerIdx = 0;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.winnerAnnouncement = '';
      room.roundWinnerId = null;
      room.turnNotice = `💰 [${nextRound}라운드 우노] 판돈을 베팅하세요! 이기는 사람이 판돈 전액을 가져갑니다!`;
      room.waitingSince = null;

      return room;
    });

    setNetSelectedBet(activeNetRoom.minBet);
  };

  /**
   * 넷게임 베팅 확정 -> 전원 베팅 완료 시 각자 7장씩 배분 및 중앙 오픈 카드 세팅
   */
  const handleNetPlaceBet = async (betAmount: number) => {
    if (!activeNetRoom || activeNetRoom.status !== 'BETTING') return;
    const me = activeNetRoom.players.find((p) => p.id === mySessionId);
    if (!me || me.hasPlacedBet || me.isEliminated) return;

    const actualBet = Math.min(me.chips, Math.max(activeNetRoom.minBet, betAmount));
    triggerChipAnimation(me.name, actualBet, me.badgeColor);

    const roomRef = ref(db, `uno_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetUnoRoomData;
      if (room.status !== 'BETTING') return room;

      const pIdx = room.players.findIndex((p) => p.id === mySessionId);
      if (pIdx === -1 || room.players[pIdx].hasPlacedBet) return room;

      const actor = room.players[pIdx];
      const pay = Math.min(actor.chips, Math.max(room.minBet, betAmount));

      room.players[pIdx] = {
        ...actor,
        chips: actor.chips - pay,
        currentBet: pay,
        hasPlacedBet: true,
      };
      room.pot = (room.pot || 0) + pay;

      const allBetDone = room.players.every((p) => p.isEliminated || p.hasPlacedBet);
      if (!allBetDone) {
        room.turnNotice = `🪙 ${actor.name}님이 ${pay.toLocaleString()}칩을 베팅했습니다! (총 판돈: ${room.pot.toLocaleString()}칩)`;
        return room;
      }

      // 전원 베팅 완료 -> 우노 패 7장씩 배분
      const deckCopy = createUnoDeck();
      room.players = room.players.map((p) => {
        if (p.isEliminated) return p;
        const hand = deckCopy.splice(0, INITIAL_HAND_SIZE);
        return { ...p, hand, calledUno: false };
      });

      // 첫 오픈 카드는 일반 숫자 카드가 나오도록 뽑기
      let firstCardIdx = deckCopy.findIndex((c) => c.type === 'NUMBER');
      if (firstCardIdx === -1) firstCardIdx = 0;
      const [firstCard] = deckCopy.splice(firstCardIdx, 1);

      room.deck = deckCopy;
      room.discardPile = [firstCard];
      room.activeColor = firstCard.color === 'WILD' ? 'RED' : firstCard.color;
      room.direction = 1;
      room.status = 'PLAYING';
      room.currentPlayerIdx = 0;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `🃏 카드 배분 완료! 총 판돈 ${room.pot.toLocaleString()}칩! ${room.players[0].name}님부터 시작합니다.`;
      return room;
    });
  };

  /**
   * 넷게임 카드 내기 처리
   */
  const handleNetPlayCard = async (
    cardId: string,
    chosenWildColor?: Exclude<UnoColor, 'WILD'>
  ) => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const currIdx = activeNetRoom.currentPlayerIdx;
    const actor = activeNetRoom.players[currIdx];
    if (!actor || actor.id !== mySessionId) return;

    const card = actor.hand.find((c) => c.id === cardId);
    if (!card) return;

    if (card.color === 'WILD' && !chosenWildColor) {
      setPendingWildCardId(cardId);
      return;
    }

    setPendingWildCardId(null);
    playSound('play');

    const roomRef = ref(db, `uno_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetUnoRoomData;
      if (room.status !== 'PLAYING') return room;

      const idx = room.currentPlayerIdx;
      const p = room.players[idx];
      if (!p || p.id !== mySessionId) return room;

      const playedCard = p.hand.find((c) => c.id === cardId);
      const topCard = room.discardPile[room.discardPile.length - 1];
      if (!playedCard || !canPlayUnoCard(playedCard, topCard, room.activeColor)) {
        return room;
      }

      let nextHand = p.hand.filter((c) => c.id !== cardId);
      let nextDeck = [...(room.deck || [])];
      let nextDiscard = [...(room.discardPile || []), playedCard];
      const nextActiveColor: Exclude<UnoColor, 'WILD'> =
        playedCard.color === 'WILD' ? chosenWildColor || 'RED' : playedCard.color;

      // 1장 남았는데 UNO를 미리 누르지 않았으면 페널티 2장 드로우
      let penaltyText = '';
      if (nextHand.length === 1 && !p.calledUno) {
        const res = drawCardsFromDeck(nextDeck, nextDiscard, 2);
        nextHand = [...nextHand, ...res.drawn];
        nextDeck = res.nextDeck;
        nextDiscard = res.nextDiscard;
        penaltyText = ` (⚠️ UNO 미선언 벌칙 +2장!)`;
      }

      room.players[idx] = {
        ...p,
        hand: nextHand,
        calledUno: nextHand.length === 1 ? p.calledUno : false,
      };
      room.discardPile = nextDiscard;
      room.activeColor = nextActiveColor;

      // 손패 0장 -> 라운드 승리 및 판돈 독식!
      if (nextHand.length === 0) {
        const wonPot = room.pot || 0;
        room.players = room.players.map((pl, pIndex) => {
          const updatedChips = pIndex === idx ? pl.chips + wonPot : pl.chips;
          const eliminated = updatedChips <= 0;
          return {
            ...pl,
            chips: updatedChips,
            wins: pIndex === idx ? (pl.wins || 0) + 1 : pl.wins || 0,
            isEliminated: eliminated,
          };
        });

        const aliveCount = room.players.filter((pl) => !pl.isEliminated).length;
        const bustedNames = room.players.filter((pl) => pl.isEliminated).map((pl) => pl.name);
        const bustMsg =
          bustedNames.length > 0 ? ` · 💀 ${bustedNames.join(', ')}님 판돈 소진 아웃!` : '';

        room.pot = 0;
        room.deck = nextDeck;
        room.turnDeadline = null;
        room.turnNotice = '';
        room.roundWinnerId = p.id;

        if (aliveCount <= 1) {
          room.status = 'MATCH_OVER';
          room.winnerAnnouncement = `👑 최종 우승! ${p.name}님이 판돈 ${wonPot.toLocaleString()}칩을 독식하며 최후의 승자가 되었습니다!${bustMsg}`;
        } else {
          room.status = 'ROUND_OVER';
          room.winnerAnnouncement = `🎊 ${p.name}님 승리! 판돈 ${wonPot.toLocaleString()}칩 전액 획득! (누적 ${room.players[idx].chips.toLocaleString()}칩)${bustMsg}`;
        }

        saveHallOfFameRecord('NET', {
          name: p.name,
          scoreOrLevel: `${room.players[idx].wins}승 · 보유 ${room.players[idx].chips.toLocaleString()}칩`,
        });
        return room;
      }

      // 특수 효과 처리
      const alivePlayers = room.players.filter((pl) => !pl.isEliminated);
      let nextDirection = room.direction;
      let stepCount = 1;
      let effectNotice = '';

      if (playedCard.type === 'REVERSE') {
        if (alivePlayers.length === 2) {
          stepCount = 2; // 2인 플레이 시 리버스는 스킵 효과
          effectNotice = `🔄 리버스! ${p.name}님이 한 번 더 진행합니다!`;
        } else {
          nextDirection = (room.direction * -1) as 1 | -1;
          effectNotice = `🔄 진행 방향이 반대로 바뀌었습니다!`;
        }
      } else if (playedCard.type === 'SKIP') {
        stepCount = 2;
        const skippedIdx = getNextAlivePlayerIdx(room.players, idx, nextDirection, 1);
        effectNotice = `🚫 스킵! ${room.players[skippedIdx].name}님의 차례를 건너뜁니다!`;
      } else if (playedCard.type === 'DRAW2') {
        const victimIdx = getNextAlivePlayerIdx(room.players, idx, nextDirection, 1);
        const res = drawCardsFromDeck(nextDeck, nextDiscard, 2);
        room.players[victimIdx].hand = [...room.players[victimIdx].hand, ...res.drawn];
        room.players[victimIdx].calledUno = false;
        nextDeck = res.nextDeck;
        nextDiscard = res.nextDiscard;
        stepCount = 2;
        effectNotice = `💥 +2 공격! ${room.players[victimIdx].name}님이 2장을 먹고 차례가 넘어갑니다!`;
      } else if (playedCard.type === 'WILD4') {
        const victimIdx = getNextAlivePlayerIdx(room.players, idx, nextDirection, 1);
        const res = drawCardsFromDeck(nextDeck, nextDiscard, 4);
        room.players[victimIdx].hand = [...room.players[victimIdx].hand, ...res.drawn];
        room.players[victimIdx].calledUno = false;
        nextDeck = res.nextDeck;
        nextDiscard = res.nextDiscard;
        stepCount = 2;
        effectNotice = `🔥 와일드 +4! 색상 [${COLOR_LABELS[nextActiveColor]}] 지정 및 ${room.players[victimIdx].name}님 4장 추가!`;
      } else if (playedCard.type === 'WILD') {
        effectNotice = `🌈 와일드! 색상이 [${COLOR_LABELS[nextActiveColor]}]로 변경되었습니다!`;
      }

      const nextTurnIdx = getNextAlivePlayerIdx(room.players, idx, nextDirection, stepCount);
      const nextPlayer = room.players[nextTurnIdx];

      room.deck = nextDeck;
      room.discardPile = nextDiscard;
      room.direction = nextDirection;
      room.currentPlayerIdx = nextTurnIdx;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `${effectNotice || `🃏 ${p.name}님이 카드를 냈습니다.`}${penaltyText} 👉 ${nextPlayer.name}님 차례!`;

      return room;
    });
  };

  /**
   * 넷게임 카드 1장 뽑기(드로우) 후 턴 넘기기
   */
  const handleNetDrawCard = async () => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const currIdx = activeNetRoom.currentPlayerIdx;
    const actor = activeNetRoom.players[currIdx];
    if (!actor || actor.id !== mySessionId) return;

    playSound('draw');
    const roomRef = ref(db, `uno_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetUnoRoomData;
      if (room.status !== 'PLAYING') return room;

      const idx = room.currentPlayerIdx;
      const p = room.players[idx];
      if (!p || p.id !== mySessionId) return room;

      const res = drawCardsFromDeck(room.deck || [], room.discardPile || [], 1);
      room.players[idx] = {
        ...p,
        hand: [...p.hand, ...res.drawn],
        calledUno: false,
      };
      room.deck = res.nextDeck;
      room.discardPile = res.nextDiscard;

      const nextIdx = getNextAlivePlayerIdx(room.players, idx, room.direction, 1);
      room.currentPlayerIdx = nextIdx;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `📥 ${p.name}님이 덱에서 1장을 뽑았습니다. 👉 ${room.players[nextIdx].name}님 차례!`;
      return room;
    });
  };

  const handleNetCallUno = async () => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const myIdx = activeNetRoom.players.findIndex((p) => p.id === mySessionId);
    if (myIdx === -1) return;

    playSound('uno');
    const roomRef = ref(db, `uno_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetUnoRoomData;
      if (!room.players[myIdx]) return room;
      room.players[myIdx].calledUno = true;
      room.turnNotice = `📣 "${room.players[myIdx].name}님: 우노(UNO)!!" 선언!`;
      return room;
    });
  };

  const handleNetTurnTimeout = async (room: NetUnoRoomData) => {
    const roomRef = ref(db, `uno_rooms/room_${room.roomId}`);
    if (room.status === 'BETTING') {
      await runTransaction(roomRef, (roomData) => {
        if (!roomData) return roomData;
        const r = roomData as NetUnoRoomData;
        if (r.status !== 'BETTING') return r;
        let added = 0;
        r.players = r.players.map((p) => {
          if (p.isEliminated || p.hasPlacedBet) return p;
          const pay = Math.min(p.chips, r.minBet);
          added += pay;
          return { ...p, chips: p.chips - pay, currentBet: pay, hasPlacedBet: true };
        });
        r.pot = (r.pot || 0) + added;

        const deckCopy = createUnoDeck();
        r.players = r.players.map((p) =>
          p.isEliminated ? p : { ...p, hand: deckCopy.splice(0, INITIAL_HAND_SIZE), calledUno: false }
        );
        let firstIdx = deckCopy.findIndex((c) => c.type === 'NUMBER');
        if (firstIdx === -1) firstIdx = 0;
        const [firstCard] = deckCopy.splice(firstIdx, 1);

        r.deck = deckCopy;
        r.discardPile = [firstCard];
        r.activeColor = firstCard.color === 'WILD' ? 'RED' : firstCard.color;
        r.status = 'PLAYING';
        r.currentPlayerIdx = 0;
        r.turnDeadline = Date.now() + r.baseTimeout * 1000;
        r.turnNotice = `⏰ 시간 초과로 기본 판돈 베팅 후 게임이 시작되었습니다!`;
        return r;
      });
      return;
    }

    if (room.status === 'PLAYING') {
      await runTransaction(roomRef, (roomData) => {
        if (!roomData) return roomData;
        const r = roomData as NetUnoRoomData;
        if (r.status !== 'PLAYING') return r;
        const idx = r.currentPlayerIdx;
        const res = drawCardsFromDeck(r.deck || [], r.discardPile || [], 1);
        r.players[idx].hand = [...r.players[idx].hand, ...res.drawn];
        r.deck = res.nextDeck;
        r.discardPile = res.nextDiscard;
        const nextIdx = getNextAlivePlayerIdx(r.players, idx, r.direction, 1);
        r.currentPlayerIdx = nextIdx;
        r.turnDeadline = Date.now() + r.baseTimeout * 1000;
        r.turnNotice = `⏰ 시간 초과로 ${r.players[idx].name}님이 1장 드로우 후 턴이 넘어갑니다.`;
        return r;
      });
    }
  };

  const handleLeaveNetRoom = async () => {
    if (!activeNetRoom) {
      setAppMode('NET_LOBBY');
      return;
    }

    const roomRef = ref(db, `uno_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetUnoRoomData;
      const filteredPlayers = (room.players || []).filter((p) => p.id !== mySessionId);
      const filteredWaitlist = (room.waitlist || []).filter((w) => w.id !== mySessionId);
      const filteredSpectators = (room.spectators || []).filter((s) => s.id !== mySessionId);

      if (filteredPlayers.length === 0 && filteredSpectators.length === 0) {
        return createDefaultUnoRoom(room.roomId);
      }
      room.players = filteredPlayers;
      room.waitlist = filteredWaitlist;
      room.spectators = filteredSpectators;
      return room;
    });

    setSelectedRoomId(null);
    setAppMode('NET_LOBBY');
  };

  // =========================================================================
  // 단독게임(SOLO) 로직 (로컬 다인용 / 패스 앤 플레이 + 누적 판돈 독식 + 파산 아웃)
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
        hasPlacedBet: false,
        calledUno: false,
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
      showToast('우노 대전은 최소 2명 이상의 플레이어가 필요합니다!', 'info');
      return;
    }
    setGameState('READY');
  };

  const startSoloRound = (isNextRound = false) => {
    const isFreshMatch = !isNextRound || gameState === 'MATCH_OVER';
    const nextRound = isFreshMatch ? 1 : soloRoundNum + 1;

    const preparedPlayers = players.map((p, idx) => {
      const chips = isFreshMatch ? INITIAL_CHIPS : p.chips;
      const eliminated = !isFreshMatch && chips <= 0;
      return {
        ...p,
        badgeColor: PIECE_COLORS[idx % PIECE_COLORS.length],
        hand: [],
        chips,
        wins: isFreshMatch ? 0 : p.wins,
        currentBet: 0,
        hasPlacedBet: false,
        calledUno: false,
        isEliminated: eliminated,
      };
    });

    const firstAliveIdx = preparedPlayers.findIndex((p) => !p.isEliminated);
    if (firstAliveIdx === -1) return;

    const notice = `💰 [${nextRound}라운드 우노] ${preparedPlayers[firstAliveIdx].name}님, 판돈을 베팅해 주세요! (승자 독식)`;
    setSoloRoundNum(nextRound);
    setSoloPot(0);
    setPlayers(preparedPlayers);
    setDiscardPile([]);
    setCurrentPlayerIdx(firstAliveIdx);
    setSoloSelectedBet(minBetOption);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setWinnerAnnouncement('');
    setShowFireworks(false);
    setPendingWildCardId(null);
    setTurnNotice(notice);
    speakKorean(notice);
    setGameState('BETTING');
  };

  const handleSoloPlaceBet = (amount: number) => {
    if (gameState !== 'BETTING') return;
    const actor = players[currentPlayerIdx];
    const pay = Math.min(actor.chips, Math.max(minBetOption, amount));

    triggerChipAnimation(actor.name, pay, actor.badgeColor);
    const nextPot = soloPot + pay;
    setSoloPot(nextPot);

    const updated = players.map((p, idx) =>
      idx === currentPlayerIdx
        ? { ...p, chips: p.chips - pay, currentBet: pay, hasPlacedBet: true }
        : p
    );

    const nextBetIdx = updated.findIndex(
      (p, idx) => idx > currentPlayerIdx && !p.isEliminated && !p.hasPlacedBet
    );

    if (nextBetIdx !== -1) {
      const nextNotice = `💰 ${updated[nextBetIdx].name}님 차례입니다! 판돈을 베팅하세요. (현재 판돈: ${nextPot.toLocaleString()}칩)`;
      setPlayers(updated);
      setCurrentPlayerIdx(nextBetIdx);
      setSoloSelectedBet(minBetOption);
      setSoloRemainingSec(soloTimeoutSec);
      lastCountdownSpokenRef.current = null;
      setTurnNotice(nextNotice);
      speakKorean(nextNotice);
      return;
    }

    // 전원 베팅 완료 -> 각자 7장 배분 및 오픈 카드 공개
    const deckCopy = createUnoDeck();
    const dealtPlayers = updated.map((p) =>
      p.isEliminated ? p : { ...p, hand: deckCopy.splice(0, INITIAL_HAND_SIZE), calledUno: false }
    );

    let firstCardIdx = deckCopy.findIndex((c) => c.type === 'NUMBER');
    if (firstCardIdx === -1) firstCardIdx = 0;
    const [firstCard] = deckCopy.splice(firstCardIdx, 1);

    const startIdx = dealtPlayers.findIndex((p) => !p.isEliminated);
    const startNotice = `🃏 카드 배분 완료! 총 판돈 ${nextPot.toLocaleString()}칩! ${dealtPlayers[startIdx].name}님부터 시작합니다!`;

    setDeck(deckCopy);
    setDiscardPile([firstCard]);
    setActiveColor(firstCard.color === 'WILD' ? 'RED' : firstCard.color);
    setDirection(1);
    setPlayers(dealtPlayers);
    setCurrentPlayerIdx(startIdx);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setTurnNotice(startNotice);
    speakKorean(startNotice);
    setGameState('PLAYING');
  };

  const handleSoloPlayCard = (
    cardId: string,
    chosenWildColor?: Exclude<UnoColor, 'WILD'>
  ) => {
    if (gameState !== 'PLAYING') return;
    const actor = players[currentPlayerIdx];
    const playedCard = actor.hand.find((c) => c.id === cardId);
    const topCard = discardPile[discardPile.length - 1];

    if (!playedCard || !canPlayUnoCard(playedCard, topCard, activeColor)) {
      showToast('낼 수 없는 카드입니다! 같은 색상이나 숫자/기호 카드를 내세요.', 'danger');
      return;
    }

    if (playedCard.color === 'WILD' && !chosenWildColor) {
      setPendingWildCardId(cardId);
      return;
    }

    setPendingWildCardId(null);
    playSound('play');

    let nextHand = actor.hand.filter((c) => c.id !== cardId);
    let nextDeck = [...deck];
    let nextDiscard = [...discardPile, playedCard];
    const nextActiveColor: Exclude<UnoColor, 'WILD'> =
      playedCard.color === 'WILD' ? chosenWildColor || 'RED' : playedCard.color;

    let penaltyText = '';
    if (nextHand.length === 1 && !actor.calledUno) {
      const res = drawCardsFromDeck(nextDeck, nextDiscard, 2);
      nextHand = [...nextHand, ...res.drawn];
      nextDeck = res.nextDeck;
      nextDiscard = res.nextDiscard;
      penaltyText = ' (⚠️ UNO 미선언 벌칙 +2장!)';
    }

    const updatedPlayers = players.map((p, idx) =>
      idx === currentPlayerIdx
        ? { ...p, hand: nextHand, calledUno: nextHand.length === 1 ? p.calledUno : false }
        : p
    );

    // 1등 승리 -> 판돈 전액 독식 + 칩 0원 파산자 아웃 처리
    if (nextHand.length === 0) {
      const settledPlayers = updatedPlayers.map((p, idx) => {
        const finalChips = idx === currentPlayerIdx ? p.chips + soloPot : p.chips;
        const eliminated = finalChips <= 0;
        return {
          ...p,
          chips: finalChips,
          wins: idx === currentPlayerIdx ? p.wins + 1 : p.wins,
          isEliminated: eliminated,
        };
      });

      const aliveCount = settledPlayers.filter((p) => !p.isEliminated).length;
      const bustedNames = settledPlayers.filter((p) => p.isEliminated).map((p) => p.name);
      const bustMsg =
        bustedNames.length > 0 ? ` · 💀 ${bustedNames.join(', ')}님 판돈 소진 아웃!` : '';

      const announcement =
        aliveCount <= 1
          ? `👑 최종 우승! ${actor.name}님이 판돈 ${soloPot.toLocaleString()}칩을 독식하며 최후의 승자가 되었습니다!${bustMsg}`
          : `🎊 ${actor.name}님 승리! 판돈 ${soloPot.toLocaleString()}칩 전액 독식! (누적 ${settledPlayers[currentPlayerIdx].chips.toLocaleString()}칩)${bustMsg}`;

      setPlayers(settledPlayers);
      setDiscardPile(nextDiscard);
      setActiveColor(nextActiveColor);
      setDeck(nextDeck);
      setSoloPot(0);
      setTurnNotice('');
      setWinnerAnnouncement(announcement);
      setGameState(aliveCount <= 1 ? 'MATCH_OVER' : 'ROUND_OVER');
      triggerFireworksCelebration(announcement);

      saveHallOfFameRecord('SOLO', {
        name: actor.name,
        scoreOrLevel: `${settledPlayers[currentPlayerIdx].wins}승 · 보유 ${settledPlayers[currentPlayerIdx].chips.toLocaleString()}칩`,
      });
      return;
    }

    const alivePlayers = updatedPlayers.filter((p) => !p.isEliminated);
    let nextDirection = direction;
    let stepCount = 1;
    let effectNotice = '';

    if (playedCard.type === 'REVERSE') {
      if (alivePlayers.length === 2) {
        stepCount = 2;
        effectNotice = `🔄 리버스! ${actor.name}님이 한 번 더 진행합니다!`;
      } else {
        nextDirection = (direction * -1) as 1 | -1;
        effectNotice = `🔄 진행 방향이 반대로 바뀌었습니다!`;
      }
    } else if (playedCard.type === 'SKIP') {
      stepCount = 2;
      const skippedIdx = getNextAlivePlayerIdx(updatedPlayers, currentPlayerIdx, nextDirection, 1);
      effectNotice = `🚫 스킵! ${updatedPlayers[skippedIdx].name}님의 차례를 건너뜁니다!`;
    } else if (playedCard.type === 'DRAW2') {
      const victimIdx = getNextAlivePlayerIdx(updatedPlayers, currentPlayerIdx, nextDirection, 1);
      const res = drawCardsFromDeck(nextDeck, nextDiscard, 2);
      updatedPlayers[victimIdx] = {
        ...updatedPlayers[victimIdx],
        hand: [...updatedPlayers[victimIdx].hand, ...res.drawn],
        calledUno: false,
      };
      nextDeck = res.nextDeck;
      nextDiscard = res.nextDiscard;
      stepCount = 2;
      effectNotice = `💥 +2 공격! ${updatedPlayers[victimIdx].name}님이 2장을 먹고 차례가 넘어갑니다!`;
    } else if (playedCard.type === 'WILD4') {
      const victimIdx = getNextAlivePlayerIdx(updatedPlayers, currentPlayerIdx, nextDirection, 1);
      const res = drawCardsFromDeck(nextDeck, nextDiscard, 4);
      updatedPlayers[victimIdx] = {
        ...updatedPlayers[victimIdx],
        hand: [...updatedPlayers[victimIdx].hand, ...res.drawn],
        calledUno: false,
      };
      nextDeck = res.nextDeck;
      nextDiscard = res.nextDiscard;
      stepCount = 2;
      effectNotice = `🔥 와일드 +4! 색상 [${COLOR_LABELS[nextActiveColor]}] 지정 및 ${updatedPlayers[victimIdx].name}님 4장 추가!`;
    } else if (playedCard.type === 'WILD') {
      effectNotice = `🌈 와일드! 색상이 [${COLOR_LABELS[nextActiveColor]}]로 변경되었습니다!`;
    }

    const nextIdx = getNextAlivePlayerIdx(
      updatedPlayers,
      currentPlayerIdx,
      nextDirection,
      stepCount
    );
    const notice = `${effectNotice || `🃏 ${actor.name}님이 카드를 냈습니다.`}${penaltyText} 👉 ${updatedPlayers[nextIdx].name}님 차례!`;

    setPlayers(updatedPlayers);
    setDeck(nextDeck);
    setDiscardPile(nextDiscard);
    setActiveColor(nextActiveColor);
    setDirection(nextDirection);
    setCurrentPlayerIdx(nextIdx);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setTurnNotice(notice);
    speakKorean(notice);
  };

  const handleSoloDrawCard = () => {
    if (gameState !== 'PLAYING') return;
    const actor = players[currentPlayerIdx];
    playSound('draw');

    const res = drawCardsFromDeck(deck, discardPile, 1);
    const updated = players.map((p, idx) =>
      idx === currentPlayerIdx
        ? { ...p, hand: [...p.hand, ...res.drawn], calledUno: false }
        : p
    );

    const nextIdx = getNextAlivePlayerIdx(updated, currentPlayerIdx, direction, 1);
    const notice = `📥 ${actor.name}님이 덱에서 1장을 뽑았습니다. 👉 ${updated[nextIdx].name}님 차례!`;

    setPlayers(updated);
    setDeck(res.nextDeck);
    setDiscardPile(res.nextDiscard);
    setCurrentPlayerIdx(nextIdx);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setTurnNotice(notice);
    speakKorean(notice);
  };

  const handleSoloCallUno = () => {
    if (gameState !== 'PLAYING') return;
    const actor = players[currentPlayerIdx];
    playSound('uno');
    const updated = players.map((p, idx) =>
      idx === currentPlayerIdx ? { ...p, calledUno: true } : p
    );
    const notice = `📣 "${actor.name}님: 우노(UNO)!!" 선언!`;
    setPlayers(updated);
    setTurnNotice(notice);
    speakKorean(notice);
  };

  // =========================================================================
  // 공용 UI 렌더링 헬퍼
  // =========================================================================
  const renderUnoCard = (
    card: UnoCard,
    revealFace: boolean,
    options?: {
      playable?: boolean;
      mini?: boolean;
      onClick?: () => void;
    }
  ) => {
    const { playable = false, mini = false, onClick } = options || {};
    if (!revealFace) {
      return (
        <div key={card.id} className={`uno-card face-down ${mini ? 'mini' : ''}`}>
          <span className="uno-card-back-logo">UNO</span>
        </div>
      );
    }

    const { top, center } = getCardSymbolLabel(card);
    const colorClass = card.color.toLowerCase();

    return (
      <button
        key={card.id}
        type="button"
        disabled={!playable && !onClick}
        onClick={onClick}
        className={`uno-card face-up ${colorClass} ${playable ? 'playable' : ''} ${
          mini ? 'mini' : ''
        }`}
      >
        <span className="uno-card-corner top">{top}</span>
        <span className="uno-card-oval">
          <span className="uno-card-center">{center}</span>
        </span>
        <span className="uno-card-corner bottom">{top}</span>
      </button>
    );
  };

  const renderWildColorModal = (onSelectColor: (c: Exclude<UnoColor, 'WILD'>) => void) => {
    if (!pendingWildCardId) return null;
    const colors: Array<Exclude<UnoColor, 'WILD'>> = ['RED', 'YELLOW', 'GREEN', 'BLUE'];
    return (
      <div className="modal-overlay" onClick={() => setPendingWildCardId(null)}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
          <h2 style={{ margin: '0 0 8px' }}>🌈 변경할 색상을 선택하세요!</h2>
          <p className="modal-subtext">와일드 카드를 냈습니다. 다음 색상을 지정해 주세요.</p>
          <div className="wild-color-grid">
            {colors.map((c) => (
              <button
                key={c}
                type="button"
                className={`wild-color-btn ${c.toLowerCase()}`}
                onClick={() => onSelectColor(c)}
              >
                {COLOR_LABELS[c]}
              </button>
            ))}
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
              <strong>+{chip.amount.toLocaleString()}</strong>
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
      <div className="uno-container" style={{ background: PLAYER_BG_COLORS[0] }}>
        <div className="setup-card home-entry-card">
          <div className="home-castle-icon">🟥🟨🟩🟦</div>
          <h1 className="setup-title">우노 배틀 (UNO POT)</h1>
          <p className="home-subtitle">
            판돈을 걸고 1등이 전액 독식! · 누적 상금 승부 &amp; 파산 시 즉시 아웃
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
              <span className="mode-desc">2~4인 로컬 판돈 누적 서바이벌 우노</span>
            </button>

            <button
              type="button"
              className="mode-select-btn net"
              onClick={() => setAppMode('NET_LOBBY')}
            >
              <span className="mode-icon">🌐</span>
              <strong>넷게임</strong>
              <span className="mode-desc">실시간 4개 테이블 판돈 독식 대전</span>
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
      <div className="uno-container" style={{ background: PLAYER_BG_COLORS[0], padding: '16px' }}>
        <div className="setup-card" style={{ maxWidth: '600px', margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, color: '#0f172a' }}>🏅 명예의 전당</h2>
            <div style={{ width: '60px' }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: '15px', color: '#1e3a8a', textAlign: 'center' }}>
                🎮 단독 플레이 TOP 10
              </h3>
              {soloRecords.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#64748b', fontSize: '13px' }}>기록이 없습니다.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {soloRecords.map((rec, i) => (
                    <div key={rec.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', background: '#fff', padding: '6px 8px', borderRadius: '6px', border: '1px solid #f1f5f9' }}>
                      <span><strong>{i + 1}. {rec.name}</strong></span>
                      <span style={{ color: '#059669' }}>{rec.scoreOrLevel}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: '15px', color: '#b45309', textAlign: 'center' }}>
                🌐 넷플레이 TOP 10
              </h3>
              {netRecords.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#64748b', fontSize: '13px' }}>기록이 없습니다.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {netRecords.map((rec, i) => (
                    <div key={rec.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', background: '#fff', padding: '6px 8px', borderRadius: '6px', border: '1px solid #f1f5f9' }}>
                      <span><strong>{i + 1}. {rec.name}</strong></span>
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
      <div className="uno-container" style={{ background: PLAYER_BG_COLORS[0] }}>
        <div className="net-lobby-container">
          <div className="net-lobby-header">
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, fontSize: '20px', color: '#0f172a' }}>
              🌐 우노 배틀 넷게임 (4개 테이블)
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
                room.status === 'BETTING' ||
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
                    <span className="room-number-title">🃏 제 {room.roomId} 우노룸</span>
                    <span className={`room-status-pill ${statusClass}`}>{statusBadgeText}</span>
                  </div>

                  <div className="room-rules-info">
                    <span>💰 최소 판돈: {room.minBet.toLocaleString()}칩</span>
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
                            {p.name} ({p.isEliminated ? '💀아웃' : `${(p.chips ?? INITIAL_CHIPS).toLocaleString()}칩`})
                          </span>
                        ))
                      )}
                    </div>
                  </div>

                  {roomSpectators.length > 0 && (
                    <div className="room-waitlist-box" style={{ color: '#0369a1', background: '#f0f9ff' }}>
                      👀 관망 중 ({roomSpectators.length}명): {roomSpectators.map((s) => s.name).join(', ')}
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
              <h2 style={{ margin: '0 0 8px' }}>🃏 제 {joinModalRoom.roomId} 우노룸 입장</h2>
              <p className="modal-subtext">
                이름을 입력하고 승부에 참가하거나, <strong>관망모드</strong>로 구경하세요!
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
        <div className="uno-container" style={{ background: PLAYER_BG_COLORS[0], display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="setup-card" style={{ textAlign: 'center' }}>
            <h2>⏳ 방 정보를 불러오는 중입니다...</h2>
            <button type="button" className="btn btn-secondary" style={{ marginTop: '12px' }} onClick={() => setAppMode('NET_LOBBY')}>
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
        <div className="uno-container" style={{ background: PLAYER_BG_COLORS[0] }}>
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
              🃏 우노 배틀 대기실 {amISpectator ? '👀 [관망모드]' : ''}
            </h1>

            <div className="setting-section">
              <label className="setting-label">
                💰 최소 판돈 설정 (초기 지급 10,000칩) {isHost ? '(방장 설정 가능)' : '(방장 설정 중)'}
              </label>
              <div className="piece-count-selector" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                {[500, 1000, 2000].map((val) => (
                  <button
                    key={val}
                    type="button"
                    disabled={!isHost}
                    className={`count-btn ${activeNetRoom.minBet === val ? 'active' : ''}`}
                    onClick={() => updateRoomSettings(val, activeNetRoom.baseTimeout)}
                  >
                    {val.toLocaleString()}칩
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-section">
              <label className="setting-label">
                ⏱️ 턴 제한시간: <strong>{activeNetRoom.baseTimeout}초 (기본 2분)</strong>{' '}
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
                    updateRoomSettings(activeNetRoom.minBet, Number(e.target.value))
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
                      {(p.chips ?? INITIAL_CHIPS).toLocaleString()}칩
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <button
              type="button"
              className="btn btn-success"
              disabled={roomPlayers.length < 2}
              onClick={() => handleStartNetBettingPhase(false)}
            >
              🚀 우노 배틀 시작! ({roomPlayers.length}/4명)
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
    const topDiscard = activeNetRoom.discardPile[activeNetRoom.discardPile.length - 1];

    return (
      <div
        className="uno-container"
        style={{ background: PLAYER_BG_COLORS[netCurrIdx % PLAYER_BG_COLORS.length] }}
      >
        {renderFireworksAndChips()}
        {renderWildColorModal((chosen) => {
          if (pendingWildCardId) handleNetPlayCard(pendingWildCardId, chosen);
        })}

        {toast && (
          <div key={toast.id} className={`uno-toast ${toast.type}`}>
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
                  !p.isEliminated &&
                  ((activeNetRoom.status === 'PLAYING' && idx === netCurrIdx) ||
                    (activeNetRoom.status === 'BETTING' && !p.hasPlacedBet));
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
                ? '⏳ 현재 다음 판 예약 대기 중입니다! 이번 판이 끝나면 빈자리에 자동 참가됩니다.'
                : `⏳ 다음 판 예약자 (${roomWaitlist.length}명): ${roomWaitlist.map((w) => w.name).join(', ')}`}
            </div>
          )}

          <div className="uno-table-board">
            {isRoundEnded ? (
              <div className="winner-celebration-top-bar">
                <div className="winner-celebrate-title">
                  {activeNetRoom.winnerAnnouncement}
                </div>
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
                    onClick={() =>
                      handleStartNetBettingPhase(activeNetRoom.status === 'ROUND_OVER')
                    }
                  >
                    {activeNetRoom.status === 'MATCH_OVER'
                      ? '🔄 새 매치 시작 (10,000칩 초기화)'
                      : '🔥 다음 게임 시작 (누적 칩 이어가기)'}
                  </button>
                </div>
              </div>
            ) : (
              <div key={activeNetRoom.turnNotice} className="uno-notice-banner">
                {activeNetRoom.turnNotice}
              </div>
            )}

            {/* 중앙 덱 / 오픈 카드 / 총 판돈(POT) / 현재 색상 */}
            <div className="uno-center-arena">
              <div className="center-pot-box">
                <span className="pot-label">💰 승자 독식 판돈 (POT)</span>
                <strong className="pot-amount">
                  {(activeNetRoom.pot || 0).toLocaleString()} 칩
                </strong>
              </div>

              {activeNetRoom.status !== 'BETTING' && (
                <div className="uno-piles-row">
                  <div className="pile-box">
                    <span className="pile-label">
                      덱 ({activeNetRoom.deck.length}장)
                    </span>
                    <button
                      type="button"
                      disabled={!isMyTurn}
                      className={`uno-deck-pile-btn ${isMyTurn ? 'can-draw' : ''}`}
                      onClick={handleNetDrawCard}
                    >
                      <span>UNO</span>
                      <small>{isMyTurn ? '클릭하여 뽑기' : 'DRAW'}</small>
                    </button>
                  </div>

                  <div className="pile-box">
                    <span className="pile-label">
                      진행 방향: {activeNetRoom.direction === 1 ? '➡️ 정방향' : '⬅️ 역방향'}
                    </span>
                    {topDiscard && renderUnoCard(topDiscard, true)}
                  </div>

                  <div className="pile-box">
                    <span className="pile-label">현재 유효 색상</span>
                    <div
                      className={`active-color-indicator ${activeNetRoom.activeColor.toLowerCase()}`}
                    >
                      {COLOR_LABELS[activeNetRoom.activeColor]}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 플레이어 좌석 그리드 (본인 패만 앞면, 상대 및 관망모드는 뒷면) */}
            <div className="players-seats-grid">
              {roomPlayers.map((p, idx) => {
                const isTurn =
                  !p.isEliminated &&
                  ((activeNetRoom.status === 'PLAYING' && idx === netCurrIdx) ||
                    (activeNetRoom.status === 'BETTING' && !p.hasPlacedBet));
                const isMe = !amISpectator && p.id === mySessionId;
                const canSeeFace = isMe || isRoundEnded;

                return (
                  <div
                    key={p.id}
                    className={`seat-hand-card ${isTurn ? 'seat-active-turn' : ''} ${
                      p.isEliminated ? 'seat-eliminated' : ''
                    } ${activeNetRoom.roundWinnerId === p.id ? 'seat-winner-glow' : ''}`}
                  >
                    <div className="seat-header">
                      <span className="squircle-dot mini" style={{ backgroundColor: p.badgeColor }}>
                        {getShortName(p.name)}
                      </span>
                      <strong className={isTurn ? 'seat-hero-name' : ''}>
                        {isTurn && '🔥 '}
                        {p.name}
                        {p.id === mySessionId ? '(나)' : ''}
                      </strong>
                      {p.isEliminated ? (
                        <span className="out-pill">💀 판돈 소진 아웃</span>
                      ) : (
                        <>
                          <span className="seat-bet-chip">
                            🪙 베팅: {p.currentBet.toLocaleString()}
                          </span>
                          {p.hand.length > 0 && (
                            <span className="seat-score-tag">
                              {p.hand.length}장 {p.calledUno && p.hand.length === 1 ? '📣UNO!' : ''}
                            </span>
                          )}
                        </>
                      )}
                    </div>

                    <div className="cards-row">
                      {p.isEliminated ? (
                        <span className="bet-status-text">보유 칩을 모두 소진하여 탈락했습니다.</span>
                      ) : p.hand.length === 0 ? (
                        <span className="bet-status-text">
                          {p.hasPlacedBet ? '✅ 판돈 베팅 완료!' : '⏳ 판돈 베팅 대기 중...'}
                        </span>
                      ) : (
                        p.hand.map((card) => {
                          const playable =
                            isMe &&
                            isMyTurn &&
                            canPlayUnoCard(card, topDiscard, activeNetRoom.activeColor);
                          return renderUnoCard(card, canSeeFace, {
                            playable,
                            mini: !isMe,
                            onClick: playable ? () => handleNetPlayCard(card.id) : undefined,
                          });
                        })
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {amISpectator && (
            <div className="uno-bottom-dock">
              <div className="waiting-dock-msg">
                👀 관망모드에서는 모든 플레이어의 패가 숨겨지며, 라운드 종료 시 일제 공개됩니다.
              </div>
            </div>
          )}

          {myPlayerObj && !amISpectator && (
            <div
              className="uno-bottom-dock"
              style={{ borderTop: `4px solid ${myPlayerObj.badgeColor}` }}
            >
              {myPlayerObj.isEliminated ? (
                <div className="waiting-dock-msg" style={{ color: '#dc2626' }}>
                  💀 보유한 판돈을 모두 소진하여 아웃되었습니다. 다음 매치가 열릴 때까지 관전합니다.
                </div>
              ) : (
                <>
                  {activeNetRoom.status === 'BETTING' && !myPlayerObj.hasPlacedBet && (
                    <div className="bet-control-panel">
                      <div className="bet-presets-row">
                        {[
                          activeNetRoom.minBet,
                          activeNetRoom.minBet * 2,
                          activeNetRoom.minBet * 4,
                          myPlayerObj.chips,
                        ].map((amt, i) => {
                          const validAmt = Math.min(myPlayerObj.chips, amt);
                          return (
                            <button
                              key={i}
                              type="button"
                              className={`preset-chip-btn ${
                                netSelectedBet === validAmt ? 'active' : ''
                              }`}
                              onClick={() => setNetSelectedBet(validAmt)}
                            >
                              {i === 3
                                ? `올인 (${validAmt.toLocaleString()})`
                                : `${validAmt.toLocaleString()}칩`}
                            </button>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        className="btn btn-success"
                        onClick={() => handleNetPlaceBet(netSelectedBet)}
                      >
                        🪙 {Math.min(myPlayerObj.chips, netSelectedBet).toLocaleString()}칩 판돈 걸기!
                      </button>
                    </div>
                  )}

                  {activeNetRoom.status === 'BETTING' && myPlayerObj.hasPlacedBet && (
                    <div className="waiting-dock-msg">
                      ✅ {myPlayerObj.currentBet.toLocaleString()}칩 베팅 완료! 다른 참가자의 베팅을 기다립니다...
                    </div>
                  )}

                  {activeNetRoom.status === 'PLAYING' && (
                    <div className="uno-actions-row">
                      <button
                        type="button"
                        className="uno-act-btn uno-call"
                        disabled={myPlayerObj.hand.length > 2 || myPlayerObj.calledUno}
                        onClick={handleNetCallUno}
                      >
                        📣 UNO! 외치기 (2장 이하 시)
                      </button>
                      <button
                        type="button"
                        className="uno-act-btn draw"
                        disabled={!isMyTurn}
                        onClick={handleNetDrawCard}
                      >
                        📥 카드 1장 뽑고 턴 넘기기
                      </button>
                    </div>
                  )}

                  {isRoundEnded && (
                    <div className="waiting-dock-msg">
                      🏆 라운드 종료! 상단의 <strong>[다음 게임 시작]</strong> 버튼으로 누적 상금 승부를 이어가세요!
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
  // 5. 단독게임(SOLO) - 2~4인 로컬 판돈 누적 독식 & 파산 아웃 서바이벌
  // =========================================================================
  const currentPlayer = players[currentPlayerIdx] || players[0];
  const currentBackground =
    (gameState === 'BETTING' || gameState === 'PLAYING') && players.length > 0
      ? PLAYER_BG_COLORS[currentPlayerIdx % PLAYER_BG_COLORS.length]
      : PLAYER_BG_COLORS[0];
  const isSoloEnded = gameState === 'ROUND_OVER' || gameState === 'MATCH_OVER';
  const soloTopDiscard = discardPile[discardPile.length - 1];

  return (
    <div className="uno-container" style={{ background: currentBackground }}>
      {renderFireworksAndChips()}
      {renderWildColorModal((chosen) => {
        if (pendingWildCardId) handleSoloPlayCard(pendingWildCardId, chosen);
      })}

      {toast && (
        <div key={toast.id} className={`uno-toast ${toast.type}`}>
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
          <h1 className="setup-title">🃏 우노 배틀 (단독게임 · 판돈 독식)</h1>

          <div className="setting-section">
            <label className="setting-label">💰 최소 베팅 판돈 설정 (초기 지급 10,000칩)</label>
            <div className="piece-count-selector" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {[500, 1000, 2000].map((val) => (
                <button
                  key={val}
                  type="button"
                  className={`count-btn ${minBetOption === val ? 'active' : ''}`}
                  onClick={() => setMinBetOption(val)}
                >
                  {val.toLocaleString()}칩
                </button>
              ))}
            </div>
          </div>

          <div className="setting-section">
            <label className="setting-label">
              ⏱️ 턴 제한시간 설정: <strong>{soloTimeoutSec}초 (기본 2분)</strong>
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
            <label className="setting-label">🧭 플레이어 등록 (2~4명 · 판돈 0칩 시 즉시 아웃)</label>
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
              🚀 우노 배틀 시작!
            </button>
          </div>
        </div>
      )}

      {(gameState === 'BETTING' ||
        gameState === 'PLAYING' ||
        gameState === 'ROUND_OVER' ||
        gameState === 'MATCH_OVER') &&
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

            <div className="uno-table-board">
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
                        : '🔥 다음 게임 시작 (누적 칩 이어가기)'}
                    </button>
                  </div>
                </div>
              ) : (
                <div key={turnNotice} className="uno-notice-banner">
                  {turnNotice}
                </div>
              )}

              {/* 중앙 덱 / 오픈 카드 / 총 판돈(POT) / 현재 색상 */}
              <div className="uno-center-arena">
                <div className="center-pot-box">
                  <span className="pot-label">💰 승자 독식 판돈 (POT)</span>
                  <strong className="pot-amount">{soloPot.toLocaleString()} 칩</strong>
                </div>

                {gameState !== 'BETTING' && (
                  <div className="uno-piles-row">
                    <div className="pile-box">
                      <span className="pile-label">덱 ({deck.length}장)</span>
                      <button
                        type="button"
                        disabled={gameState !== 'PLAYING'}
                        className={`uno-deck-pile-btn ${
                          gameState === 'PLAYING' ? 'can-draw' : ''
                        }`}
                        onClick={handleSoloDrawCard}
                      >
                        <span>UNO</span>
                        <small>{gameState === 'PLAYING' ? '클릭하여 뽑기' : 'DRAW'}</small>
                      </button>
                    </div>

                    <div className="pile-box">
                      <span className="pile-label">
                        진행 방향: {direction === 1 ? '➡️ 정방향' : '⬅️ 역방향'}
                      </span>
                      {soloTopDiscard && renderUnoCard(soloTopDiscard, true)}
                    </div>

                    <div className="pile-box">
                      <span className="pile-label">현재 유효 색상</span>
                      <div className={`active-color-indicator ${activeColor.toLowerCase()}`}>
                        {COLOR_LABELS[activeColor]}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 플레이어 좌석 영역 (현재 차례 플레이어 패만 공개, 상대 패는 뒷면 숨김) */}
              <div className="players-seats-grid">
                {players.map((p, idx) => {
                  const isTurn = !isSoloEnded && !p.isEliminated && idx === currentPlayerIdx;
                  const canSeeFace = isSoloEnded || idx === currentPlayerIdx;

                  return (
                    <div
                      key={p.id}
                      className={`seat-hand-card ${isTurn ? 'seat-active-turn' : ''} ${
                        p.isEliminated ? 'seat-eliminated' : ''
                      }`}
                    >
                      <div className="seat-header">
                        <span className="squircle-dot mini" style={{ backgroundColor: p.badgeColor }}>
                          {getShortName(p.name)}
                        </span>
                        <strong className={isTurn ? 'seat-hero-name' : ''}>
                          {isTurn && '🔥 '}
                          {p.name}
                        </strong>
                        {p.isEliminated ? (
                          <span className="out-pill">💀 판돈 소진 아웃</span>
                        ) : (
                          <>
                            <span className="seat-bet-chip">
                              🪙 베팅: {p.currentBet.toLocaleString()}
                            </span>
                            {p.hand.length > 0 && (
                              <span className="seat-score-tag">
                                {p.hand.length}장 {p.calledUno && p.hand.length === 1 ? '📣UNO!' : ''}
                              </span>
                            )}
                          </>
                        )}
                      </div>

                      <div className="cards-row">
                        {p.isEliminated ? (
                          <span className="bet-status-text">보유 칩을 모두 소진하여 탈락했습니다.</span>
                        ) : p.hand.length === 0 ? (
                          <span className="bet-status-text">
                            {p.hasPlacedBet ? '✅ 판돈 베팅 완료!' : '⏳ 판돈 베팅 대기 중...'}
                          </span>
                        ) : (
                          p.hand.map((card) => {
                            const playable =
                              gameState === 'PLAYING' &&
                              idx === currentPlayerIdx &&
                              canPlayUnoCard(card, soloTopDiscard, activeColor);
                            return renderUnoCard(card, canSeeFace, {
                              playable,
                              mini: idx !== currentPlayerIdx && !isSoloEnded,
                              onClick: playable ? () => handleSoloPlayCard(card.id) : undefined,
                            });
                          })
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div
              className="uno-bottom-dock"
              style={{ borderTop: `4px solid ${currentPlayer.badgeColor}` }}
            >
              <div className="dock-top-status">
                <span
                  className="turn-owner-pill large-turn-pill"
                  style={{ backgroundColor: currentPlayer.badgeColor }}
                >
                  👉 {currentPlayer.name}님 차례 · 🏆{currentPlayer.wins}승 · 💰
                  {currentPlayer.chips.toLocaleString()}칩
                </span>
              </div>

              {gameState === 'BETTING' && (
                <div className="bet-control-panel">
                  <div className="bet-presets-row">
                    {[
                      minBetOption,
                      minBetOption * 2,
                      minBetOption * 4,
                      currentPlayer.chips,
                    ].map((amt, i) => {
                      const validAmt = Math.min(currentPlayer.chips, amt);
                      return (
                        <button
                          key={i}
                          type="button"
                          className={`preset-chip-btn ${
                            soloSelectedBet === validAmt ? 'active' : ''
                          }`}
                          onClick={() => setSoloSelectedBet(validAmt)}
                        >
                          {i === 3
                            ? `올인 (${validAmt.toLocaleString()})`
                            : `${validAmt.toLocaleString()}칩`}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="btn btn-success"
                    onClick={() => handleSoloPlaceBet(soloSelectedBet)}
                  >
                    🪙 {Math.min(currentPlayer.chips, soloSelectedBet).toLocaleString()}칩 판돈 걸기!
                  </button>
                </div>
              )}

              {gameState === 'PLAYING' && (
                <div className="uno-actions-row">
                  <button
                    type="button"
                    className="uno-act-btn uno-call"
                    disabled={currentPlayer.hand.length > 2 || currentPlayer.calledUno}
                    onClick={handleSoloCallUno}
                  >
                    📣 UNO! 외치기 (2장 이하 시)
                  </button>
                  <button
                    type="button"
                    className="uno-act-btn draw"
                    onClick={handleSoloDrawCard}
                  >
                    📥 카드 1장 뽑고 턴 넘기기
                  </button>
                </div>
              )}

              {isSoloEnded && (
                <div className="waiting-dock-msg">
                  🎉 라운드 종료! <strong>[다음 게임 시작]</strong>을 눌러 누적 상금 승부를 계속하세요!
                </div>
              )}
            </div>
          </div>
        )}
    </div>
  );
}