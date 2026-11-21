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
import './Page6.css';

interface NoThanksPlayer {
  id: string;
  name: string;
  badgeColor: string;
  cards: number[]; // 획득한 숫자 카드들 (오름차순 정렬)
  tokens: number; // 라운드 내 패스용 코인(토큰) 개수
  chips: number; // 판돈용 보유 머니(칩)
  wins: number; // 누적 승수 (1승, 2승...)
  currentBet: number; // 이번 라운드에 건 동일 판돈
  isEliminated: boolean; // 판돈 소진 시 아웃 여부
}

interface WaitlistPlayer {
  id: string;
  name: string;
}

interface SpectatorPlayer {
  id: string;
  name: string;
}

interface NetNoThanksRoomData {
  roomId: number;
  status: 'EMPTY' | 'WAITING' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER';
  players: NoThanksPlayer[];
  pot: number; // 동일 판돈이 모인 총 상금
  waitlist: WaitlistPlayer[];
  spectators: SpectatorPlayer[];
  baseTimeout: number;
  anteBet: number; // 라운드당 전원 동일 판돈
  roundNumber: number;
  deck: number[]; // 남은 덱 (24장)
  currentCard: number | null; // 현재 테이블 중앙에 오픈된 카드
  centerTokens: number; // 현재 중앙 카드 위에 쌓인 패스용 코인 개수
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
const DEFAULT_TIMEOUT_SEC = 60;

function getShortName(name: string): string {
  const trimmed = name ? name.trim() : '';
  return trimmed ? trimmed.slice(0, 2) : '?';
}

/**
 * 노땡스 덱 생성: 3 ~ 35까지 총 33장을 섞은 뒤, 9장을 비공개로 제거하여 24장 반환
 */
function createNoThanksDeck(): number[] {
  const allCards: number[] = [];
  for (let n = 3; n <= 35; n++) {
    allCards.push(n);
  }
  const shuffled = allCards.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 24);
}

/**
 * 인원수별 기본 지급 패스용 코인(토큰) 개수
 */
function getInitialTokensByPlayerCount(count: number): number {
  if (count <= 5) return 11;
  if (count === 6) return 9;
  return 7;
}

/**
 * 노땡스 점수 계산 (낮을수록 유리)
 * - 연속된 숫자들은 가장 작은 숫자만 점수에 합산
 * - 보유한 패스용 코인 1개당 -1점
 */
function calculateNoThanksScore(cards: number[], tokens: number): {
  cardPoints: number;
  finalScore: number;
  sequences: number[][];
} {
  const sorted = [...(cards || [])].sort((a, b) => a - b);
  const sequences: number[][] = [];
  let cardPoints = 0;

  for (const num of sorted) {
    const lastSeq = sequences[sequences.length - 1];
    if (lastSeq && lastSeq[lastSeq.length - 1] + 1 === num) {
      lastSeq.push(num);
    } else {
      sequences.push([num]);
      cardPoints += num;
    }
  }

  return {
    cardPoints,
    finalScore: cardPoints - (tokens || 0),
    sequences,
  };
}

function getNextAlivePlayerIdx(players: NoThanksPlayer[], currentIdx: number): number {
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

function createDefaultNoThanksRoom(roomId: number): NetNoThanksRoomData {
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
    deck: [],
    currentCard: null,
    centerTokens: 0,
    currentPlayerIdx: 0,
    turnDeadline: null,
    turnNotice: '',
    winnerAnnouncement: '',
    roundWinnerId: null,
    waitingSince: null,
  };
}

export default function Page6() {
  const [appMode, setAppMode] = useState<
    'HOME' | 'SOLO' | 'NET_LOBBY' | 'NET_ROOM' | 'HALL_OF_FAME'
  >('HOME');

  const [mySessionId] = useState<string>(() => {
    const saved = sessionStorage.getItem('nothanks_net_uid');
    if (saved) return saved;
    const generated = `nt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('nothanks_net_uid', generated);
    return generated;
  });

  // 넷게임 상태
  const [rooms, setRooms] = useState<NetNoThanksRoomData[]>([1, 2, 3, 4].map(createDefaultNoThanksRoom));
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [joinModalRoom, setJoinModalRoom] = useState<NetNoThanksRoomData | null>(null);
  const [joinPlayerName, setJoinPlayerName] = useState<string>('');
  const [remainingSeconds, setRemainingSeconds] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [waitingCountdownSec, setWaitingCountdownSec] = useState<number>(420);
  const timeoutHandledRef = useRef<number | null>(null);
  const lastSpokenNoticeRef = useRef<string>('');
  const lastCountdownSpokenRef = useRef<number | null>(null);

  // 단독게임(SOLO) 상태
  const [gameState, setGameState] = useState<'SETUP' | 'READY' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER'>(
    'SETUP'
  );
  const [players, setPlayers] = useState<NoThanksPlayer[]>([
    {
      id: '1',
      name: '타짜',
      badgeColor: PIECE_COLORS[0],
      cards: [],
      tokens: 11,
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
    },
    {
      id: '2',
      name: '고니',
      badgeColor: PIECE_COLORS[1],
      cards: [],
      tokens: 11,
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
    },
    {
      id: '3',
      name: '아귀',
      badgeColor: PIECE_COLORS[2],
      cards: [],
      tokens: 11,
      chips: INITIAL_CHIPS,
      wins: 0,
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

  const [deck, setDeck] = useState<number[]>([]);
  const [currentCard, setCurrentCard] = useState<number | null>(null);
  const [centerTokens, setCenterTokens] = useState<number>(0);
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

  const playSound = (kind: 'take' | 'pass' | 'chip' | 'win' | 'tick') => {
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
        take: [440, 587.33],
        pass: [659.25, 523.25],
        chip: [880, 1174.66],
        win: [523.25, 659.25, 783.99, 1046.5, 1318.5],
        tick: [987.77],
      };

      notesMap[kind].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === 'pass' ? 'triangle' : kind === 'chip' ? 'sine' : 'triangle';
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
    const key = type === 'SOLO' ? 'nothanks_hof_solo' : 'nothanks_hof_net';
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
    const key = type === 'SOLO' ? 'nothanks_hof_solo' : 'nothanks_hof_net';
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
      const roomRef = ref(db, `nothanks_rooms/room_${roomIdToLeave}`);
      try {
        await runTransaction(roomRef, (roomData) => {
          if (!roomData) return roomData;
          const room = roomData as NetNoThanksRoomData;
          const filteredPlayers = (room.players || []).filter((p) => p.id !== mySessionId);
          const filteredWaitlist = (room.waitlist || []).filter((w) => w.id !== mySessionId);
          const filteredSpectators = (room.spectators || []).filter((s) => s.id !== mySessionId);

          if (filteredPlayers.length === 0 && filteredSpectators.length === 0) {
            return createDefaultNoThanksRoom(room.roomId);
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

  // =========================================================================
  // 인터넷 창/탭 닫기 시 해당 방에서 즉시 나가기 처리
  // =========================================================================
  useEffect(() => {
    if (appMode !== 'NET_ROOM' || !selectedRoomId) return;

    const presenceRef = ref(db, `nothanks_presence/room_${selectedRoomId}/${mySessionId}`);
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
        const roomRef = ref(db, `nothanks_rooms/room_${id}`);
        const snap = await get(roomRef);
        if (!snap.exists()) {
          await set(roomRef, createDefaultNoThanksRoom(id));
        }
      }
    };
    ensureRoomsExist();

    const roomsRef = ref(db, 'nothanks_rooms');
    const unsubscribe = onValue(roomsRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      const loadedRooms: NetNoThanksRoomData[] = [1, 2, 3, 4].map((id) => {
        const rData = data[`room_${id}`];
        const def = createDefaultNoThanksRoom(id);
        if (!rData) return def;
        return {
          ...def,
          ...rData,
          players: (rData.players || []).map((p: NoThanksPlayer) => ({
            ...p,
            cards: p.cards || [],
            tokens: typeof p.tokens === 'number' ? p.tokens : 11,
            chips: typeof p.chips === 'number' ? p.chips : INITIAL_CHIPS,
            wins: typeof p.wins === 'number' ? p.wins : 0,
            currentBet: typeof p.currentBet === 'number' ? p.currentBet : 0,
            isEliminated: Boolean(p.isEliminated),
          })),
          pot: typeof rData.pot === 'number' ? rData.pot : 0,
          waitlist: rData.waitlist || [],
          spectators: rData.spectators || [],
          deck: rData.deck || [],
          currentCard: typeof rData.currentCard === 'number' ? rData.currentCard : null,
          centerTokens: typeof rData.centerTokens === 'number' ? rData.centerTokens : 0,
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
          const roomRef = ref(db, `nothanks_rooms/room_${activeNetRoom.roomId}`);
          await set(roomRef, createDefaultNoThanksRoom(activeNetRoom.roomId));
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
          if (actor && actor.tokens > 0) {
            handleSoloPassCard();
          } else {
            handleSoloTakeCard();
          }
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [appMode, gameState, currentPlayerIdx, soloTimeoutSec, players]);

  const handleEnterRoomSubmit = async (asSpectator = false) => {
    if (!joinModalRoom) return;
    const trimmedName = joinPlayerName ? joinPlayerName.trim() : '';
    if (!trimmedName) {
      alert('참가할 이름을 입력해주세요!');
      return;
    }

    const roomRef = ref(db, `nothanks_rooms/room_${joinModalRoom.roomId}`);

    try {
      let joinResultType = 'PLAYER';

      await runTransaction(roomRef, (roomData) => {
        const room: NetNoThanksRoomData = roomData || createDefaultNoThanksRoom(joinModalRoom.roomId);
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
          const newPlayer: NoThanksPlayer = {
            id: mySessionId,
            name: trimmedName,
            badgeColor: PIECE_COLORS[idx],
            cards: [],
            tokens: 11,
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
        showToast('👀 관망모드로 입장했습니다! 패스용 코인 개수는 비공개 보호됩니다.', 'info');
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
    const roomRef = ref(db, `nothanks_rooms/room_${activeNetRoom.roomId}`);
    await update(roomRef, {
      anteBet: newAnteBet,
      baseTimeout: clampedTimeout,
      waitingSince: Date.now(),
    });
  };

  /**
   * 넷게임 라운드 시작
   */
  const handleStartNetRound = async (isNextRound = false) => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `nothanks_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetNoThanksRoomData;
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
      const nextActive: NoThanksPlayer[] = [...survivingPlayers];
      const remainingWaitlist: WaitlistPlayer[] = [];

      for (const w of waitlist) {
        if (nextActive.length + eliminatedPlayers.length < 4) {
          nextActive.push({
            id: w.id,
            name: w.name,
            badgeColor: PIECE_COLORS[0],
            cards: [],
            tokens: 11,
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
      const tokenCount = getInitialTokensByPlayerCount(nextActive.length);
      let collectedPot = isNewMatch ? 0 : room.pot || 0;

      const activeWithBet = nextActive.map((p) => {
        const pay = equalStake;
        collectedPot += pay;
        return {
          ...p,
          cards: [],
          tokens: tokenCount,
          chips: p.chips - pay,
          currentBet: pay,
          isEliminated: false,
        };
      });

      const mergedPlayers = [...activeWithBet, ...eliminatedPlayers].map((p, idx) => ({
        ...p,
        badgeColor: PIECE_COLORS[idx % PIECE_COLORS.length],
      }));

      const deckCopy = createNoThanksDeck();
      const firstCard = deckCopy.shift() ?? 3;

      room.status = 'PLAYING';
      room.roundNumber = nextRound;
      room.players = mergedPlayers;
      room.pot = collectedPot;
      room.waitlist = remainingWaitlist;
      room.deck = deckCopy;
      room.currentCard = firstCard;
      room.centerTokens = 0;
      room.currentPlayerIdx = 0;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.winnerAnnouncement = '';
      room.roundWinnerId = null;
      room.turnNotice = `💰 [${nextRound}라운드] 전원 동일 판돈 ${equalStake.toLocaleString()}칩 베팅! 총 판돈 ${collectedPot.toLocaleString()}칩! ${mergedPlayers[0].name}님 차례 (오픈 카드: ${firstCard})`;
      room.waitingSince = null;

      return room;
    });

    triggerChipAnimation('전원', activeNetRoom.anteBet, '#f59e0b');
  };

  /**
   * 라운드 종료 정산 헬퍼
   */
  const settleNoThanksRound = (room: NetNoThanksRoomData) => {
    const alivePlayers = room.players.filter((p) => !p.isEliminated);
    let bestPlayer = alivePlayers[0];
    let bestScore = Infinity;

    for (const p of alivePlayers) {
      const { finalScore } = calculateNoThanksScore(p.cards, p.tokens);
      if (finalScore < bestScore) {
        bestScore = finalScore;
        bestPlayer = p;
      } else if (finalScore === bestScore && p.tokens > bestPlayer.tokens) {
        bestPlayer = p;
      }
    }

    const wonPot = room.pot || 0;
    room.players = room.players.map((p) => {
      if (p.isEliminated) return p;
      const isWinner = p.id === bestPlayer.id;
      const updatedChips = isWinner ? p.chips + wonPot : p.chips;
      const busted = updatedChips <= 0;
      return {
        ...p,
        chips: updatedChips,
        wins: isWinner ? (p.wins || 0) + 1 : p.wins || 0,
        isEliminated: busted,
      };
    });

    const remainingAlive = room.players.filter((p) => !p.isEliminated);
    const bustedNames = room.players.filter((p) => p.isEliminated).map((p) => p.name);
    const bustText =
      bustedNames.length > 0 ? ` · 💀 ${bustedNames.join(', ')}님 판돈 소진 아웃!` : '';

    const winnerObj = room.players.find((p) => p.id === bestPlayer.id)!;
    room.pot = 0;
    room.currentCard = null;
    room.centerTokens = 0;
    room.turnDeadline = null;
    room.turnNotice = '';
    room.roundWinnerId = bestPlayer.id;

    if (remainingAlive.length <= 1) {
      room.status = 'MATCH_OVER';
      room.winnerAnnouncement = `👑 최종 우승! ${bestPlayer.name}님이 ${bestScore}점으로 판돈 ${wonPot.toLocaleString()}칩을 독식하며 최후의 승자가 되었습니다!${bustText}`;
    } else {
      room.status = 'ROUND_OVER';
      room.winnerAnnouncement = `🎊 ${bestPlayer.name}님 ${bestScore}점 최저점 승리! 판돈 ${wonPot.toLocaleString()}칩 독식! (${winnerObj.wins}승 · 누적 ${winnerObj.chips.toLocaleString()}칩)${bustText}`;
    }

    saveHallOfFameRecord('NET', {
      name: bestPlayer.name,
      scoreOrLevel: `${winnerObj.wins}승 · 보유 ${winnerObj.chips.toLocaleString()}칩`,
    });
  };

  /**
   * 넷게임: 카드 가져오기
   */
  const handleNetTakeCard = async () => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const idx = activeNetRoom.currentPlayerIdx;
    const actor = activeNetRoom.players[idx];
    if (!actor || actor.id !== mySessionId || actor.isEliminated) return;

    playSound('take');
    const roomRef = ref(db, `nothanks_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetNoThanksRoomData;
      if (room.status !== 'PLAYING' || room.currentCard === null) return room;

      const cIdx = room.currentPlayerIdx;
      const p = room.players[cIdx];
      if (!p || p.id !== mySessionId) return room;

      const takenCard = room.currentCard;
      const takenTokens = room.centerTokens || 0;
      const nextCards = [...(p.cards || []), takenCard].sort((a, b) => a - b);

      room.players[cIdx] = {
        ...p,
        cards: nextCards,
        tokens: (p.tokens || 0) + takenTokens,
      };

      const deckCopy = [...(room.deck || [])];
      if (deckCopy.length === 0) {
        settleNoThanksRound(room);
        return room;
      }

      const nextOpenCard = deckCopy.shift()!;
      room.deck = deckCopy;
      room.currentCard = nextOpenCard;
      room.centerTokens = 0;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `🃏 ${p.name}님이 [${takenCard}] 카드와 코인 ${takenTokens}개를 가져갔습니다! 다음 카드 [${nextOpenCard}]에 대해 ${p.name}님이 계속 선택합니다.`;
      return room;
    });
  };

  /**
   * 넷게임: 노땡스! 패스하기
   */
  const handleNetPassCard = async () => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const idx = activeNetRoom.currentPlayerIdx;
    const actor = activeNetRoom.players[idx];
    if (!actor || actor.id !== mySessionId || actor.isEliminated || actor.tokens <= 0) return;

    playSound('pass');
    const roomRef = ref(db, `nothanks_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetNoThanksRoomData;
      if (room.status !== 'PLAYING' || room.currentCard === null) return room;

      const cIdx = room.currentPlayerIdx;
      const p = room.players[cIdx];
      if (!p || p.id !== mySessionId || p.tokens <= 0) return room;

      room.players[cIdx] = {
        ...p,
        tokens: p.tokens - 1,
      };
      room.centerTokens = (room.centerTokens || 0) + 1;

      const nextIdx = getNextAlivePlayerIdx(room.players, cIdx);
      const nextPlayer = room.players[nextIdx];
      room.currentPlayerIdx = nextIdx;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `🙅‍♂️ ${p.name}님이 "노땡스!" 코인 1개를 올렸습니다. (카드 [${room.currentCard}] 위 코인 ${room.centerTokens}개) 👉 ${nextPlayer.name}님 차례!`;
      return room;
    });
  };

  const handleNetTurnTimeout = async (room: NetNoThanksRoomData) => {
    const roomRef = ref(db, `nothanks_rooms/room_${room.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const r = roomData as NetNoThanksRoomData;
      if (r.status !== 'PLAYING' || r.currentCard === null) return r;

      const cIdx = r.currentPlayerIdx;
      const p = r.players[cIdx];
      if (!p) return r;

      if (p.tokens > 0) {
        r.players[cIdx] = { ...p, tokens: p.tokens - 1 };
        r.centerTokens = (r.centerTokens || 0) + 1;
        const nextIdx = getNextAlivePlayerIdx(r.players, cIdx);
        r.currentPlayerIdx = nextIdx;
        r.turnDeadline = Date.now() + r.baseTimeout * 1000;
        r.turnNotice = `⏰ 시간 초과로 ${p.name}님이 자동 노땡스(코인 1개) 처리되었습니다. 👉 ${r.players[nextIdx].name}님 차례!`;
      } else {
        const takenCard = r.currentCard;
        const takenTokens = r.centerTokens || 0;
        r.players[cIdx] = {
          ...p,
          cards: [...(p.cards || []), takenCard].sort((a, b) => a - b),
          tokens: p.tokens + takenTokens,
        };
        const deckCopy = [...(r.deck || [])];
        if (deckCopy.length === 0) {
          settleNoThanksRound(r);
          return r;
        }
        const nextOpen = deckCopy.shift()!;
        r.deck = deckCopy;
        r.currentCard = nextOpen;
        r.centerTokens = 0;
        r.turnDeadline = Date.now() + r.baseTimeout * 1000;
        r.turnNotice = `⏰ 시간 초과 & 코인 소진으로 ${p.name}님이 [${takenCard}] 카드를 가져갔습니다.`;
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
        cards: [],
        tokens: 11,
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
      showToast('노땡스는 최소 2명 이상의 플레이어가 필요합니다!', 'info');
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
        cards: [],
        chips,
        wins: isFreshMatch ? 0 : p.wins,
        currentBet: 0,
        isEliminated: eliminated,
      };
    });

    const alivePlayers = checkedPlayers.filter((p) => !p.isEliminated);
    if (alivePlayers.length < 2) return;

    const equalStake = Math.min(soloAnteBet, ...alivePlayers.map((p) => p.chips));
    const initialTokens = getInitialTokensByPlayerCount(alivePlayers.length);
    let totalPot = isFreshMatch ? 0 : soloPot;

    const preparedPlayers = checkedPlayers.map((p) => {
      if (p.isEliminated) return p;
      totalPot += equalStake;
      return {
        ...p,
        tokens: initialTokens,
        chips: p.chips - equalStake,
        currentBet: equalStake,
      };
    });

    const deckCopy = createNoThanksDeck();
    const firstCard = deckCopy.shift() ?? 3;
    const firstAliveIdx = preparedPlayers.findIndex((p) => !p.isEliminated);

    triggerChipAnimation('전원', equalStake, '#f59e0b');
    const notice = `💰 [${nextRound}라운드] 전원 동일 판돈 ${equalStake.toLocaleString()}칩 베팅! 총 판돈 ${totalPot.toLocaleString()}칩! ${preparedPlayers[firstAliveIdx].name}님 차례 (카드: ${firstCard})`;

    setSoloRoundNum(nextRound);
    setSoloPot(totalPot);
    setPlayers(preparedPlayers);
    setDeck(deckCopy);
    setCurrentCard(firstCard);
    setCenterTokens(0);
    setCurrentPlayerIdx(firstAliveIdx);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setWinnerAnnouncement('');
    setShowFireworks(false);
    setTurnNotice(notice);
    speakKorean(notice);
    setGameState('PLAYING');
  };

  const settleSoloRound = (finalPlayers: NoThanksPlayer[]) => {
    const alive = finalPlayers.filter((p) => !p.isEliminated);
    let bestPlayer = alive[0];
    let bestScore = Infinity;

    for (const p of alive) {
      const { finalScore } = calculateNoThanksScore(p.cards, p.tokens);
      if (finalScore < bestScore) {
        bestScore = finalScore;
        bestPlayer = p;
      } else if (finalScore === bestScore && p.tokens > bestPlayer.tokens) {
        bestPlayer = p;
      }
    }

    const settledPlayers = finalPlayers.map((p) => {
      if (p.isEliminated) return p;
      const isWinner = p.id === bestPlayer.id;
      const updatedChips = isWinner ? p.chips + soloPot : p.chips;
      const busted = updatedChips <= 0;
      return {
        ...p,
        chips: updatedChips,
        wins: isWinner ? p.wins + 1 : p.wins,
        isEliminated: busted,
      };
    });

    const winnerObj = settledPlayers.find((p) => p.id === bestPlayer.id)!;
    const remainingAlive = settledPlayers.filter((p) => !p.isEliminated);
    const bustedNames = settledPlayers.filter((p) => p.isEliminated).map((p) => p.name);
    const bustText =
      bustedNames.length > 0 ? ` · 💀 ${bustedNames.join(', ')}님 판돈 소진 아웃!` : '';

    const announcement =
      remainingAlive.length <= 1
        ? `👑 최종 우승! ${bestPlayer.name}님이 ${bestScore}점으로 판돈 ${soloPot.toLocaleString()}칩을 독식하며 최후의 승자가 되었습니다!${bustText}`
        : `🎊 ${bestPlayer.name}님 ${bestScore}점 최저점 승리! 판돈 ${soloPot.toLocaleString()}칩 독식! (${winnerObj.wins}승 · 누적 ${winnerObj.chips.toLocaleString()}칩)${bustText}`;

    setPlayers(settledPlayers);
    setSoloPot(0);
    setCurrentCard(null);
    setCenterTokens(0);
    setTurnNotice('');
    setWinnerAnnouncement(announcement);
    setGameState(remainingAlive.length <= 1 ? 'MATCH_OVER' : 'ROUND_OVER');
    triggerFireworksCelebration(announcement);

    saveHallOfFameRecord('SOLO', {
      name: bestPlayer.name,
      scoreOrLevel: `${winnerObj.wins}승 · 보유 ${winnerObj.chips.toLocaleString()}칩`,
    });
  };

  const handleSoloTakeCard = () => {
    if (gameState !== 'PLAYING' || currentCard === null) return;
    const actor = players[currentPlayerIdx];
    playSound('take');

    const updatedPlayers = players.map((p, idx) =>
      idx === currentPlayerIdx
        ? {
            ...p,
            cards: [...p.cards, currentCard].sort((a, b) => a - b),
            tokens: p.tokens + centerTokens,
          }
        : p
    );

    if (deck.length === 0) {
      settleSoloRound(updatedPlayers);
      return;
    }

    const deckCopy = [...deck];
    const nextOpenCard = deckCopy.shift()!;
    const notice = `🃏 ${actor.name}님이 [${currentCard}] 카드와 코인 ${centerTokens}개를 가져갔습니다! 다음 카드 [${nextOpenCard}]에 대해 ${actor.name}님이 계속 선택합니다.`;

    setPlayers(updatedPlayers);
    setDeck(deckCopy);
    setCurrentCard(nextOpenCard);
    setCenterTokens(0);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setTurnNotice(notice);
    speakKorean(notice);
  };

  const handleSoloPassCard = () => {
    if (gameState !== 'PLAYING' || currentCard === null) return;
    const actor = players[currentPlayerIdx];
    if (actor.tokens <= 0) {
      showToast('패스용 코인이 없습니다! 카드를 가져가야 합니다.', 'danger');
      return;
    }

    playSound('pass');
    const updatedPlayers = players.map((p, idx) =>
      idx === currentPlayerIdx ? { ...p, tokens: p.tokens - 1 } : p
    );
    const nextCenterTokens = centerTokens + 1;
    const nextIdx = getNextAlivePlayerIdx(updatedPlayers, currentPlayerIdx);
    const notice = `🙅‍♂️ ${actor.name}님이 "노땡스!" 코인 1개를 올렸습니다. (카드 [${currentCard}] 위 코인 ${nextCenterTokens}개) 👉 ${updatedPlayers[nextIdx].name}님 차례!`;

    setPlayers(updatedPlayers);
    setCenterTokens(nextCenterTokens);
    setCurrentPlayerIdx(nextIdx);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setTurnNotice(notice);
    speakKorean(notice);
  };

  // =========================================================================
  // 공용 UI 렌더링 헬퍼 (물리적 코인, 쌓인 카드 덱, 획득 시퀀스, 폭죽 이펙트)
  // =========================================================================

  /**
   * 물리적인 동그란 금빛 코인 여러 개를 쌓아 보여주는 컴포넌트
   */
  const renderPhysicalCoinPile = (count: number, size: 'sm' | 'md' = 'sm') => {
    const visibleCoins = Math.min(count, size === 'sm' ? 11 : 14);
    return (
      <div className={`physical-coin-stack ${size}`} title={`코인 ${count}개`}>
        {Array.from({ length: visibleCoins }).map((_, idx) => (
          <span
            key={idx}
            className="physical-gold-coin"
            style={{
              marginLeft: idx === 0 ? 0 : size === 'sm' ? '-7px' : '-9px',
              zIndex: idx + 1,
            }}
          >
            <i />
          </span>
        ))}
        <span className="coin-count-label">{count}</span>
      </div>
    );
  };

  /**
   * 메인 카드 + 뒤에 쌓여 있는 덱 두께 + 카드 하단(숫자 안 가리는 영역)에 올라간 물리적 코인 렌더링
   */
  const renderMainCardWithStackedDeckAndCoins = (
    cardNumber: number,
    remainingDeckCount: number,
    coinsOnCard: number
  ) => {
    // 남은 덱 장수에 따라 뒤에 최대 4겹까지 종이 카드 두께 표현
    const stackLayers = Math.min(4, Math.ceil(remainingDeckCount / 5));

    return (
      <div className="nt-card-showcase">
        {/* 왼쪽: 남은 카드 더미 (실제 여러 장 겹쳐진 덱 모양) */}
        <div className="nt-deck-pile-wrapper">
          <div className={`nt-deck-stack-box layers-${stackLayers}`}>
            {stackLayers >= 3 && <div className="deck-under-card layer-3" />}
            {stackLayers >= 2 && <div className="deck-under-card layer-2" />}
            {stackLayers >= 1 && <div className="deck-under-card layer-1" />}
            <div className="nt-deck-top-back">
              <span className="deck-back-title">NO THANKS</span>
              <strong>{remainingDeckCount}장</strong>
            </div>
          </div>
          <span className="deck-caption">남은 카드 덱</span>
        </div>

        {/* 중앙: 메인 오픈 카드 (뒤에 남은 덱 두께 + 카드 하단에 숫자를 가리지 않고 올라간 동그란 코인들) */}
        <div className="nt-main-card-stage">
          {stackLayers >= 3 && <div className="main-card-stack-sheet sheet-3" />}
          {stackLayers >= 2 && <div className="main-card-stack-sheet sheet-2" />}
          {stackLayers >= 1 && <div className="main-card-stack-sheet sheet-1" />}

          <div className="nt-main-number-card">
            <span className="corner-num top">{cardNumber}</span>
            <span className="corner-num top-right">{cardNumber}</span>

            {/* 중앙 숫자 (하단 코인이 겹치지 않도록 상단~중단에 선명하게 배치) */}
            <div className="card-number-safe-zone">
              <strong className="center-big-num">{cardNumber}</strong>
            </div>

            {/* 카드 하단 코인 트레이: 실제 카드 위에 동그란 코인들이 올라가 있는 모습 (숫자 가림 없음) */}
            <div className="card-on-coins-tray">
              {coinsOnCard === 0 ? (
                <span className="no-coins-placeholder">코인 없음</span>
              ) : (
                <>
                  <div className="card-coins-cluster">
                    {Array.from({ length: Math.min(coinsOnCard, 12) }).map((_, idx) => (
                      <span
                        key={idx}
                        className="physical-gold-coin on-card-coin"
                        style={{
                          marginLeft: idx === 0 ? 0 : '-10px',
                          transform: `translateY(${idx % 2 === 0 ? '0px' : '-2px'})`,
                          zIndex: idx + 1,
                        }}
                      >
                        <i />
                      </span>
                    ))}
                  </div>
                  <span className="on-card-coin-badge">+{coinsOnCard}개</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* 오른쪽: 현재 카드에 쌓인 코인 안내 */}
        <div className="nt-center-tokens-box">
          <span>카드 위 보너스 코인</span>
          {coinsOnCard > 0 ? (
            renderPhysicalCoinPile(coinsOnCard, 'md')
          ) : (
            <strong style={{ color: '#94a3b8', fontSize: '15px' }}>0개</strong>
          )}
          <small>가져가면 -{coinsOnCard}점 감점</small>
        </div>
      </div>
    );
  };

  const renderCollectedSequences = (cards: number[]) => {
    if (!cards || cards.length === 0) {
      return <span className="empty-cards-hint">획득한 카드 없음 (0점)</span>;
    }
    const { sequences } = calculateNoThanksScore(cards, 0);
    return (
      <div className="sequences-wrap">
        {sequences.map((seq, sIdx) => (
          <div key={sIdx} className="card-sequence-group">
            {seq.map((num, nIdx) => (
              <span
                key={num}
                className={`nt-mini-card ${nIdx === 0 ? 'scoring-head' : 'chained-free'}`}
                title={nIdx === 0 ? `${num}점 반영` : `연속 숫자 (${num}점 면제)`}
              >
                {num}
              </span>
            ))}
          </div>
        ))}
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
      <div className="nt-container" style={{ background: PLAYER_BG_COLORS[0] }}>
        <div className="setup-card home-entry-card">
          <div className="home-castle-icon">🙅‍♂️🃏💰</div>
          <h1 className="setup-title">노땡스! (NO THANKS!)</h1>
          <p className="home-subtitle">
            동일 판돈 승자 독식 · 승점(1승, 2승…) &amp; 판돈 누적 · 파산 시 즉시 아웃
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
              <span className="mode-desc">2~4인 로컬 동일 판돈 서바이벌 노땡스</span>
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
      <div className="nt-container" style={{ background: PLAYER_BG_COLORS[0], padding: '16px' }}>
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
              <h3 style={{ margin: '0 0 8px', fontSize: '15px', color: '#b45309', textAlign: 'center' }}>
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
      <div className="nt-container" style={{ background: PLAYER_BG_COLORS[0] }}>
        <div className="net-lobby-container">
          <div className="net-lobby-header">
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, fontSize: '20px', color: '#0f172a' }}>
              🌐 노땡스 넷게임 (4개 테이블)
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
                    <span className="room-number-title">🙅‍♂️ 제 {room.roomId} 노땡스룸</span>
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
              <h2 style={{ margin: '0 0 8px' }}>🙅‍♂️ 제 {joinModalRoom.roomId} 노땡스룸 입장</h2>
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
          className="nt-container"
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
        <div className="nt-container" style={{ background: PLAYER_BG_COLORS[0] }}>
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
              🙅‍♂️ 노땡스 대기실 {amISpectator ? '👀 [관망모드]' : ''}
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
              🚀 노땡스 시작! (전원 {activeNetRoom.anteBet.toLocaleString()}칩 동일 베팅)
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

    return (
      <div
        className="nt-container"
        style={{ background: PLAYER_BG_COLORS[netCurrIdx % PLAYER_BG_COLORS.length] }}
      >
        {renderFireworksAndChips()}

        {toast && (
          <div key={toast.id} className={`nt-toast ${toast.type}`}>
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

          <div className="nt-table-board">
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
              <div key={activeNetRoom.turnNotice} className="nt-notice-banner">
                {activeNetRoom.turnNotice}
              </div>
            )}

            {/* 중앙 오픈 카드 + 카드 위에 올라간 코인 + 뒤에 쌓인 덱 두께 */}
            <div className="nt-center-arena">
              <div className="center-pot-box">
                <span className="pot-label">
                  💰 동일 판돈({activeNetRoom.anteBet.toLocaleString()}칩) 누적 POT
                </span>
                <strong className="pot-amount">
                  {(activeNetRoom.pot || 0).toLocaleString()} 칩
                </strong>
              </div>

              {activeNetRoom.status === 'PLAYING' &&
                activeNetRoom.currentCard !== null &&
                renderMainCardWithStackedDeckAndCoins(
                  activeNetRoom.currentCard,
                  activeNetRoom.deck.length,
                  activeNetRoom.centerTokens
                )}
            </div>

            {/* 플레이어 좌석 현황 (물리적 동그란 코인 표시) */}
            <div className="players-seats-grid">
              {roomPlayers.map((p, idx) => {
                const isTurn =
                  !p.isEliminated && activeNetRoom.status === 'PLAYING' && idx === netCurrIdx;
                const isMe = !amISpectator && p.id === mySessionId;
                const canSeeTokens = isMe || isRoundEnded;
                const { cardPoints, finalScore } = calculateNoThanksScore(p.cards, p.tokens);

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
                          {canSeeTokens ? (
                            renderPhysicalCoinPile(p.tokens, 'sm')
                          ) : (
                            <span className="seat-token-pill hidden">
                              <span className="physical-gold-coin tiny">
                                <i />
                              </span>
                              비공개
                            </span>
                          )}
                          <span className="seat-score-tag">
                            {canSeeTokens ? `${finalScore}점` : `카드 ${cardPoints}점`}
                          </span>
                        </>
                      )}
                    </div>

                    {p.isEliminated ? (
                      <span className="bet-status-text">
                        보유 판돈을 모두 소진하여 아웃되었습니다.
                      </span>
                    ) : (
                      renderCollectedSequences(p.cards)
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {amISpectator && (
            <div className="nt-bottom-dock">
              <div className="waiting-dock-msg">
                👀 관망모드에서는 각 플레이어의 패스용 코인 개수가 비공개 처리됩니다.
              </div>
            </div>
          )}

          {myPlayerObj && !amISpectator && (
            <div
              className="nt-bottom-dock"
              style={{ borderTop: `4px solid ${myPlayerObj.badgeColor}` }}
            >
              {myPlayerObj.isEliminated ? (
                <div className="waiting-dock-msg" style={{ color: '#dc2626' }}>
                  💀 보유한 판돈을 모두 소진하여 아웃되었습니다. 다음 매치가 열릴 때까지 관전합니다.
                </div>
              ) : (
                <>
                  {activeNetRoom.status === 'PLAYING' && (
                    <div className="nt-actions-row">
                      <button
                        type="button"
                        className="nt-act-btn pass"
                        disabled={!isMyTurn || myPlayerObj.tokens <= 0}
                        onClick={handleNetPassCard}
                      >
                        🙅‍♂️ 노땡스! 코인 1개 내고 패스 (남은 코인: {myPlayerObj.tokens}개)
                      </button>
                      <button
                        type="button"
                        className="nt-act-btn take"
                        disabled={!isMyTurn}
                        onClick={handleNetTakeCard}
                      >
                        🃏 카드 [{activeNetRoom.currentCard}] + 코인 {activeNetRoom.centerTokens}개 가져오기
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

  return (
    <div className="nt-container" style={{ background: currentBackground }}>
      {renderFireworksAndChips()}

      {toast && (
        <div key={toast.id} className={`nt-toast ${toast.type}`}>
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
          <h1 className="setup-title">🙅‍♂️ 노땡스! (단독게임 · 동일 판돈 독식)</h1>

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
              🚀 노땡스 시작! (전원 {soloAnteBet.toLocaleString()}칩 동일 베팅)
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

            <div className="nt-table-board">
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
                <div key={turnNotice} className="nt-notice-banner">
                  {turnNotice}
                </div>
              )}

              {/* 중앙 오픈 카드 + 카드 위에 올라간 코인 + 뒤에 쌓인 덱 두께 */}
              <div className="nt-center-arena">
                <div className="center-pot-box">
                  <span className="pot-label">
                    💰 동일 판돈({soloAnteBet.toLocaleString()}칩) 누적 POT
                  </span>
                  <strong className="pot-amount">{soloPot.toLocaleString()} 칩</strong>
                </div>

                {gameState === 'PLAYING' &&
                  currentCard !== null &&
                  renderMainCardWithStackedDeckAndCoins(currentCard, deck.length, centerTokens)}
              </div>

              {/* 플레이어 좌석 영역 (물리적 동그란 코인 표시) */}
              <div className="players-seats-grid">
                {players.map((p, idx) => {
                  const isTurn = !isSoloEnded && !p.isEliminated && idx === currentPlayerIdx;
                  const canSeeTokens = isSoloEnded || idx === currentPlayerIdx;
                  const { cardPoints, finalScore } = calculateNoThanksScore(p.cards, p.tokens);

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
                            {canSeeTokens ? (
                              renderPhysicalCoinPile(p.tokens, 'sm')
                            ) : (
                              <span className="seat-token-pill hidden">
                                <span className="physical-gold-coin tiny">
                                  <i />
                                </span>
                                비공개
                              </span>
                            )}
                            <span className="seat-score-tag">
                              {canSeeTokens ? `${finalScore}점` : `카드 ${cardPoints}점`}
                            </span>
                          </>
                        )}
                      </div>

                      {p.isEliminated ? (
                        <span className="bet-status-text">
                          보유 판돈을 모두 소진하여 아웃되었습니다.
                        </span>
                      ) : (
                        renderCollectedSequences(p.cards)
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div
              className="nt-bottom-dock"
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

              {gameState === 'PLAYING' && (
                <div className="nt-actions-row">
                  <button
                    type="button"
                    className="nt-act-btn pass"
                    disabled={currentPlayer.tokens <= 0}
                    onClick={handleSoloPassCard}
                  >
                    🙅‍♂️ 노땡스! 코인 1개 내고 패스 (남은 코인: {currentPlayer.tokens}개)
                  </button>
                  <button
                    type="button"
                    className="nt-act-btn take"
                    onClick={handleSoloTakeCard}
                  >
                    🃏 카드 [{currentCard}] + 코인 {centerTokens}개 가져오기
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