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
import './Page10.css';

export interface DominoTile {
  id: string; // 예: "3-5"
  left: number; // 0 ~ 6
  right: number; // 0 ~ 6
}

export interface PlacedDomino {
  id: string;
  left: number; // 보드상 왼쪽 방향 눈금
  right: number; // 보드상 오른쪽 방향 눈금
  isDouble: boolean;
}

interface DominoPlayer {
  id: string;
  name: string;
  seatIndex: number;
  chips: number;
  wins: number;
  currentBet: number;
  hand: DominoTile[];
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

interface NetDominoRoomData {
  roomId: number;
  status: 'EMPTY' | 'WAITING' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER';
  players: DominoPlayer[];
  pot: number;
  waitlist: WaitlistPlayer[];
  spectators: SpectatorPlayer[];
  baseTimeout: number;
  anteBet: number;
  roundNumber: number;
  boardChain: PlacedDomino[];
  boneyard: DominoTile[];
  currentTurnIdx: number;
  consecutivePasses: number;
  lastPlacedId: string | null;
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

// 눈금(0~6)별 3x3 그리드 위치 매핑
const PIP_POSITIONS: Record<number, number[]> = {
  0: [],
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

/**
 * Double-Six (0-0 ~ 6-6) 총 28장 도미노 덱 생성 및 셔플
 */
function createShuffledDominoDeck(): DominoTile[] {
  const deck: DominoTile[] = [];
  for (let i = 0; i <= 6; i++) {
    for (let j = i; j <= 6; j++) {
      deck.push({
        id: `${i}-${j}`,
        left: i,
        right: j,
      });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function getHandPipSum(hand: DominoTile[]): number {
  return hand.reduce((sum, t) => sum + t.left + t.right, 0);
}

function getBoardEnds(chain: PlacedDomino[]): { leftEnd: number; rightEnd: number } | null {
  if (!chain || chain.length === 0) return null;
  return {
    leftEnd: chain[0].left,
    rightEnd: chain[chain.length - 1].right,
  };
}

function canPlayTileOnSide(
  tile: DominoTile,
  chain: PlacedDomino[],
  side: 'LEFT' | 'RIGHT'
): boolean {
  const ends = getBoardEnds(chain);
  if (!ends) return true;
  const target = side === 'LEFT' ? ends.leftEnd : ends.rightEnd;
  return tile.left === target || tile.right === target;
}

function canPlayTileAnywhere(tile: DominoTile, chain: PlacedDomino[]): boolean {
  if (!chain || chain.length === 0) return true;
  return canPlayTileOnSide(tile, chain, 'LEFT') || canPlayTileOnSide(tile, chain, 'RIGHT');
}

function hasAnyPlayableTile(hand: DominoTile[], chain: PlacedDomino[]): boolean {
  return hand.some((t) => canPlayTileAnywhere(t, chain));
}

/**
 * 선택한 타일을 보드 체인의 왼쪽 또는 오른쪽 끝에 방향을 맞춰 연결
 */
function placeTileOnChain(
  chain: PlacedDomino[],
  tile: DominoTile,
  side: 'LEFT' | 'RIGHT'
): PlacedDomino[] {
  const isDouble = tile.left === tile.right;
  if (chain.length === 0) {
    return [{ id: tile.id, left: tile.left, right: tile.right, isDouble }];
  }

  const ends = getBoardEnds(chain)!;
  if (side === 'LEFT') {
    // 왼쪽 끝(ends.leftEnd)과 타일의 오른쪽 면이 맞닿아야 함
    if (tile.right === ends.leftEnd) {
      return [{ id: tile.id, left: tile.left, right: tile.right, isDouble }, ...chain];
    }
    return [{ id: tile.id, left: tile.right, right: tile.left, isDouble }, ...chain];
  } else {
    // 오른쪽 끝(ends.rightEnd)과 타일의 왼쪽 면이 맞닿아야 함
    if (tile.left === ends.rightEnd) {
      return [...chain, { id: tile.id, left: tile.left, right: tile.right, isDouble }];
    }
    return [...chain, { id: tile.id, left: tile.right, right: tile.left, isDouble }];
  }
}

/**
 * 가장 높은 더블 패(없으면 가장 높은 눈금 합)를 가진 선공 플레이어 인덱스 찾기
 */
function findStartingPlayerIndex(players: DominoPlayer[]): number {
  let bestIdx = 0;
  let bestScore = -1;

  players.forEach((p, idx) => {
    for (const t of p.hand) {
      const score = t.left === t.right ? 100 + t.left : t.left + t.right;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }
  });
  return bestIdx;
}

function createDefaultDominoRoom(roomId: number): NetDominoRoomData {
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
    boardChain: [],
    boneyard: [],
    currentTurnIdx: 0,
    consecutivePasses: 0,
    lastPlacedId: null,
    turnDeadline: null,
    turnNotice: '',
    winnerAnnouncement: '',
    roundWinnerId: null,
    waitingSince: null,
  };
}

/**
 * 나무 도미노 타일 면(눈금 0~6) 렌더링 컴포넌트
 */
function DominoHalfFace({ value }: { value: number }) {
  const activePips = PIP_POSITIONS[value] || [];
  return (
    <div className="domino-pip-grid">
      {Array.from({ length: 9 }, (_, cellIdx) => (
        <span
          key={cellIdx}
          className={`domino-pip-dot ${activePips.includes(cellIdx) ? `visible pip-${value}` : ''}`}
        />
      ))}
    </div>
  );
}

export default function Page10() {
  const [appMode, setAppMode] = useState<
    'HOME' | 'SOLO' | 'NET_LOBBY' | 'NET_ROOM' | 'HALL_OF_FAME'
  >('HOME');

  const [mySessionId] = useState<string>(() => {
    const saved = sessionStorage.getItem('domino_net_uid');
    if (saved) return saved;
    const generated = `dom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('domino_net_uid', generated);
    return generated;
  });

  // 넷게임 상태
  const [rooms, setRooms] = useState<NetDominoRoomData[]>(
    [1, 2, 3, 4].map(createDefaultDominoRoom)
  );
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [joinModalRoom, setJoinModalRoom] = useState<NetDominoRoomData | null>(null);
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
  const [soloPlayerCount, setSoloPlayerCount] = useState<number>(2);
  const [soloNameInputs, setSoloNameInputs] = useState<string[]>([
    '우드마스터',
    '도미노킹',
    '나무꾼',
    '장인',
  ]);
  const [soloPlayers, setSoloPlayers] = useState<DominoPlayer[]>([]);
  const [soloAnteBet, setSoloAnteBet] = useState<number>(1000);
  const [soloTimeoutSec, setSoloTimeoutSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRemainingSec, setSoloRemainingSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRoundNum, setSoloRoundNum] = useState<number>(1);
  const [soloPot, setSoloPot] = useState<number>(0);

  const [soloBoardChain, setSoloBoardChain] = useState<PlacedDomino[]>([]);
  const [soloBoneyard, setSoloBoneyard] = useState<DominoTile[]>([]);
  const [soloTurnIdx, setSoloTurnIdx] = useState<number>(0);
  const [soloConsecutivePasses, setSoloConsecutivePasses] = useState<number>(0);
  const [soloLastPlacedId, setSoloLastPlacedId] = useState<string | null>(null);

  // 양쪽 모두 연결 가능한 타일 선택 시 방향 고르기 팝업 상태
  const [pendingTileChoice, setPendingTileChoice] = useState<DominoTile | null>(null);

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
  const boardScrollRef = useRef<HTMLDivElement | null>(null);

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
   * 원목 테이블 위 나무 도미노 타일 착수/뽑기 사운드
   */
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
        place: [260, 175], // 나무 패가 원목판에 부딪히는 소리
        draw: [340, 420],
        chip: [880, 1174.66],
        win: [523.25, 659.25, 783.99, 1046.5, 1318.5],
        tick: [987.77],
      };

      notesMap[kind].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === 'place' ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.055);
        gain.gain.setValueAtTime(kind === 'place' ? 0.25 : 0.14, ctx.currentTime + idx * 0.055);
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
    const key = type === 'SOLO' ? 'domino_hof_solo' : 'domino_hof_net';
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
    const key = type === 'SOLO' ? 'domino_hof_solo' : 'domino_hof_net';
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
      const roomRef = ref(db, `domino_rooms/room_${roomIdToLeave}`);
      try {
        await runTransaction(roomRef, (roomData) => {
          if (!roomData) return roomData;
          const room = roomData as NetDominoRoomData;
          const filteredPlayers = (room.players || []).filter((p) => p.id !== mySessionId);
          const filteredWaitlist = (room.waitlist || []).filter((w) => w.id !== mySessionId);
          const filteredSpectators = (room.spectators || []).filter((s) => s.id !== mySessionId);

          if (filteredPlayers.length === 0 && filteredSpectators.length === 0) {
            return createDefaultDominoRoom(room.roomId);
          }

          room.players = filteredPlayers.map((p, idx) => ({
            ...p,
            seatIndex: idx,
          }));
          room.waitlist = filteredWaitlist;
          room.spectators = filteredSpectators;
          room.currentTurnIdx =
            filteredPlayers.length > 0 ? room.currentTurnIdx % filteredPlayers.length : 0;

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

    const presenceRef = ref(db, `domino_presence/room_${selectedRoomId}/${mySessionId}`);
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
        const roomRef = ref(db, `domino_rooms/room_${id}`);
        const snap = await get(roomRef);
        if (!snap.exists()) {
          await set(roomRef, createDefaultDominoRoom(id));
        }
      }
    };
    ensureRoomsExist();

    const roomsRef = ref(db, 'domino_rooms');
    const unsubscribe = onValue(roomsRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      const loadedRooms: NetDominoRoomData[] = [1, 2, 3, 4].map((id) => {
        const rData = data[`room_${id}`];
        const def = createDefaultDominoRoom(id);
        if (!rData) return def;

        return {
          ...def,
          ...rData,
          players: (rData.players || []).map((p: DominoPlayer, idx: number) => ({
            ...p,
            seatIndex: idx,
            chips: typeof p.chips === 'number' ? p.chips : INITIAL_CHIPS,
            wins: typeof p.wins === 'number' ? p.wins : 0,
            currentBet: typeof p.currentBet === 'number' ? p.currentBet : 0,
            hand: Array.isArray(p.hand) ? p.hand : [],
            isEliminated: Boolean(p.isEliminated),
          })),
          pot: typeof rData.pot === 'number' ? rData.pot : 0,
          waitlist: rData.waitlist || [],
          spectators: rData.spectators || [],
          boardChain: Array.isArray(rData.boardChain) ? rData.boardChain : [],
          boneyard: Array.isArray(rData.boneyard) ? rData.boneyard : [],
          currentTurnIdx: typeof rData.currentTurnIdx === 'number' ? rData.currentTurnIdx : 0,
          consecutivePasses:
            typeof rData.consecutivePasses === 'number' ? rData.consecutivePasses : 0,
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
    setPendingTileChoice(null);
  }, [soloTurnIdx, activeNetRoom?.currentTurnIdx, soloBoardChain.length, activeNetRoom?.boardChain.length]);

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
          const roomRef = ref(db, `domino_rooms/room_${activeNetRoom.roomId}`);
          await set(roomRef, createDefaultDominoRoom(activeNetRoom.roomId));
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
          const actor = soloPlayers[soloTurnIdx];
          if (actor) {
            const playable = actor.hand.find((t) => canPlayTileAnywhere(t, soloBoardChain));
            if (playable) {
              const side: 'LEFT' | 'RIGHT' = canPlayTileOnSide(playable, soloBoardChain, 'RIGHT')
                ? 'RIGHT'
                : 'LEFT';
              executeSoloPlayTile(playable, side, true);
            } else if (soloBoneyard.length > 0) {
              handleSoloDrawTile(true);
            } else {
              handleSoloPassTurn(true);
            }
          }
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [
    appMode,
    gameState,
    soloPlayers,
    soloTurnIdx,
    soloBoardChain,
    soloBoneyard,
    soloTimeoutSec,
  ]);

  const handleEnterRoomSubmit = async (asSpectator = false) => {
    if (!joinModalRoom) return;
    const trimmedName = joinPlayerName ? joinPlayerName.trim() : '';
    if (!trimmedName) {
      alert('참가할 이름을 입력해주세요!');
      return;
    }

    const roomRef = ref(db, `domino_rooms/room_${joinModalRoom.roomId}`);

    try {
      let joinResultType = 'PLAYER';

      await runTransaction(roomRef, (roomData) => {
        const room: NetDominoRoomData = roomData || createDefaultDominoRoom(joinModalRoom.roomId);
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
          const newPlayer: DominoPlayer = {
            id: mySessionId,
            name: trimmedName,
            seatIndex: room.players.length,
            chips: INITIAL_CHIPS,
            wins: 0,
            currentBet: 0,
            hand: [],
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
    const roomRef = ref(db, `domino_rooms/room_${activeNetRoom.roomId}`);
    await update(roomRef, {
      anteBet: newAnteBet,
      baseTimeout: clampedTimeout,
      waitingSince: Date.now(),
    });
  };

  /**
   * 넷게임 라운드 시작 (도미노 패 분배 & 동일 판돈 베팅)
   */
  const handleStartNetRound = async (isNextRound = false) => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `domino_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetDominoRoomData;
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
      const nextActive: DominoPlayer[] = [...survivingPlayers];
      const remainingWaitlist: WaitlistPlayer[] = [];

      for (const w of waitlist) {
        if (nextActive.length < 4) {
          nextActive.push({
            id: w.id,
            name: w.name,
            seatIndex: nextActive.length,
            chips: INITIAL_CHIPS,
            wins: 0,
            currentBet: 0,
            hand: [],
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

      const deck = createShuffledDominoDeck();
      const tilesPerPlayer = nextActive.length === 2 ? 7 : 6;
      const equalStake = Math.min(ante, ...nextActive.map((p) => p.chips));
      let collectedPot = isNewMatch ? 0 : room.pot || 0;

      const preparedPlayers: DominoPlayer[] = nextActive.map((p, idx) => {
        collectedPot += equalStake;
        const hand = deck.splice(0, tilesPerPlayer);
        return {
          ...p,
          seatIndex: idx,
          chips: p.chips - equalStake,
          currentBet: equalStake,
          hand,
          isEliminated: false,
        };
      });

      const starterIdx = findStartingPlayerIndex(preparedPlayers);

      room.status = 'PLAYING';
      room.roundNumber = nextRound;
      room.players = preparedPlayers;
      room.pot = collectedPot;
      room.waitlist = remainingWaitlist;
      room.boardChain = [];
      room.boneyard = deck;
      room.currentTurnIdx = starterIdx;
      room.consecutivePasses = 0;
      room.lastPlacedId = null;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.winnerAnnouncement = '';
      room.roundWinnerId = null;
      room.turnNotice = `🪵 [${nextRound}국] 동일 판돈 ${equalStake.toLocaleString()}칩 베팅! 가장 높은 패를 든 ${preparedPlayers[starterIdx].name}님 선공입니다.`;
      room.waitingSince = null;

      return room;
    });

    triggerChipAnimation('전원', activeNetRoom.anteBet, '#8d6e63');
  };

  /**
   * 넷게임 라운드 종료 정산 (Domino 아웃 또는 전원 막힘 Blocked 시 최저 눈금 합계 승자 독식)
   */
  const settleNetDominoRound = (
    room: NetDominoRoomData,
    reason: 'DOMINO' | 'BLOCKED',
    dominoWinnerId?: string
  ) => {
    const wonPot = room.pot || 0;
    let winner = room.players[0];

    if (reason === 'DOMINO' && dominoWinnerId) {
      winner = room.players.find((p) => p.id === dominoWinnerId) || room.players[0];
    } else {
      // Blocked: 남은 패 눈금 합이 가장 적은 플레이어 승리
      let minPipSum = Infinity;
      for (const p of room.players) {
        const pipSum = getHandPipSum(p.hand || []);
        if (pipSum < minPipSum) {
          minPipSum = pipSum;
          winner = p;
        }
      }
    }

    const summaryText = room.players
      .map((p) => `${p.name}(${getHandPipSum(p.hand || [])}점)`)
      .join(' vs ');

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
    const survivorsCount = room.players.filter((p) => !p.isEliminated).length;

    room.pot = 0;
    room.turnDeadline = null;
    room.turnNotice = '';
    room.roundWinnerId = winner.id;

    const winReasonLabel =
      reason === 'DOMINO'
        ? `도미노 완성! 모든 패를 털어낸`
        : `전원 막힘(Blocked)! 최저 잔여 눈금(${summaryText})으로`;

    if (survivorsCount <= 1) {
      room.status = 'MATCH_OVER';
      room.winnerAnnouncement = `👑 최종 우승! ${winner.name}님이 ${winReasonLabel} 승리하며 모든 판돈을 석권했습니다!`;
    } else {
      room.status = 'ROUND_OVER';
      room.winnerAnnouncement = `🎊 ${winner.name}님 승리! ${winReasonLabel} 판돈 ${wonPot.toLocaleString()}칩 독식! (${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}칩)`;
    }

    saveHallOfFameRecord('NET', {
      name: winner.name,
      scoreOrLevel: `${winnerObj.wins}승 · 보유 ${winnerObj.chips.toLocaleString()}칩`,
    });
  };

  /**
   * 넷게임 타일 착수 실행
   */
  const executeNetPlayTile = async (tile: DominoTile, side: 'LEFT' | 'RIGHT') => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const actor = activeNetRoom.players[activeNetRoom.currentTurnIdx];
    if (!actor || actor.id !== mySessionId) return;

    if (!canPlayTileOnSide(tile, activeNetRoom.boardChain, side)) {
      showToast('그 방향에는 연결할 수 없는 도미노 패입니다!', 'danger');
      return;
    }

    playSound('place');
    setPendingTileChoice(null);
    const roomRef = ref(db, `domino_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetDominoRoomData;
      if (room.status !== 'PLAYING') return room;

      const currentActor = room.players[room.currentTurnIdx];
      if (!currentActor || currentActor.id !== mySessionId) return room;

      const chain = Array.isArray(room.boardChain) ? room.boardChain : [];
      if (!canPlayTileOnSide(tile, chain, side)) return room;

      const nextChain = placeTileOnChain(chain, tile, side);
      const nextHand = (currentActor.hand || []).filter((t) => t.id !== tile.id);

      room.players = room.players.map((p, idx) =>
        idx === room.currentTurnIdx ? { ...p, hand: nextHand } : p
      );
      room.boardChain = nextChain;
      room.lastPlacedId = tile.id;
      room.consecutivePasses = 0;

      // 손패를 모두 비웠으면 즉시 도미노 승리
      if (nextHand.length === 0) {
        settleNetDominoRound(room, 'DOMINO', currentActor.id);
        return room;
      }

      const nextIdx = (room.currentTurnIdx + 1) % room.players.length;
      const nextPlayer = room.players[nextIdx];
      room.currentTurnIdx = nextIdx;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `🪵 ${currentActor.name}님이 [${tile.left}|${tile.right}] 연결! 👉 ${nextPlayer.name}님 차례입니다.`;

      return room;
    });
  };

  /**
   * 넷게임 더미(Boneyard)에서 패 1장 뽑기
   */
  const handleNetDrawTile = async () => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const actor = activeNetRoom.players[activeNetRoom.currentTurnIdx];
    if (!actor || actor.id !== mySessionId) return;

    if (hasAnyPlayableTile(actor.hand, activeNetRoom.boardChain)) {
      showToast('낼 수 있는 도미노 패가 손에 있습니다!', 'info');
      return;
    }

    playSound('draw');
    const roomRef = ref(db, `domino_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetDominoRoomData;
      if (room.status !== 'PLAYING') return room;

      const currentActor = room.players[room.currentTurnIdx];
      if (!currentActor || currentActor.id !== mySessionId) return room;

      const boneyard = Array.isArray(room.boneyard) ? [...room.boneyard] : [];
      if (boneyard.length === 0) return room;

      const drawn = boneyard.shift()!;
      const updatedHand = [...(currentActor.hand || []), drawn];

      room.boneyard = boneyard;
      room.players = room.players.map((p, idx) =>
        idx === room.currentTurnIdx ? { ...p, hand: updatedHand } : p
      );
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `🎴 ${currentActor.name}님이 나무 더미에서 패 1장을 뽑았습니다 (남은 더미 ${boneyard.length}장).`;
      return room;
    });
  };

  /**
   * 넷게임 패스 (더미가 비어 있고 낼 패도 없을 때)
   */
  const handleNetPassTurn = async () => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING') return;
    const actor = activeNetRoom.players[activeNetRoom.currentTurnIdx];
    if (!actor || actor.id !== mySessionId) return;

    const roomRef = ref(db, `domino_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetDominoRoomData;
      if (room.status !== 'PLAYING') return room;

      const currentActor = room.players[room.currentTurnIdx];
      if (!currentActor || currentActor.id !== mySessionId) return room;

      const nextPasses = (room.consecutivePasses || 0) + 1;
      if (nextPasses >= room.players.length) {
        settleNetDominoRound(room, 'BLOCKED');
        return room;
      }

      const nextIdx = (room.currentTurnIdx + 1) % room.players.length;
      const nextPlayer = room.players[nextIdx];
      room.consecutivePasses = nextPasses;
      room.currentTurnIdx = nextIdx;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `⏭️ ${currentActor.name}님이 낼 패가 없어 패스! 👉 ${nextPlayer.name}님 차례입니다.`;
      return room;
    });
  };

  /**
   * 넷게임 시간 초과 자동 진행
   */
  const handleNetTurnTimeout = async (room: NetDominoRoomData) => {
    const roomRef = ref(db, `domino_rooms/room_${room.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const r = roomData as NetDominoRoomData;
      if (r.status !== 'PLAYING') return r;

      const actor = r.players[r.currentTurnIdx];
      const chain = Array.isArray(r.boardChain) ? r.boardChain : [];
      const hand = actor.hand || [];
      const playable = hand.find((t) => canPlayTileAnywhere(t, chain));

      if (playable) {
        const side: 'LEFT' | 'RIGHT' = canPlayTileOnSide(playable, chain, 'RIGHT')
          ? 'RIGHT'
          : 'LEFT';
        const nextChain = placeTileOnChain(chain, playable, side);
        const nextHand = hand.filter((t) => t.id !== playable.id);

        r.players = r.players.map((p, idx) =>
          idx === r.currentTurnIdx ? { ...p, hand: nextHand } : p
        );
        r.boardChain = nextChain;
        r.lastPlacedId = playable.id;
        r.consecutivePasses = 0;

        if (nextHand.length === 0) {
          settleNetDominoRound(r, 'DOMINO', actor.id);
          return r;
        }

        const nextIdx = (r.currentTurnIdx + 1) % r.players.length;
        r.currentTurnIdx = nextIdx;
        r.turnDeadline = Date.now() + r.baseTimeout * 1000;
        r.turnNotice = `⏰ 시간 초과로 ${actor.name}님이 [${playable.left}|${playable.right}] 자동 착수! 👉 ${r.players[nextIdx].name}님 차례!`;
        return r;
      }

      const boneyard = Array.isArray(r.boneyard) ? [...r.boneyard] : [];
      if (boneyard.length > 0) {
        const drawn = boneyard.shift()!;
        r.boneyard = boneyard;
        r.players = r.players.map((p, idx) =>
          idx === r.currentTurnIdx ? { ...p, hand: [...hand, drawn] } : p
        );
        r.turnDeadline = Date.now() + r.baseTimeout * 1000;
        r.turnNotice = `⏰ 시간 초과로 ${actor.name}님이 더미에서 자동 뽑기!`;
        return r;
      }

      const nextPasses = (r.consecutivePasses || 0) + 1;
      if (nextPasses >= r.players.length) {
        settleNetDominoRound(r, 'BLOCKED');
        return r;
      }

      const nextIdx = (r.currentTurnIdx + 1) % r.players.length;
      r.consecutivePasses = nextPasses;
      r.currentTurnIdx = nextIdx;
      r.turnDeadline = Date.now() + r.baseTimeout * 1000;
      r.turnNotice = `⏰ 시간 초과 자동 패스! 👉 ${r.players[nextIdx].name}님 차례!`;
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
    const builtPlayers: DominoPlayer[] = Array.from({ length: soloPlayerCount }, (_, idx) => ({
      id: String(idx + 1),
      name: soloNameInputs[idx]?.trim() || `대국자 ${idx + 1}`,
      seatIndex: idx,
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      hand: [],
      isEliminated: false,
    }));
    setSoloPlayers(builtPlayers);
    setGameState('READY');
  };

  const shuffleSoloOrder = () => {
    setSoloPlayers((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy.map((p, idx) => ({ ...p, seatIndex: idx }));
    });
  };

  const startSoloRound = (isNextRound = false) => {
    const isFreshMatch = !isNextRound || gameState === 'MATCH_OVER';
    const nextRound = isFreshMatch ? 1 : soloRoundNum + 1;

    const activeSurvivors = soloPlayers
      .map((p) => ({
        ...p,
        chips: isFreshMatch ? INITIAL_CHIPS : p.chips,
        wins: isFreshMatch ? 0 : p.wins,
        isEliminated: isFreshMatch ? false : p.chips <= 0,
      }))
      .filter((p) => !p.isEliminated);

    const deck = createShuffledDominoDeck();
    const tilesPerPlayer = activeSurvivors.length === 2 ? 7 : 6;
    const equalStake = Math.min(soloAnteBet, ...activeSurvivors.map((p) => p.chips));
    let totalPot = isFreshMatch ? 0 : soloPot;

    const preparedPlayers = activeSurvivors.map((p, idx) => {
      totalPot += equalStake;
      return {
        ...p,
        seatIndex: idx,
        chips: p.chips - equalStake,
        currentBet: equalStake,
        hand: deck.splice(0, tilesPerPlayer),
      };
    });

    const starterIdx = findStartingPlayerIndex(preparedPlayers);
    triggerChipAnimation('전원', equalStake, '#8d6e63');
    const notice = `🪵 [${nextRound}국] 동일 판돈 ${equalStake.toLocaleString()}칩 베팅! 가장 높은 패를 가진 ${preparedPlayers[starterIdx].name}님 선공입니다.`;

    setSoloRoundNum(nextRound);
    setSoloPot(totalPot);
    setSoloPlayers(preparedPlayers);
    setSoloBoardChain([]);
    setSoloBoneyard(deck);
    setSoloTurnIdx(starterIdx);
    setSoloConsecutivePasses(0);
    setSoloLastPlacedId(null);
    setPendingTileChoice(null);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setWinnerAnnouncement('');
    setShowFireworks(false);
    setTurnNotice(notice);
    speakKorean(notice);
    setGameState('PLAYING');
  };

  const settleSoloDominoRound = (
    playersState: DominoPlayer[],
    reason: 'DOMINO' | 'BLOCKED',
    dominoWinnerId?: string
  ) => {
    let winner = playersState[0];
    if (reason === 'DOMINO' && dominoWinnerId) {
      winner = playersState.find((p) => p.id === dominoWinnerId) || playersState[0];
    } else {
      let minPipSum = Infinity;
      for (const p of playersState) {
        const pipSum = getHandPipSum(p.hand);
        if (pipSum < minPipSum) {
          minPipSum = pipSum;
          winner = p;
        }
      }
    }

    const summaryText = playersState
      .map((p) => `${p.name}(${getHandPipSum(p.hand)}점)`)
      .join(' vs ');

    const settledPlayers = playersState.map((p) => {
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
    const survivorsCount = settledPlayers.filter((p) => !p.isEliminated).length;

    const winReasonLabel =
      reason === 'DOMINO'
        ? `도미노 완성! 모든 패를 털어낸`
        : `전원 막힘(Blocked)! 최저 잔여 눈금(${summaryText})으로`;

    const announcement =
      survivorsCount <= 1
        ? `👑 최종 우승! ${winner.name}님이 ${winReasonLabel} 승리하며 모든 판돈을 석권했습니다!`
        : `🎊 ${winner.name}님 승리! ${winReasonLabel} 판돈 ${soloPot.toLocaleString()}칩 독식! (${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}칩)`;

    setSoloPlayers(settledPlayers);
    setSoloPot(0);
    setTurnNotice('');
    setWinnerAnnouncement(announcement);
    setGameState(survivorsCount <= 1 ? 'MATCH_OVER' : 'ROUND_OVER');
    triggerFireworksCelebration(announcement);

    saveHallOfFameRecord('SOLO', {
      name: winner.name,
      scoreOrLevel: `${winnerObj.wins}승 · 보유 ${winnerObj.chips.toLocaleString()}칩`,
    });
  };

  const executeSoloPlayTile = (
    tile: DominoTile,
    side: 'LEFT' | 'RIGHT',
    isAuto = false
  ) => {
    if (gameState !== 'PLAYING') return;
    if (!canPlayTileOnSide(tile, soloBoardChain, side)) {
      if (!isAuto) showToast('그 방향에는 눈금이 맞지 않습니다!', 'danger');
      return;
    }

    playSound('place');
    setPendingTileChoice(null);

    const actor = soloPlayers[soloTurnIdx];
    const nextChain = placeTileOnChain(soloBoardChain, tile, side);
    const nextHand = actor.hand.filter((t) => t.id !== tile.id);
    const updatedPlayers = soloPlayers.map((p, idx) =>
      idx === soloTurnIdx ? { ...p, hand: nextHand } : p
    );

    setSoloBoardChain(nextChain);
    setSoloPlayers(updatedPlayers);
    setSoloLastPlacedId(tile.id);
    setSoloConsecutivePasses(0);

    if (nextHand.length === 0) {
      settleSoloDominoRound(updatedPlayers, 'DOMINO', actor.id);
      return;
    }

    const nextIdx = (soloTurnIdx + 1) % updatedPlayers.length;
    const nextPlayer = updatedPlayers[nextIdx];
    const prefix = isAuto ? '⏰ 시간 초과 자동 착수! ' : '🪵 ';
    const notice = `${prefix}${actor.name}님이 [${tile.left}|${tile.right}] 연결! 👉 ${nextPlayer.name}님 차례!`;

    setSoloTurnIdx(nextIdx);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setTurnNotice(notice);
    speakKorean(notice);
  };

  const handleSoloDrawTile = (isAuto = false) => {
    if (gameState !== 'PLAYING') return;
    const actor = soloPlayers[soloTurnIdx];
    if (hasAnyPlayableTile(actor.hand, soloBoardChain)) {
      if (!isAuto) showToast('낼 수 있는 도미노 패가 있습니다!', 'info');
      return;
    }
    if (soloBoneyard.length === 0) return;

    playSound('draw');
    const nextBoneyard = [...soloBoneyard];
    const drawn = nextBoneyard.shift()!;
    const updatedPlayers = soloPlayers.map((p, idx) =>
      idx === soloTurnIdx ? { ...p, hand: [...p.hand, drawn] } : p
    );

    setSoloBoneyard(nextBoneyard);
    setSoloPlayers(updatedPlayers);
    setSoloRemainingSec(soloTimeoutSec);
    const notice = `🎴 ${actor.name}님이 나무 더미에서 [${drawn.left}|${drawn.right}] 패를 뽑았습니다.`;
    setTurnNotice(notice);
    speakKorean(notice);
  };

  const handleSoloPassTurn = (isAuto = false) => {
    if (gameState !== 'PLAYING') return;
    const actor = soloPlayers[soloTurnIdx];
    const nextPasses = soloConsecutivePasses + 1;

    if (nextPasses >= soloPlayers.length) {
      settleSoloDominoRound(soloPlayers, 'BLOCKED');
      return;
    }

    const nextIdx = (soloTurnIdx + 1) % soloPlayers.length;
    const nextPlayer = soloPlayers[nextIdx];
    const prefix = isAuto ? '⏰ 시간 초과 자동 패스! ' : '⏭️ ';
    const notice = `${prefix}${actor.name}님 패스! 👉 ${nextPlayer.name}님 차례입니다.`;

    setSoloConsecutivePasses(nextPasses);
    setSoloTurnIdx(nextIdx);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setTurnNotice(notice);
    speakKorean(notice);
  };

  // =========================================================================
  // 손패 타일 클릭 핸들러 (한쪽만 가능하면 즉시 착수, 양쪽 다 가능하면 방향 선택)
  // =========================================================================
  const handleHandTileClick = (
    tile: DominoTile,
    chain: PlacedDomino[],
    onPlay: (t: DominoTile, side: 'LEFT' | 'RIGHT') => void
  ) => {
    if (chain.length === 0) {
      onPlay(tile, 'RIGHT');
      return;
    }

    const canLeft = canPlayTileOnSide(tile, chain, 'LEFT');
    const canRight = canPlayTileOnSide(tile, chain, 'RIGHT');

    if (!canLeft && !canRight) {
      showToast('양쪽 끝 눈금과 맞지 않는 패입니다!', 'danger');
      return;
    }

    const ends = getBoardEnds(chain)!;
    // 양쪽 끝 눈금이 같거나 한쪽만 연결 가능하면 즉시 배치
    if (canLeft && canRight && ends.leftEnd !== ends.rightEnd) {
      setPendingTileChoice(tile);
      return;
    }

    onPlay(tile, canRight ? 'RIGHT' : 'LEFT');
  };

  // =========================================================================
  // 원목 도미노 보드판 렌더링 헬퍼
  // =========================================================================
  const renderWoodenDominoTable = (
    chain: PlacedDomino[],
    lastPlacedId: string | null,
    boneyardCount: number,
    canInteract: boolean,
    onSelectDirection?: (tile: DominoTile, side: 'LEFT' | 'RIGHT') => void
  ) => {
    const ends = getBoardEnds(chain);

    return (
      <div className="domino-wood-frame">
        {/* 보드 상단 양끝 연결 가능 눈금 안내 바 */}
        <div className="domino-ends-indicator">
          <span className="end-pill left">
            ⬅️ 왼쪽 끝 눈금: <strong>{ends ? ends.leftEnd : '자유'}</strong>
          </span>
          <span className="boneyard-pill">
            🪵 나무 더미: <strong>{boneyardCount}장</strong>
          </span>
          <span className="end-pill right">
            오른쪽 끝 눈금: <strong>{ends ? ends.rightEnd : '자유'}</strong> ➡️
          </span>
        </div>

        {/* 양쪽 연결 가능 타일 방향 선택 버튼 바 */}
        {canInteract && pendingTileChoice && ends && onSelectDirection && (
          <div className="side-choice-banner">
            <button
              type="button"
              className="btn btn-primary side-pick-btn"
              onClick={() => onSelectDirection(pendingTileChoice, 'LEFT')}
            >
              ⬅️ 왼쪽 끝({ends.leftEnd})에 연결
            </button>
            <span className="side-choice-label">
              [{pendingTileChoice.left}|{pendingTileChoice.right}] 방향 선택
            </span>
            <button
              type="button"
              className="btn btn-primary side-pick-btn"
              onClick={() => onSelectDirection(pendingTileChoice, 'RIGHT')}
            >
              오른쪽 끝({ends.rightEnd})에 연결 ➡️
            </button>
          </div>
        )}

        {/* 오크 원목 도미노 배치 테이블 */}
        <div className="domino-oak-surface" ref={boardScrollRef}>
          {chain.length === 0 ? (
            <div className="empty-board-guide">
              <span className="guide-wood-icon">🁣</span>
              <p>아래 내 나무 도미노 패를 클릭하여 첫 패를 올려놓으세요!</p>
            </div>
          ) : (
            <div className="domino-chain-track">
              {chain.map((tile, index) => {
                const isFirst = index === 0;
                const isLast = index === chain.length - 1;
                const isRecent = tile.id === lastPlacedId;

                return (
                  <div
                    key={`${tile.id}_${index}`}
                    className={`wood-domino-tile ${
                      tile.isDouble ? 'vertical-double' : 'horizontal-single'
                    } ${isRecent ? 'just-placed' : ''} ${isFirst ? 'chain-head' : ''} ${
                      isLast ? 'chain-tail' : ''
                    }`}
                  >
                    <DominoHalfFace value={tile.left} />
                    <div className="domino-divider-bar">
                      <span className="brass-spinner-pin" />
                    </div>
                    <DominoHalfFace value={tile.right} />
                  </div>
                );
              })}
            </div>
          )}
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
      <div className="dom-container" style={{ background: WOOD_BG_THEMES[0] }}>
        <div className="setup-card home-entry-card">
          <div className="home-castle-icon">🪵🁣🁩</div>
          <h1 className="setup-title">우드 도미노 (DOMINOES)</h1>
          <p className="home-subtitle">
            원목 도미노 타일 매칭 · 동일 판돈 승자 독식 · 승점(1승, 2승…) &amp; 판돈 누적
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
              <span className="mode-desc">2~4인 로컬 대국 · 동일 판돈 연승 매치</span>
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
      <div className="dom-container" style={{ background: WOOD_BG_THEMES[0], padding: '16px' }}>
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
      <div className="dom-container" style={{ background: WOOD_BG_THEMES[0] }}>
        <div className="net-lobby-container">
          <div className="net-lobby-header">
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, fontSize: '20px', color: '#3e2723' }}>
              🌐 우드 도미노 넷게임 (4개 대국실)
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

              let statusBadgeText = '🟢 빈 대국실';
              let statusClass = 'empty';
              if (isPlaying) {
                statusBadgeText = `🔥 제 ${room.roundNumber}국 진행중`;
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
                    <span className="room-number-title">🪵 제 {room.roomId} 도미노실</span>
                    <span className={`room-status-pill ${statusClass}`}>{statusBadgeText}</span>
                  </div>

                  <div className="room-rules-info">
                    <span>💰 동일 판돈: {room.anteBet.toLocaleString()}칩</span>
                    <span>⏱️ 착수 제한: {room.baseTimeout}초</span>
                  </div>

                  <div className="room-members-box">
                    <div className="room-members-label">대국자 ({roomPlayers.length}/4):</div>
                    <div className="room-members-chips">
                      {roomPlayers.length === 0 ? (
                        <span className="empty-member-text">첫 번째 대국자를 기다리고 있습니다</span>
                      ) : (
                        roomPlayers.map((p) => (
                          <span key={p.id} className="member-chip">
                            🁣 {p.name} ({p.wins || 0}승 ·{' '}
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
              <h2 style={{ margin: '0 0 8px' }}>🪵 제 {joinModalRoom.roomId} 도미노실 입장</h2>
              <p className="modal-subtext">
                동일 판돈 <strong>{joinModalRoom.anteBet.toLocaleString()}칩</strong>을 걸고
                2~4인 도미노 대국이 진행됩니다.
              </p>

              <input
                type="text"
                className="player-input"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: '14px' }}
                placeholder="대국자 이름 입력 (예: 도미노킹)"
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
          className="dom-container"
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
        <div className="dom-container" style={{ background: WOOD_BG_THEMES[0] }}>
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
              🪵 우드 도미노 대기실 {amISpectator ? '👀 [관전모드]' : ''}
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
              <label className="setting-label">🧭 입장한 대국자 (2~4명 입장 시 시작 가능)</label>
              <div className="player-list">
                {roomPlayers.map((p, idx) => (
                  <div key={p.id} className="player-item-a">
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>🁣</span>
                      {p.name} {idx === 0 && '👑(방장)'} {p.id === mySessionId && '(나)'}
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

    const activeTurnPlayer = roomPlayers[activeNetRoom.currentTurnIdx] || roomPlayers[0];
    const myPlayerObj = roomPlayers.find((p) => p.id === mySessionId) || roomPlayers[0];
    const isMyTurn =
      activeNetRoom.status === 'PLAYING' &&
      activeTurnPlayer?.id === mySessionId &&
      !amISpectator;
    const isRoundEnded =
      activeNetRoom.status === 'ROUND_OVER' || activeNetRoom.status === 'MATCH_OVER';

    const myPlayableExists = myPlayerObj
      ? hasAnyPlayableTile(myPlayerObj.hand, activeNetRoom.boardChain)
      : false;

    return (
      <div className="dom-container" style={{ background: WOOD_BG_THEMES[0] }}>
        {renderFireworksAndChips()}

        {toast && (
          <div key={toast.id} className={`dom-toast ${toast.type}`}>
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
              {roomPlayers.map((p, idx) => {
                const isActive =
                  activeNetRoom.status === 'PLAYING' && idx === activeNetRoom.currentTurnIdx;
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${
                      isActive ? 'active-turn-spotlight' : 'active-turn-unlight'
                    }`}
                  >
                    <div className="player-badge-top">
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '>'}
                        {p.name}
                        {p.id === mySessionId ? '(나)' : ''}
                      </strong>
                      <span className="disc-score-pill">🁣{p.hand.length}장</span>
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
              onClick={handleLeaveNetRoom}
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

          {/* 중앙 원목 도미노 테이블 */}
          <div className="dom-table-board">
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
                      : `🔥 다음 대국 시작 (${activeNetRoom.anteBet.toLocaleString()}칩 베팅)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={activeNetRoom.turnNotice} className="dom-notice-banner">
                {activeNetRoom.turnNotice}
              </div>
            )}

            {/* 누적 판돈 바 */}
            <div className="dom-scoreboard-strip">
              <div className="center-pot-box">
                <span className="pot-label">💰 누적 POT</span>
                <strong className="pot-amount">
                  {(activeNetRoom.pot || 0).toLocaleString()} 칩
                </strong>
              </div>
            </div>

            {/* 원목 도미노 배치 판 */}
            <div className="board-center-stage">
              {renderWoodenDominoTable(
                activeNetRoom.boardChain,
                activeNetRoom.lastPlacedId,
                activeNetRoom.boneyard.length,
                isMyTurn,
                executeNetPlayTile
              )}
            </div>
          </div>

          {/* 하단 내 손패 도크 */}
          <div className="dom-bottom-dock">
            {amISpectator ? (
              <div className="waiting-dock-msg">👀 관전 모드로 대국을 지켜보고 있습니다.</div>
            ) : isRoundEnded ? (
              <div className="waiting-dock-msg">
                🏆 대국 종료! 상단의 <strong>[다음 대국 시작]</strong> 버튼으로 승수와 판돈을
                이어가세요!
              </div>
            ) : (
              <>
                <div className="dock-top-status">
                  <span className="turn-owner-pill large-turn-pill">
                    {isMyTurn
                      ? '🟢 내 차례 · 연결 가능한 나무 도미노 패를 선택하세요!'
                      : `⏳ ${activeTurnPlayer?.name}님 수 고민 중...`}
                  </span>

                  {isMyTurn && !myPlayableExists && (
                    <div className="dock-action-buttons">
                      {activeNetRoom.boneyard.length > 0 ? (
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ padding: '6px 12px', fontSize: '13px' }}
                          onClick={handleNetDrawTile}
                        >
                          🎴 더미에서 1장 뽑기 ({activeNetRoom.boneyard.length}장)
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '6px 12px', fontSize: '13px' }}
                          onClick={handleNetPassTurn}
                        >
                          ⏭️ 낼 패 없음 (패스)
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="hand-tiles-rack">
                  {(myPlayerObj?.hand || []).map((tile) => {
                    const playable = isMyTurn && canPlayTileAnywhere(tile, activeNetRoom.boardChain);
                    const isSelected = pendingTileChoice?.id === tile.id;
                    return (
                      <button
                        key={tile.id}
                        type="button"
                        disabled={!isMyTurn}
                        onClick={() =>
                          handleHandTileClick(tile, activeNetRoom.boardChain, executeNetPlayTile)
                        }
                        className={`hand-domino-card ${playable ? 'playable-glow' : ''} ${
                          isSelected ? 'selected-tile' : ''
                        }`}
                      >
                        <DominoHalfFace value={tile.left} />
                        <div className="domino-divider-bar">
                          <span className="brass-spinner-pin" />
                        </div>
                        <DominoHalfFace value={tile.right} />
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // 5. 단독게임(SOLO) - 2~4인 로컬 원목 도미노 연승 매치
  // =========================================================================
  const currentSoloPlayer = soloPlayers[soloTurnIdx] || soloPlayers[0];
  const isSoloEnded = gameState === 'ROUND_OVER' || gameState === 'MATCH_OVER';
  const soloPlayableExists = currentSoloPlayer
    ? hasAnyPlayableTile(currentSoloPlayer.hand, soloBoardChain)
    : false;

  return (
    <div className="dom-container" style={{ background: WOOD_BG_THEMES[0] }}>
      {renderFireworksAndChips()}

      {toast && (
        <div key={toast.id} className={`dom-toast ${toast.type}`}>
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
          <h1 className="setup-title">🪵 우드 도미노 (단독게임 설정)</h1>

          <div className="setting-section">
            <label className="setting-label">👥 대국 인원 선택 (2~4인)</label>
            <div className="piece-count-selector" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {[2, 3, 4].map((cnt) => (
                <button
                  key={cnt}
                  type="button"
                  className={`count-btn ${soloPlayerCount === cnt ? 'active' : ''}`}
                  onClick={() => setSoloPlayerCount(cnt)}
                >
                  {cnt}인 대전
                </button>
              ))}
            </div>
          </div>

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
            <label className="setting-label">🧭 대국자 이름 설정</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {Array.from({ length: soloPlayerCount }, (_, idx) => (
                <div key={idx} className="player-item-a">
                  <span>🁣 {idx + 1}번 대국자</span>
                  <input
                    type="text"
                    className="player-input"
                    style={{ maxWidth: '220px', padding: '6px 10px' }}
                    value={soloNameInputs[idx] || ''}
                    onChange={(e) => {
                      const next = [...soloNameInputs];
                      next[idx] = e.target.value;
                      setSoloNameInputs(next);
                    }}
                    placeholder={`${idx + 1}번 플레이어 이름`}
                  />
                </div>
              ))}
            </div>
          </div>

          <button type="button" className="btn btn-success" onClick={goToSoloReady}>
            ➡️ 대국자 순서 확인하러 가기
          </button>
        </div>
      )}

      {gameState === 'READY' && (
        <div className="order-panel">
          <div className="order-header">
            <h2 style={{ margin: 0, fontSize: '20px', color: '#3e2723' }}>
              📋 대국자 좌석 배정을 확인하세요
            </h2>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: '8px 14px', fontSize: '13px' }}
              onClick={shuffleSoloOrder}
            >
              🎲 순서 섞기
            </button>
          </div>

          <div className="order-list">
            {soloPlayers.map((player, idx) => (
              <div key={player.id} className="order-item">
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <strong>{idx + 1}번 좌석</strong>
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
              {soloPlayers.map((p, idx) => {
                const isActive = !isSoloEnded && idx === soloTurnIdx;
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${
                      isActive ? 'active-turn-spotlight' : 'active-turn-unlight'
                    }`}
                  >
                    <div className="player-badge-top">
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '>'}
                        {p.name}
                      </strong>
                      <span className="disc-score-pill">🁣{p.hand.length}장</span>
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

          {/* 중앙 원목 도미노 보드 */}
          <div className="dom-table-board">
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
                      : `🔥 다음 대국 시작 (${soloAnteBet.toLocaleString()}칩 베팅)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={turnNotice} className="dom-notice-banner">
                {turnNotice}
              </div>
            )}

            <div className="dom-scoreboard-strip">
              <div className="center-pot-box">
                <span className="pot-label">💰 누적 POT</span>
                <strong className="pot-amount">{soloPot.toLocaleString()} 칩</strong>
              </div>
            </div>

            <div className="board-center-stage">
              {renderWoodenDominoTable(
                soloBoardChain,
                soloLastPlacedId,
                soloBoneyard.length,
                gameState === 'PLAYING',
                (t, side) => executeSoloPlayTile(t, side, false)
              )}
            </div>
          </div>

          {/* 하단 현재 차례 대국자 손패 도크 */}
          <div className="dom-bottom-dock">
            {isSoloEnded ? (
              <div className="waiting-dock-msg">
                🎉 대국 종료! <strong>[다음 대국 시작]</strong>을 눌러 계속 대국하세요!
              </div>
            ) : (
              <>
                <div className="dock-top-status">
                  <span className="turn-owner-pill large-turn-pill">
                    🪵 {currentSoloPlayer.name}님 차례 · 🏆{currentSoloPlayer.wins}승 · 💰
                    {currentSoloPlayer.chips.toLocaleString()}칩
                  </span>

                  {!soloPlayableExists && (
                    <div className="dock-action-buttons">
                      {soloBoneyard.length > 0 ? (
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ padding: '6px 12px', fontSize: '13px' }}
                          onClick={() => handleSoloDrawTile(false)}
                        >
                          🎴 더미에서 1장 뽑기 ({soloBoneyard.length}장)
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '6px 12px', fontSize: '13px' }}
                          onClick={() => handleSoloPassTurn(false)}
                        >
                          ⏭️ 낼 패 없음 (패스)
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="hand-tiles-rack">
                  {currentSoloPlayer.hand.map((tile) => {
                    const playable = canPlayTileAnywhere(tile, soloBoardChain);
                    const isSelected = pendingTileChoice?.id === tile.id;
                    return (
                      <button
                        key={tile.id}
                        type="button"
                        onClick={() =>
                          handleHandTileClick(tile, soloBoardChain, (t, side) =>
                            executeSoloPlayTile(t, side, false)
                          )
                        }
                        className={`hand-domino-card ${playable ? 'playable-glow' : ''} ${
                          isSelected ? 'selected-tile' : ''
                        }`}
                      >
                        <DominoHalfFace value={tile.left} />
                        <div className="domino-divider-bar">
                          <span className="brass-spinner-pin" />
                        </div>
                        <DominoHalfFace value={tile.right} />
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}