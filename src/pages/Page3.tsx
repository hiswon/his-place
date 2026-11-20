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
import './Page3.css';

export type CasinoNumber = 1 | 2 | 3 | 4 | 5 | 6;

export interface CasinoState {
  number: CasinoNumber;
  bills: number[]; // 내림차순 정렬된 지폐 금액 (예: [60000, 30000])
  diceByPlayer: Record<string, number>; // playerId -> 배치된 주사위 개수
}

export interface LasVegasPlayer {
  id: string;
  name: string;
  color: string;
  money: number;
  wins: number;
  remainingDice: number;
  rolledDice: number[]; // 현재 턴에 굴려서 나온 주사위 눈금 배열 (1~6)
  hasRolledThisTurn: boolean;
  roundEarned: number;
}

export interface WaitlistPlayer {
  id: string;
  name: string;
}

export interface SpectatorPlayer {
  id: string;
  name: string;
}

export interface NetLasVegasRoomData {
  roomId: number;
  status: 'EMPTY' | 'WAITING' | 'PLAYING' | 'ROUND_OVER' | 'GAME_OVER';
  players: LasVegasPlayer[];
  casinos: CasinoState[];
  moneyDeck: number[];
  waitlist: WaitlistPlayer[];
  spectators: SpectatorPlayer[];
  baseTimeout: number;
  totalRounds: number;
  roundNumber: number;
  currentPlayerIdx: number;
  turnDeadline: number | null;
  turnNotice: string;
  winnerAnnouncement: string;
  winnersList: string[];
  waitingSince?: number | null;
}

interface HallOfFameRecord {
  id: string;
  name: string;
  scoreOrLevel: string;
  date: string;
}

interface MoneyFlyEffect {
  id: number;
  playerName: string;
  amount: number;
  color: string;
}

const PLAYER_BG_COLORS = [
  'linear-gradient(135deg, #e0f2fe 0%, #f0f9ff 50%, #faf5ff 100%)',
  'linear-gradient(135deg, #fce7f3 0%, #fae8ff 50%, #fef3c7 100%)',
  'linear-gradient(135deg, #dcfce7 0%, #f0fdf4 50%, #e0f2fe 100%)',
  'linear-gradient(135deg, #ffedd5 0%, #fff7ed 50%, #fef2f2 100%)',
];

const PIECE_COLORS = ['#dc2626', '#2563eb', '#059669', '#d97706'];
const INITIAL_DICE_COUNT = 8;
const DEFAULT_TIMEOUT_SEC = 120;
const CASINO_NUMBERS: CasinoNumber[] = [1, 2, 3, 4, 5, 6];

const CASINO_LABELS: Record<CasinoNumber, string> = {
  1: '벨라지오 1',
  2: '시저스 2',
  3: '베네시안 3',
  4: 'MGM 4',
  5: '윈 5',
  6: '룩소르 6',
};

const SITUATION_LINES = {
  ROUND_START: (round: number, total: number) => [
    `${round}라운드(총 ${total}라운드)가 시작되었습니다! 6개 카지노에 상금이 깔렸습니다.`,
    `새 라운드 오픈! 주사위를 굴려 카지노의 지폐를 차지하세요!`,
  ],
  PLAYER_TURN: (name: string) => [
    `${name}님 차례입니다! 주사위를 굴려주세요.`,
    `지금은 ${name}님의 턴입니다. 어느 카지노를 노리시겠습니까?`,
  ],
  ROLLED: (name: string, count: number) => [
    `${name}님이 주사위 ${count}개를 굴렸습니다! 배치할 숫자를 선택하세요.`,
    `데굴데굴! ${name}님의 주사위 결과입니다. 원하는 카지노를 클릭하세요!`,
  ],
  PLACED: (name: string, num: number, count: number) => [
    `${name}님이 ${num}번 카지노에 주사위 ${count}개를 모두 배치했습니다!`,
    `승부수! ${name}님이 ${num}번 카지노에 주사위 ${count}개를 올렸습니다!`,
  ],
};

function pickRandomLine(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}

function getShortName(name: string): string {
  const trimmed = name ? name.trim() : '';
  return trimmed ? trimmed.slice(0, 2) : '?';
}

function formatMoney(amount: number): string {
  return `$${amount.toLocaleString()}`;
}

function renderDiceFaces(num: number): string {
  const faces: Record<number, string> = {
    1: '⚀',
    2: '⚁',
    3: '⚂',
    4: '⚃',
    5: '⚄',
    6: '⚅',
  };
  return faces[num] || String(num);
}

/**
 * 라스베가스 표준 지폐 덱 생성 (총 54장: $10k~$90k)
 */
function createMoneyDeck(): number[] {
  const composition: Array<[number, number]> = [
    [10000, 6],
    [20000, 8],
    [30000, 8],
    [40000, 6],
    [50000, 6],
    [60000, 5],
    [70000, 5],
    [80000, 5],
    [90000, 5],
  ];
  const deck: number[] = [];
  for (const [val, cnt] of composition) {
    for (let i = 0; i < cnt; i++) {
      deck.push(val);
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

/**
 * 각 카지노(1~6)에 최소 $50,000 이상이 되도록 지폐 배분
 */
function dealCasinosForRound(currentDeck: number[]): {
  casinos: CasinoState[];
  remainingDeck: number[];
} {
  let deckCopy = currentDeck.length >= 25 ? [...currentDeck] : createMoneyDeck();
  const casinos: CasinoState[] = CASINO_NUMBERS.map((num) => {
    const bills: number[] = [];
    let sum = 0;
    while (sum < 50000) {
      if (deckCopy.length === 0) {
        deckCopy = createMoneyDeck();
      }
      const bill = deckCopy.shift()!;
      bills.push(bill);
      sum += bill;
    }
    bills.sort((a, b) => b - a);
    return {
      number: num,
      bills,
      diceByPlayer: {},
    };
  });

  return { casinos, remainingDeck: deckCopy };
}

function rollDiceArray(count: number): number[] {
  const res: number[] = [];
  for (let i = 0; i < count; i++) {
    res.push(Math.floor(Math.random() * 6) + 1);
  }
  return res.sort((a, b) => a - b);
}

/**
 * 라운드 종료 정산 (동률 상쇄 규칙 적용)
 */
function settleLasVegasRound(
  players: LasVegasPlayer[],
  casinos: CasinoState[],
  isFinalRound: boolean
): {
  settledPlayers: LasVegasPlayer[];
  winners: string[];
  announcement: string;
} {
  const earnedMap: Record<string, number> = {};
  players.forEach((p) => {
    earnedMap[p.id] = 0;
  });

  for (const casino of casinos) {
    const entries = Object.entries(casino.diceByPlayer || {}).filter(
      ([, count]) => count > 0
    );
    if (entries.length === 0) continue;

    // 주사위 개수 빈도 계산 (동률 상쇄 판별)
    const countFrequency: Record<number, number> = {};
    for (const [, cnt] of entries) {
      countFrequency[cnt] = (countFrequency[cnt] || 0) + 1;
    }

    // 동률이 아닌(유일한 주사위 개수를 가진) 플레이어만 필터링 후 내림차순 정렬
    const validRankers = entries
      .filter(([, cnt]) => countFrequency[cnt] === 1)
      .sort((a, b) => b[1] - a[1]);

    // 1등부터 지폐 순서대로 지급
    casino.bills.forEach((bill, rankIdx) => {
      if (rankIdx < validRankers.length) {
        const winnerId = validRankers[rankIdx][0];
        if (earnedMap[winnerId] !== undefined) {
          earnedMap[winnerId] += bill;
        }
      }
    });
  }

  let settledPlayers = players.map((p) => {
    const gain = earnedMap[p.id] || 0;
    return {
      ...p,
      money: p.money + gain,
      roundEarned: gain,
    };
  });

  if (isFinalRound) {
    const maxMoney = Math.max(...settledPlayers.map((p) => p.money));
    const topPlayers = settledPlayers.filter((p) => p.money === maxMoney && maxMoney > 0);
    const winners = topPlayers.map((p) => p.name);

    settledPlayers = settledPlayers.map((p) => ({
      ...p,
      wins: p.money === maxMoney && maxMoney > 0 ? (p.wins || 0) + 1 : p.wins || 0,
    }));

    const announcement =
      winners.length > 0
        ? `🏆 최종 우승! ${winners.join(', ')}님이 총 ${formatMoney(maxMoney)}로 라스베가스를 제패했습니다!`
        : `🎲 최종 라운드 종료! 모든 플레이어가 $0입니다.`;

    return { settledPlayers, winners, announcement };
  }

  const maxRoundGain = Math.max(...settledPlayers.map((p) => p.roundEarned));
  const roundLeaders = settledPlayers.filter(
    (p) => p.roundEarned === maxRoundGain && maxRoundGain > 0
  );
  const winners = roundLeaders.map((p) => p.name);
  const announcement =
    winners.length > 0
      ? `💰 라운드 정산 완료! ${winners.join(', ')}님이 이번 라운드 최고 ${formatMoney(maxRoundGain)} 획득!`
      : `🤝 동률 상쇄로 이번 라운드 상금 획득자가 없습니다!`;

  return { settledPlayers, winners, announcement };
}

function createDefaultLasVegasRoom(roomId: number): NetLasVegasRoomData {
  return {
    roomId,
    status: 'EMPTY',
    players: [],
    casinos: CASINO_NUMBERS.map((n) => ({ number: n, bills: [], diceByPlayer: {} })),
    moneyDeck: [],
    waitlist: [],
    spectators: [],
    baseTimeout: DEFAULT_TIMEOUT_SEC,
    totalRounds: 4,
    roundNumber: 1,
    currentPlayerIdx: 0,
    turnDeadline: null,
    turnNotice: '',
    winnerAnnouncement: '',
    winnersList: [],
    waitingSince: null,
  };
}

export default function Page3() {
  const [appMode, setAppMode] = useState<'HOME' | 'SOLO' | 'NET_LOBBY' | 'NET_ROOM' | 'HALL_OF_FAME'>('HOME');

  const [mySessionId] = useState<string>(() => {
    const saved = sessionStorage.getItem('lasvegas_net_uid');
    if (saved) return saved;
    const generated = `lv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('lasvegas_net_uid', generated);
    return generated;
  });

  // 넷게임 상태
  const [rooms, setRooms] = useState<NetLasVegasRoomData[]>([1, 2, 3, 4].map(createDefaultLasVegasRoom));
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [joinModalRoom, setJoinModalRoom] = useState<NetLasVegasRoomData | null>(null);
  const [joinPlayerName, setJoinPlayerName] = useState<string>('');
  const [remainingSeconds, setRemainingSeconds] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [waitingCountdownSec, setWaitingCountdownSec] = useState<number>(420);
  const timeoutHandledRef = useRef<number | null>(null);
  const lastSpokenNoticeRef = useRef<string>('');
  const lastCountdownSpokenRef = useRef<number | null>(null);

  // 단독게임(SOLO) 상태
  const [gameState, setGameState] = useState<'SETUP' | 'READY' | 'PLAYING' | 'ROUND_OVER' | 'GAME_OVER'>('SETUP');
  const [players, setPlayers] = useState<LasVegasPlayer[]>([
    {
      id: '1',
      name: '타짜',
      color: PIECE_COLORS[0],
      money: 0,
      wins: 0,
      remainingDice: INITIAL_DICE_COUNT,
      rolledDice: [],
      hasRolledThisTurn: false,
      roundEarned: 0,
    },
    {
      id: '2',
      name: '고니',
      color: PIECE_COLORS[1],
      money: 0,
      wins: 0,
      remainingDice: INITIAL_DICE_COUNT,
      rolledDice: [],
      hasRolledThisTurn: false,
      roundEarned: 0,
    },
  ]);
  const [casinos, setCasinos] = useState<CasinoState[]>(
    CASINO_NUMBERS.map((n) => ({ number: n, bills: [], diceByPlayer: {} }))
  );
  const [moneyDeck, setMoneyDeck] = useState<number[]>([]);
  const [inputName, setInputName] = useState('');
  const [totalRoundsOption, setTotalRoundsOption] = useState<number>(4);
  const [soloTimeoutSec, setSoloTimeoutSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRemainingSec, setSoloRemainingSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRoundNum, setSoloRoundNum] = useState<number>(1);
  const [currentPlayerIdx, setCurrentPlayerIdx] = useState<number>(0);
  const [turnNotice, setTurnNotice] = useState<string>('');
  const [winnerAnnouncement, setWinnerAnnouncement] = useState<string>('');
  const [showFireworks, setShowFireworks] = useState<boolean>(false);
  const [moneyFlyEffects, setMoneyFlyEffects] = useState<MoneyFlyEffect[]>([]);

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

  const playSound = (kind: 'roll' | 'place' | 'win' | 'tick') => {
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
        roll: [340, 460, 580, 720],
        place: [660, 880],
        win: [523.25, 659.25, 783.99, 1046.5, 1318.5],
        tick: [987.77],
      };

      notesMap[kind].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === 'roll' ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.06);
        gain.gain.setValueAtTime(kind === 'tick' ? 0.18 : 0.14, ctx.currentTime + idx * 0.06);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.06 + 0.22);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.06);
        osc.stop(ctx.currentTime + idx * 0.06 + 0.22);
      });
    } catch {
      // 오디오 차단 예외 무시
    }
  };

  const triggerMoneyAnimation = (playerName: string, amount: number, color: string) => {
    if (amount <= 0) return;
    const id = Date.now() + Math.random();
    setMoneyFlyEffects((prev) => [...prev, { id, playerName, amount, color }]);
    window.setTimeout(() => {
      setMoneyFlyEffects((prev) => prev.filter((item) => item.id !== id));
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
    const key = type === 'SOLO' ? 'lasvegas_hof_solo' : 'lasvegas_hof_net';
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
    const key = type === 'SOLO' ? 'lasvegas_hof_solo' : 'lasvegas_hof_net';
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
        const roomRef = ref(db, `lasvegas_rooms/room_${id}`);
        const snap = await get(roomRef);
        if (!snap.exists()) {
          await set(roomRef, createDefaultLasVegasRoom(id));
        }
      }
    };
    ensureRoomsExist();

    const roomsRef = ref(db, 'lasvegas_rooms');
    const unsubscribe = onValue(roomsRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      const loadedRooms: NetLasVegasRoomData[] = [1, 2, 3, 4].map((id) => {
        const rData = data[`room_${id}`];
        const def = createDefaultLasVegasRoom(id);
        if (!rData) return def;
        return {
          ...def,
          ...rData,
          players: (rData.players || []).map((p: LasVegasPlayer) => ({
            ...p,
            rolledDice: p.rolledDice || [],
            money: typeof p.money === 'number' ? p.money : 0,
            wins: typeof p.wins === 'number' ? p.wins : 0,
            remainingDice: typeof p.remainingDice === 'number' ? p.remainingDice : INITIAL_DICE_COUNT,
          })),
          casinos: (rData.casinos || def.casinos).map((c: CasinoState) => ({
            ...c,
            bills: c.bills || [],
            diceByPlayer: c.diceByPlayer || {},
          })),
          moneyDeck: rData.moneyDeck || [],
          waitlist: rData.waitlist || [],
          spectators: rData.spectators || [],
          winnersList: rData.winnersList || [],
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
      (activeNetRoom.status === 'ROUND_OVER' || activeNetRoom.status === 'GAME_OVER') &&
      activeNetRoom.winnerAnnouncement &&
      lastSpokenNoticeRef.current !== activeNetRoom.winnerAnnouncement
    ) {
      lastSpokenNoticeRef.current = activeNetRoom.winnerAnnouncement;
      if (activeNetRoom.winnersList && activeNetRoom.winnersList.length > 0) {
        triggerFireworksCelebration(activeNetRoom.winnerAnnouncement);
      } else {
        speakKorean(activeNetRoom.winnerAnnouncement);
      }
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
          const roomRef = ref(db, `lasvegas_rooms/room_${activeNetRoom.roomId}`);
          await set(roomRef, createDefaultLasVegasRoom(activeNetRoom.roomId));
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
          const actor = players[currentPlayerIdx];
          if (actor) {
            const dicePool = actor.hasRolledThisTurn
              ? actor.rolledDice
              : rollDiceArray(actor.remainingDice);
            const autoChoice = (dicePool[0] || 1) as CasinoNumber;
            handleSoloPlaceDice(autoChoice, dicePool);
          }
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [appMode, gameState, currentPlayerIdx, players, soloTimeoutSec]);

  const handleEnterRoomSubmit = async (asSpectator = false) => {
    if (!joinModalRoom) return;
    const trimmedName = joinPlayerName ? joinPlayerName.trim() : '';
    if (!trimmedName) {
      alert('참가할 이름을 입력해주세요!');
      return;
    }

    const roomRef = ref(db, `lasvegas_rooms/room_${joinModalRoom.roomId}`);

    try {
      let joinResultType = 'PLAYER';

      await runTransaction(roomRef, (roomData) => {
        const room: NetLasVegasRoomData = roomData || createDefaultLasVegasRoom(joinModalRoom.roomId);
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
          const newPlayer: LasVegasPlayer = {
            id: mySessionId,
            name: trimmedName,
            color: PIECE_COLORS[idx],
            money: 0,
            wins: 0,
            remainingDice: INITIAL_DICE_COUNT,
            rolledDice: [],
            hasRolledThisTurn: false,
            roundEarned: 0,
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
        showToast('⏳ 다음 게임 예약자로 등록되었습니다!', 'info');
      }
    } catch (err) {
      console.error(err);
      alert('방 입장 중 오류가 발생했습니다.');
    }
  };

  const updateRoomSettings = async (newTotalRounds: number, newTimeout: number) => {
    if (!activeNetRoom) return;
    const clampedTimeout = Math.min(180, Math.max(30, newTimeout));
    const roomRef = ref(db, `lasvegas_rooms/room_${activeNetRoom.roomId}`);
    await update(roomRef, {
      totalRounds: newTotalRounds,
      baseTimeout: clampedTimeout,
      waitingSince: Date.now(),
    });
  };

  /**
   * 넷게임 새 게임 또는 다음 라운드 시작
   */
  const handleStartNetRound = async (mode: 'NEW_GAME' | 'NEXT_ROUND') => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `lasvegas_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetLasVegasRoomData;
      if (!room.players) room.players = [];
      if (!room.waitlist) room.waitlist = [];

      const isNewGame = mode === 'NEW_GAME';
      const nextRound = isNewGame ? 1 : (room.roundNumber || 1) + 1;
      const currentPlayers = [...room.players];
      const waitlist = [...room.waitlist];

      let nextParticipants: LasVegasPlayer[] = [];
      let remainingWaitlist: WaitlistPlayer[] = [];

      if (isNewGame && currentPlayers.length + waitlist.length <= 4) {
        const convertedWaiters: LasVegasPlayer[] = waitlist.map((w) => ({
          id: w.id,
          name: w.name,
          color: PIECE_COLORS[0],
          money: 0,
          wins: 0,
          remainingDice: INITIAL_DICE_COUNT,
          rolledDice: [],
          hasRolledThisTurn: false,
          roundEarned: 0,
        }));
        nextParticipants = [...currentPlayers, ...convertedWaiters];
      } else {
        nextParticipants = currentPlayers.slice(0, 4);
        remainingWaitlist = waitlist;
      }

      if (nextParticipants.length < 2) {
        room.status = nextParticipants.length === 0 ? 'EMPTY' : 'WAITING';
        room.players = nextParticipants;
        room.waitlist = remainingWaitlist;
        return room;
      }

      const resetPlayers = nextParticipants.map((p, idx) => ({
        ...p,
        color: PIECE_COLORS[idx % PIECE_COLORS.length],
        money: isNewGame ? 0 : p.money || 0,
        wins: p.wins || 0,
        remainingDice: INITIAL_DICE_COUNT,
        rolledDice: [],
        hasRolledThisTurn: false,
        roundEarned: 0,
      }));

      const initialDeck = isNewGame ? createMoneyDeck() : room.moneyDeck || createMoneyDeck();
      const dealt = dealCasinosForRound(initialDeck);
      const startPlayerIdx = isNewGame ? 0 : (nextRound - 1) % resetPlayers.length;

      room.status = 'PLAYING';
      room.roundNumber = nextRound;
      room.players = resetPlayers;
      room.casinos = dealt.casinos;
      room.moneyDeck = dealt.remainingDeck;
      room.waitlist = remainingWaitlist;
      room.currentPlayerIdx = startPlayerIdx;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.winnerAnnouncement = '';
      room.winnersList = [];
      room.turnNotice = `🎲 [${nextRound}/${room.totalRounds}R] ${resetPlayers[startPlayerIdx].name}님 차례입니다! 주사위를 굴려주세요.`;
      room.waitingSince = null;

      return room;
    });
  };

  /**
   * 넷게임 주사위 굴리기
   */
  const handleNetRollDice = async () => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const currIdx = activeNetRoom.currentPlayerIdx % activeNetRoom.players.length;
    const currP = activeNetRoom.players[currIdx];
    if (!currP || currP.id !== mySessionId || currP.hasRolledThisTurn) return;

    playSound('roll');
    const roomRef = ref(db, `lasvegas_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetLasVegasRoomData;
      if (room.status !== 'PLAYING') return room;

      const idx = room.currentPlayerIdx % room.players.length;
      const actor = room.players[idx];
      if (!actor || actor.id !== mySessionId || actor.hasRolledThisTurn) return room;

      const rolled = rollDiceArray(actor.remainingDice);
      room.players[idx] = {
        ...actor,
        rolledDice: rolled,
        hasRolledThisTurn: true,
      };
      room.turnNotice = `🎲 ${pickRandomLine(SITUATION_LINES.ROLLED(actor.name, rolled.length))}`;
      return room;
    });
  };

  /**
   * 넷게임 카지노(1~6)에 해당 눈금 주사위 전체 배치
   */
  const handleNetPlaceDice = async (chosenNumber: CasinoNumber) => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const currIdx = activeNetRoom.currentPlayerIdx % activeNetRoom.players.length;
    const currP = activeNetRoom.players[currIdx];
    if (!currP || currP.id !== mySessionId || !currP.hasRolledThisTurn) return;

    const matchingCount = currP.rolledDice.filter((d) => d === chosenNumber).length;
    if (matchingCount === 0) return;

    playSound('place');
    const roomRef = ref(db, `lasvegas_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetLasVegasRoomData;
      if (room.status !== 'PLAYING') return room;

      const idx = room.currentPlayerIdx % room.players.length;
      const actor = room.players[idx];
      if (!actor || actor.id !== mySessionId || !actor.hasRolledThisTurn) return room;

      const countToPlace = actor.rolledDice.filter((d) => d === chosenNumber).length;
      if (countToPlace === 0) return room;

      // 카지노에 주사위 추가
      room.casinos = room.casinos.map((c) => {
        if (c.number !== chosenNumber) return c;
        const prevDice = c.diceByPlayer || {};
        return {
          ...c,
          diceByPlayer: {
            ...prevDice,
            [actor.id]: (prevDice[actor.id] || 0) + countToPlace,
          },
        };
      });

      // 플레이어 남은 주사위 차감
      room.players[idx] = {
        ...actor,
        remainingDice: Math.max(0, actor.remainingDice - countToPlace),
        rolledDice: [],
        hasRolledThisTurn: false,
      };

      // 남은 주사위가 있는 다음 플레이어 탐색
      let nextIdx = -1;
      for (let offset = 1; offset <= room.players.length; offset++) {
        const candidateIdx = (idx + offset) % room.players.length;
        if (room.players[candidateIdx].remainingDice > 0) {
          nextIdx = candidateIdx;
          break;
        }
      }

      if (nextIdx !== -1) {
        const nextActor = room.players[nextIdx];
        room.currentPlayerIdx = nextIdx;
        room.turnDeadline = Date.now() + room.baseTimeout * 1000;
        room.turnNotice = `🎯 ${actor.name}님 ${chosenNumber}번 카지노에 ${countToPlace}개 배치! 다음은 ${nextActor.name}님 차례입니다.`;
        return room;
      }

      // 전원 주사위 소진 -> 라운드 정산
      const isFinalRound = room.roundNumber >= room.totalRounds;
      const settled = settleLasVegasRound(room.players, room.casinos, isFinalRound);
      room.players = settled.settledPlayers;
      room.status = isFinalRound ? 'GAME_OVER' : 'ROUND_OVER';
      room.turnDeadline = null;
      room.turnNotice = '';
      room.winnersList = settled.winners;
      room.winnerAnnouncement = settled.announcement;

      if (isFinalRound) {
        settled.settledPlayers.forEach((sp) => {
          if (settled.winners.includes(sp.name)) {
            saveHallOfFameRecord('NET', {
              name: sp.name,
              scoreOrLevel: `${sp.wins}승 · 최종 ${formatMoney(sp.money)}`,
            });
          }
        });
      }

      return room;
    });
  };

  const handleNetTurnTimeout = async (room: NetLasVegasRoomData) => {
    if (room.status !== 'PLAYING') return;
    const roomRef = ref(db, `lasvegas_rooms/room_${room.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const r = roomData as NetLasVegasRoomData;
      if (r.status !== 'PLAYING') return r;

      const idx = r.currentPlayerIdx % r.players.length;
      const actor = r.players[idx];
      const dicePool = actor.hasRolledThisTurn
        ? actor.rolledDice
        : rollDiceArray(actor.remainingDice);
      const autoNum = (dicePool[0] || 1) as CasinoNumber;
      const countToPlace = dicePool.filter((d) => d === autoNum).length || 1;

      r.casinos = r.casinos.map((c) => {
        if (c.number !== autoNum) return c;
        const prevDice = c.diceByPlayer || {};
        return {
          ...c,
          diceByPlayer: {
            ...prevDice,
            [actor.id]: (prevDice[actor.id] || 0) + countToPlace,
          },
        };
      });

      r.players[idx] = {
        ...actor,
        remainingDice: Math.max(0, actor.remainingDice - countToPlace),
        rolledDice: [],
        hasRolledThisTurn: false,
      };

      let nextIdx = -1;
      for (let offset = 1; offset <= r.players.length; offset++) {
        const candidateIdx = (idx + offset) % r.players.length;
        if (r.players[candidateIdx].remainingDice > 0) {
          nextIdx = candidateIdx;
          break;
        }
      }

      if (nextIdx !== -1) {
        const nextActor = r.players[nextIdx];
        r.currentPlayerIdx = nextIdx;
        r.turnDeadline = Date.now() + r.baseTimeout * 1000;
        r.turnNotice = `⏰ 시간 초과로 ${actor.name}님의 주사위가 ${autoNum}번에 자동 배치되었습니다. ${nextActor.name}님 차례!`;
        return r;
      }

      const isFinalRound = r.roundNumber >= r.totalRounds;
      const settled = settleLasVegasRound(r.players, r.casinos, isFinalRound);
      r.players = settled.settledPlayers;
      r.status = isFinalRound ? 'GAME_OVER' : 'ROUND_OVER';
      r.turnDeadline = null;
      r.turnNotice = '';
      r.winnersList = settled.winners;
      r.winnerAnnouncement = settled.announcement;
      return r;
    });
  };

  const handleLeaveNetRoom = async () => {
    if (!activeNetRoom) {
      setAppMode('NET_LOBBY');
      return;
    }

    const roomRef = ref(db, `lasvegas_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetLasVegasRoomData;
      const filteredPlayers = (room.players || []).filter((p) => p.id !== mySessionId);
      const filteredWaitlist = (room.waitlist || []).filter((w) => w.id !== mySessionId);
      const filteredSpectators = (room.spectators || []).filter((s) => s.id !== mySessionId);

      if (filteredPlayers.length === 0 && filteredSpectators.length === 0) {
        return createDefaultLasVegasRoom(room.roomId);
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
        color: PIECE_COLORS[idx % PIECE_COLORS.length],
        money: 0,
        wins: 0,
        remainingDice: INITIAL_DICE_COUNT,
        rolledDice: [],
        hasRolledThisTurn: false,
        roundEarned: 0,
      },
    ]);
    setInputName('');
  };

  const removePlayer = (id: string) => {
    setPlayers(players.filter((p) => p.id !== id));
  };

  const movePlayerOrder = (index: number, direction: 'UP' | 'DOWN') => {
    const newPlayers = [...players];
    const targetIdx = direction === 'UP' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= newPlayers.length) return;
    [newPlayers[index], newPlayers[targetIdx]] = [newPlayers[targetIdx], newPlayers[index]];
    setPlayers(newPlayers);
  };

  const shufflePlayersOrder = () => {
    setPlayers([...players].sort(() => Math.random() - 0.5));
  };

  const goToMainReady = () => {
    if (players.length < 2) {
      showToast('라스베가스 보드게임은 최소 2명 이상 필요합니다!', 'info');
      return;
    }
    setGameState('READY');
  };

  const startSoloRound = (mode: 'NEW_GAME' | 'NEXT_ROUND') => {
    const isNewGame = mode === 'NEW_GAME';
    const nextRound = isNewGame ? 1 : soloRoundNum + 1;

    const resetPlayers = players.map((p, idx) => ({
      ...p,
      color: PIECE_COLORS[idx % PIECE_COLORS.length],
      money: isNewGame ? 0 : p.money,
      remainingDice: INITIAL_DICE_COUNT,
      rolledDice: [],
      hasRolledThisTurn: false,
      roundEarned: 0,
    }));

    const baseDeck = isNewGame ? createMoneyDeck() : moneyDeck;
    const dealt = dealCasinosForRound(baseDeck);
    const startIdx = isNewGame ? 0 : (nextRound - 1) % resetPlayers.length;
    const notice = `🎲 [${nextRound}/${totalRoundsOption}R] ${resetPlayers[startIdx].name}님 차례입니다! 주사위를 굴려주세요.`;

    setSoloRoundNum(nextRound);
    setPlayers(resetPlayers);
    setCasinos(dealt.casinos);
    setMoneyDeck(dealt.remainingDeck);
    setCurrentPlayerIdx(startIdx);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setWinnerAnnouncement('');
    setShowFireworks(false);
    setTurnNotice(notice);
    speakKorean(notice);
    setGameState('PLAYING');
  };

  const handleSoloRollDice = () => {
    if (gameState !== 'PLAYING') return;
    const actor = players[currentPlayerIdx];
    if (!actor || actor.hasRolledThisTurn) return;

    playSound('roll');
    const rolled = rollDiceArray(actor.remainingDice);
    const updated = players.map((p, idx) =>
      idx === currentPlayerIdx
        ? { ...p, rolledDice: rolled, hasRolledThisTurn: true }
        : p
    );

    const notice = `🎲 ${pickRandomLine(SITUATION_LINES.ROLLED(actor.name, rolled.length))}`;
    setPlayers(updated);
    setTurnNotice(notice);
    speakKorean(notice);
  };

  const handleSoloPlaceDice = (chosenNumber: CasinoNumber, overrideDice?: number[]) => {
    if (gameState !== 'PLAYING') return;
    const actor = players[currentPlayerIdx];
    const activeDice = overrideDice || actor.rolledDice;
    const countToPlace = activeDice.filter((d) => d === chosenNumber).length;
    if (countToPlace === 0) return;

    playSound('place');

    const nextCasinos = casinos.map((c) => {
      if (c.number !== chosenNumber) return c;
      const prevDice = c.diceByPlayer || {};
      return {
        ...c,
        diceByPlayer: {
          ...prevDice,
          [actor.id]: (prevDice[actor.id] || 0) + countToPlace,
        },
      };
    });

    const nextPlayers = players.map((p, idx) =>
      idx === currentPlayerIdx
        ? {
            ...p,
            remainingDice: Math.max(0, p.remainingDice - countToPlace),
            rolledDice: [],
            hasRolledThisTurn: false,
          }
        : p
    );

    let nextIdx = -1;
    for (let offset = 1; offset <= nextPlayers.length; offset++) {
      const candidateIdx = (currentPlayerIdx + offset) % nextPlayers.length;
      if (nextPlayers[candidateIdx].remainingDice > 0) {
        nextIdx = candidateIdx;
        break;
      }
    }

    if (nextIdx !== -1) {
      const nextActor = nextPlayers[nextIdx];
      const notice = `🎯 ${actor.name}님 ${chosenNumber}번 카지노에 ${countToPlace}개 배치! ${nextActor.name}님 차례입니다.`;
      setCasinos(nextCasinos);
      setPlayers(nextPlayers);
      setCurrentPlayerIdx(nextIdx);
      setSoloRemainingSec(soloTimeoutSec);
      lastCountdownSpokenRef.current = null;
      setTurnNotice(notice);
      speakKorean(notice);
      return;
    }

    const isFinalRound = soloRoundNum >= totalRoundsOption;
    const settled = settleLasVegasRound(nextPlayers, nextCasinos, isFinalRound);

    settled.settledPlayers.forEach((sp) => {
      if (sp.roundEarned > 0) {
        triggerMoneyAnimation(sp.name, sp.roundEarned, sp.color);
      }
    });

    setCasinos(nextCasinos);
    setPlayers(settled.settledPlayers);
    setTurnNotice('');
    setWinnerAnnouncement(settled.announcement);
    setGameState(isFinalRound ? 'GAME_OVER' : 'ROUND_OVER');

    if (settled.winners.length > 0) {
      triggerFireworksCelebration(settled.announcement);
      if (isFinalRound) {
        settled.settledPlayers.forEach((sp) => {
          if (settled.winners.includes(sp.name)) {
            saveHallOfFameRecord('SOLO', {
              name: sp.name,
              scoreOrLevel: `${sp.wins}승 · 최종 ${formatMoney(sp.money)}`,
            });
          }
        });
      }
    } else {
      speakKorean(settled.announcement);
    }
  };

  // =========================================================================
  // 공용 UI 렌더링 헬퍼: 6개 카지노 보드 그리드
  // =========================================================================
  const renderCasinosBoard = (
    boardCasinos: CasinoState[],
    boardPlayers: LasVegasPlayer[],
    activePlayer: LasVegasPlayer | undefined,
    canInteract: boolean,
    onSelectCasino: (num: CasinoNumber) => void
  ) => {
    const rolledSet = new Set<number>(
      canInteract && activePlayer?.hasRolledThisTurn ? activePlayer.rolledDice : []
    );

    return (
      <div className="lv-casinos-grid">
        {boardCasinos.map((casino) => {
          const isSelectable = rolledSet.has(casino.number);
          const matchCount = isSelectable
            ? (activePlayer?.rolledDice || []).filter((d) => d === casino.number).length
            : 0;

          // 동률 여부 표시용 빈도 계산
          const entries = Object.entries(casino.diceByPlayer || {}).filter(([, c]) => c > 0);
          const freq: Record<number, number> = {};
          entries.forEach(([, cnt]) => {
            freq[cnt] = (freq[cnt] || 0) + 1;
          });

          const totalPot = casino.bills.reduce((acc, b) => acc + b, 0);

          return (
            <div
              key={casino.number}
              className={`lv-casino-card ${isSelectable ? 'selectable-glow' : ''}`}
              onClick={() => {
                if (isSelectable) {
                  onSelectCasino(casino.number);
                }
              }}
            >
              <div className="lv-casino-header">
                <span className="lv-casino-die-badge">
                  {renderDiceFaces(casino.number)} {casino.number}번
                </span>
                <span className="lv-casino-name">{CASINO_LABELS[casino.number]}</span>
                <span className="lv-casino-total">합계 {formatMoney(totalPot)}</span>
              </div>

              {/* 깔린 지폐 목록 */}
              <div className="lv-bills-row">
                {casino.bills.map((bill, bIdx) => (
                  <span
                    key={bIdx}
                    className={`lv-bill-chip ${bIdx === 0 ? 'top-prize' : 'second-prize'}`}
                  >
                    {bIdx === 0 ? '🥇' : bIdx === 1 ? '🥈' : '💵'} {formatMoney(bill)}
                  </span>
                ))}
              </div>

              {/* 플레이어별 배치된 주사위 현황 */}
              <div className="lv-placed-dice-area">
                {entries.length === 0 ? (
                  <span className="lv-empty-dice-msg">배치된 주사위 없음</span>
                ) : (
                  entries
                    .sort((a, b) => b[1] - a[1])
                    .map(([pid, count]) => {
                      const owner = boardPlayers.find((p) => p.id === pid);
                      if (!owner) return null;
                      const isTied = freq[count] > 1;
                      return (
                        <div
                          key={pid}
                          className={`lv-player-dice-stack ${isTied ? 'tied-cancelled' : ''}`}
                          style={{ borderColor: owner.color }}
                        >
                          <span
                            className="squircle-dot mini"
                            style={{ backgroundColor: owner.color }}
                          >
                            {getShortName(owner.name)}
                          </span>
                          <span className="lv-dice-icons">
                            {Array.from({ length: count }).map((_, i) => (
                              <span key={i} style={{ color: owner.color }}>
                                {renderDiceFaces(casino.number)}
                              </span>
                            ))}
                          </span>
                          <strong className="lv-dice-count-tag">
                            {count}개 {isTied ? '(동률상쇄)' : ''}
                          </strong>
                        </div>
                      );
                    })
                )}
              </div>

              {isSelectable && (
                <div className="lv-place-cta-bar">
                  👉 클릭하여 주사위 {matchCount}개 배치!
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderFireworksAndMoney = () => (
    <>
      <div className="chip-fly-layer">
        {moneyFlyEffects.map((item) => (
          <div
            key={item.id}
            className="flying-poker-chip"
            style={{ backgroundColor: item.color }}
          >
            <div className="chip-inner-ring">
              <span>{item.playerName}</span>
              <strong>+{formatMoney(item.amount)}</strong>
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
      <div className="lv-container" style={{ background: PLAYER_BG_COLORS[0] }}>
        <div className="setup-card home-entry-card">
          <div className="home-castle-icon">🎲💵🎰👑</div>
          <h1 className="setup-title">라스베가스 (LAS VEGAS)</h1>
          <p className="home-subtitle">6개 카지노 주사위 눈치 싸움 · 동률 상쇄 보드게임</p>

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
              <span className="mode-desc">2~4인이 한 화면에서 즐기는 라스베가스</span>
            </button>

            <button
              type="button"
              className="mode-select-btn net"
              onClick={() => setAppMode('NET_LOBBY')}
            >
              <span className="mode-icon">🌐</span>
              <strong>넷게임</strong>
              <span className="mode-desc">실시간 4개 테이블 온라인 대전</span>
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
      <div className="lv-container" style={{ background: PLAYER_BG_COLORS[0], padding: '16px' }}>
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
      <div className="lv-container" style={{ background: PLAYER_BG_COLORS[0] }}>
        <div className="net-lobby-container">
          <div className="net-lobby-header">
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, fontSize: '20px', color: '#0f172a' }}>
              🌐 라스베가스 넷게임 (4개 테이블)
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
                room.status === 'GAME_OVER';
              const isFull = roomPlayers.length >= 4;

              let statusBadgeText = '🟢 빈 테이블';
              let statusClass = 'empty';
              if (isPlaying) {
                statusBadgeText = `🔥 ${room.roundNumber}/${room.totalRounds}R 진행중`;
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
                    <span className="room-number-title">🎲 제 {room.roomId} 라스베가스룸</span>
                    <span className={`room-status-pill ${statusClass}`}>{statusBadgeText}</span>
                  </div>

                  <div className="room-rules-info">
                    <span>🏆 총 {room.totalRounds}라운드 승부</span>
                    <span>⏱️ 턴 제한: {room.baseTimeout}초</span>
                  </div>

                  <div className="room-members-box">
                    <div className="room-members-label">참가자 ({roomPlayers.length}/4):</div>
                    <div className="room-members-chips">
                      {roomPlayers.length === 0 ? (
                        <span className="empty-member-text">첫 번째 플레이어를 기다리고 있습니다</span>
                      ) : (
                        roomPlayers.map((p, idx) => (
                          <span
                            key={p.id}
                            className="member-chip"
                            style={{ borderColor: PIECE_COLORS[idx] }}
                          >
                            <i style={{ backgroundColor: PIECE_COLORS[idx] }} />
                            {p.name} ({p.wins || 0}승 · {formatMoney(p.money || 0)})
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
              <h2 style={{ margin: '0 0 8px' }}>🎲 제 {joinModalRoom.roomId} 라스베가스룸 입장</h2>
              <p className="modal-subtext">
                이름을 입력하고 게임에 참가하거나, <strong>관망모드</strong>로 관전하세요!
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
        <div className="lv-container" style={{ background: PLAYER_BG_COLORS[0], display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
        <div className="lv-container" style={{ background: PLAYER_BG_COLORS[0] }}>
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
              🎲 라스베가스 대기실 {amISpectator ? '👀 [관망모드]' : ''}
            </h1>

            <div className="setting-section">
              <label className="setting-label">
                🏆 총 라운드 수 설정 {isHost ? '(방장 설정 가능)' : '(방장이 설정 중)'}
              </label>
              <div className="piece-count-selector" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                {[3, 4, 5].map((rVal) => (
                  <button
                    key={rVal}
                    type="button"
                    disabled={!isHost}
                    className={`count-btn ${activeNetRoom.totalRounds === rVal ? 'active' : ''}`}
                    onClick={() => updateRoomSettings(rVal, activeNetRoom.baseTimeout)}
                  >
                    {rVal}라운드
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
                    updateRoomSettings(activeNetRoom.totalRounds, Number(e.target.value))
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
                      {p.wins || 0}승 · {formatMoney(p.money || 0)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <button
              type="button"
              className="btn btn-success"
              disabled={roomPlayers.length < 2}
              onClick={() => handleStartNetRound('NEW_GAME')}
            >
              🚀 라스베가스 시작! ({roomPlayers.length}/4명)
            </button>
          </div>
        </div>
      );
    }

    const netCurrIdx = (activeNetRoom.currentPlayerIdx || 0) % Math.max(1, roomPlayers.length);
    const netCurrPlayer = roomPlayers[netCurrIdx];
    const isMyTurn =
      activeNetRoom.status === 'PLAYING' && netCurrPlayer?.id === mySessionId && !amISpectator;
    const myPlayerObj = roomPlayers.find((p) => p.id === mySessionId);
    const isRoundOrGameOver =
      activeNetRoom.status === 'ROUND_OVER' || activeNetRoom.status === 'GAME_OVER';

    return (
      <div
        className="lv-container"
        style={{ background: PLAYER_BG_COLORS[netCurrIdx % PLAYER_BG_COLORS.length] }}
      >
        {renderFireworksAndMoney()}

        {toast && (
          <div key={toast.id} className={`lv-toast ${toast.type}`}>
            {toast.text}
          </div>
        )}

        <div className="play-wrapper compact-tablet-mode">
          <div className="game-header compact-header">
            <div className="net-level-timer-box">
              <span className="net-level-badge">
                {activeNetRoom.roundNumber}/{activeNetRoom.totalRounds}R {amISpectator ? '👀' : ''}
              </span>
              {!isRoundOrGameOver && (
                <span className={`net-timer-badge ${remainingSeconds <= 10 ? 'urgent' : ''}`}>
                  ⏱️ {remainingSeconds}초
                </span>
              )}
            </div>

            <div className="player-status-bar">
              {roomPlayers.map((p, idx) => {
                const isActive = activeNetRoom.status === 'PLAYING' && idx === netCurrIdx;
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${isActive ? 'active-turn-spotlight' : ''} ${
                      p.remainingDice === 0 ? 'eliminated' : ''
                    }`}
                    style={{ borderColor: isActive ? p.color : 'transparent' }}
                  >
                    <div className="player-badge-top">
                      <span className="squircle-dot mini" style={{ backgroundColor: p.color }}>
                        {getShortName(p.name)}
                      </span>
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '👉 '}
                        {p.name}
                        {p.id === mySessionId ? '(나)' : ''}
                      </strong>
                      <span className="win-count-pill">🎲{p.remainingDice}개</span>
                      <span className="badge-score">💵{formatMoney(p.money || 0)}</span>
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
                ? '⏳ 현재 다음 게임 예약 대기 중입니다!'
                : `⏳ 다음 게임 예약자 (${roomWaitlist.length}명): ${roomWaitlist.map((w) => w.name).join(', ')}`}
            </div>
          )}

          <div className="lv-table-board">
            {isRoundOrGameOver ? (
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
                  {activeNetRoom.status === 'ROUND_OVER' ? (
                    <button
                      type="button"
                      className="btn btn-success"
                      style={{ width: 'auto', padding: '6px 18px', fontSize: '14px' }}
                      onClick={() => handleStartNetRound('NEXT_ROUND')}
                    >
                      ➡️ 다음 라운드 시작 ({activeNetRoom.roundNumber + 1}/{activeNetRoom.totalRounds}R)
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-success"
                      style={{ width: 'auto', padding: '6px 18px', fontSize: '14px' }}
                      onClick={() => handleStartNetRound('NEW_GAME')}
                    >
                      🔥 새 게임 시작 (승수 누적)
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div key={activeNetRoom.turnNotice} className="lv-notice-banner">
                {activeNetRoom.turnNotice}
              </div>
            )}

            {renderCasinosBoard(
              activeNetRoom.casinos,
              roomPlayers,
              myPlayerObj,
              isMyTurn,
              handleNetPlaceDice
            )}
          </div>

          {amISpectator && (
            <div className="lv-bottom-dock">
              <div className="waiting-dock-msg">
                👀 관망모드 중입니다. 현재 <strong>{netCurrPlayer?.name}</strong>님의 턴입니다.
              </div>
            </div>
          )}

          {myPlayerObj && !amISpectator && (
            <div
              className="lv-bottom-dock"
              style={{ borderTop: `4px solid ${myPlayerObj.color}` }}
            >
              {activeNetRoom.status === 'PLAYING' && (
                <>
                  {isMyTurn ? (
                    !myPlayerObj.hasRolledThisTurn ? (
                      <button
                        type="button"
                        className="btn btn-success lv-roll-btn"
                        onClick={handleNetRollDice}
                      >
                        🎲 내 주사위 {myPlayerObj.remainingDice}개 굴리기!
                      </button>
                    ) : (
                      <div className="lv-rolled-panel">
                        <div className="lv-rolled-dice-list">
                          {myPlayerObj.rolledDice.map((val, idx) => (
                            <span
                              key={idx}
                              className="lv-die-token"
                              style={{ borderColor: myPlayerObj.color, color: myPlayerObj.color }}
                            >
                              {renderDiceFaces(val)}
                            </span>
                          ))}
                        </div>
                        <div className="lv-number-select-row">
                          {CASINO_NUMBERS.map((num) => {
                            const cnt = myPlayerObj.rolledDice.filter((d) => d === num).length;
                            return (
                              <button
                                key={num}
                                type="button"
                                disabled={cnt === 0}
                                className={`lv-pick-num-btn ${cnt > 0 ? 'available' : ''}`}
                                onClick={() => handleNetPlaceDice(num)}
                              >
                                {num}번 ({cnt}개)
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )
                  ) : (
                    <div className="waiting-dock-msg">
                      ⏳ 현재 <strong>{netCurrPlayer?.name}</strong>님의 차례입니다. (내 남은 주사위: {myPlayerObj.remainingDice}개)
                    </div>
                  )}
                </>
              )}

              {isRoundOrGameOver && (
                <div className="waiting-dock-msg">
                  🏆 상단의 버튼을 눌러 다음 라운드 또는 새 게임을 진행하세요!
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // =========================================================================
  // 5. 단독게임(SOLO)
  // =========================================================================
  const currentPlayer = players[currentPlayerIdx] || players[0];
  const currentBackground =
    gameState === 'PLAYING' && players.length > 0
      ? PLAYER_BG_COLORS[currentPlayerIdx % PLAYER_BG_COLORS.length]
      : PLAYER_BG_COLORS[0];
  const isSoloRoundOrGameOver = gameState === 'ROUND_OVER' || gameState === 'GAME_OVER';

  return (
    <div className="lv-container" style={{ background: currentBackground }}>
      {renderFireworksAndMoney()}

      {toast && (
        <div key={toast.id} className={`lv-toast ${toast.type}`}>
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
          <h1 className="setup-title">🎲 라스베가스 (단독게임 설정)</h1>

          <div className="setting-section">
            <label className="setting-label">🏆 총 라운드 수 설정</label>
            <div className="piece-count-selector" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {[3, 4, 5].map((val) => (
                <button
                  key={val}
                  type="button"
                  className={`count-btn ${totalRoundsOption === val ? 'active' : ''}`}
                  onClick={() => setTotalRoundsOption(val)}
                >
                  {val}라운드
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
            <label className="setting-label">🧭 플레이어 등록 (2~4명)</label>
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
            <button
              type="button"
              className="btn btn-success"
              onClick={() => startSoloRound('NEW_GAME')}
            >
              🚀 라스베가스 시작!
            </button>
          </div>
        </div>
      )}

      {(gameState === 'PLAYING' || gameState === 'ROUND_OVER' || gameState === 'GAME_OVER') &&
        currentPlayer && (
          <div className="play-wrapper compact-tablet-mode">
            <div className="game-header compact-header">
              <div className="net-level-timer-box">
                <span className="net-level-badge">
                  {soloRoundNum}/{totalRoundsOption}R
                </span>
                {!isSoloRoundOrGameOver && (
                  <span className={`net-timer-badge ${soloRemainingSec <= 10 ? 'urgent' : ''}`}>
                    ⏱️ {soloRemainingSec}초
                  </span>
                )}
              </div>

              <div className="player-status-bar">
                {players.map((p, idx) => {
                  const isActive = !isSoloRoundOrGameOver && idx === currentPlayerIdx;
                  return (
                    <div
                      key={p.id}
                      className={`player-badge-card ${isActive ? 'active-turn-spotlight' : ''} ${
                        p.remainingDice === 0 ? 'eliminated' : ''
                      }`}
                      style={{ borderColor: isActive ? p.color : 'transparent' }}
                    >
                      <div className="player-badge-top">
                        <span className="squircle-dot mini" style={{ backgroundColor: p.color }}>
                          {getShortName(p.name)}
                        </span>
                        <strong className={isActive ? 'turn-hero-name' : ''}>
                          {isActive && '👉 '}
                          {p.name}
                        </strong>
                        <span className="win-count-pill">🎲{p.remainingDice}개</span>
                        <span className="badge-score">💵{formatMoney(p.money)}</span>
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

            <div className="lv-table-board">
              {isSoloRoundOrGameOver ? (
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
                    {gameState === 'ROUND_OVER' ? (
                      <button
                        type="button"
                        className="btn btn-success"
                        style={{ width: 'auto', padding: '6px 18px', fontSize: '14px' }}
                        onClick={() => startSoloRound('NEXT_ROUND')}
                      >
                        ➡️ 다음 라운드 시작 ({soloRoundNum + 1}/{totalRoundsOption}R)
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-success"
                        style={{ width: 'auto', padding: '6px 18px', fontSize: '14px' }}
                        onClick={() => startSoloRound('NEW_GAME')}
                      >
                        🔥 새 게임 시작 (승수 누적)
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div key={turnNotice} className="lv-notice-banner">
                  {turnNotice}
                </div>
              )}

              {renderCasinosBoard(
                casinos,
                players,
                currentPlayer,
                gameState === 'PLAYING',
                handleSoloPlaceDice
              )}
            </div>

            <div
              className="lv-bottom-dock"
              style={{ borderTop: `4px solid ${currentPlayer.color}` }}
            >
              <div className="dock-top-status">
                <span
                  className="turn-owner-pill large-turn-pill"
                  style={{ backgroundColor: currentPlayer.color }}
                >
                  👉 {currentPlayer.name}님 차례 · 🏆{currentPlayer.wins}승 · 💵
                  {formatMoney(currentPlayer.money)} · 🎲남은 주사위 {currentPlayer.remainingDice}개
                </span>
              </div>

              {gameState === 'PLAYING' && (
                <>
                  {!currentPlayer.hasRolledThisTurn ? (
                    <button
                      type="button"
                      className="btn btn-success lv-roll-btn"
                      onClick={handleSoloRollDice}
                    >
                      🎲 주사위 {currentPlayer.remainingDice}개 굴리기!
                    </button>
                  ) : (
                    <div className="lv-rolled-panel">
                      <div className="lv-rolled-dice-list">
                        {currentPlayer.rolledDice.map((val, idx) => (
                          <span
                            key={idx}
                            className="lv-die-token"
                            style={{
                              borderColor: currentPlayer.color,
                              color: currentPlayer.color,
                            }}
                          >
                            {renderDiceFaces(val)}
                          </span>
                        ))}
                      </div>
                      <div className="lv-number-select-row">
                        {CASINO_NUMBERS.map((num) => {
                          const cnt = currentPlayer.rolledDice.filter((d) => d === num).length;
                          return (
                            <button
                              key={num}
                              type="button"
                              disabled={cnt === 0}
                              className={`lv-pick-num-btn ${cnt > 0 ? 'available' : ''}`}
                              onClick={() => handleSoloPlaceDice(num)}
                            >
                              {num}번 ({cnt}개)
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}

              {isSoloRoundOrGameOver && (
                <div className="waiting-dock-msg">
                  🎉 상단의 버튼을 눌러 다음 라운드 또는 새 게임을 시작하세요!
                </div>
              )}
            </div>
          </div>
        )}
    </div>
  );
}