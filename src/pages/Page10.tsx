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

// 0: 빈 칸, 1: 레드(선공), 2: 블루(후공)
type ChipOwner = 0 | 1 | 2;

interface SeqDicePlayer {
  id: string;
  name: string;
  chipColor: 1 | 2;
  chips: number; // 보유 머니(칩)
  wins: number; // 누적 승수
  currentBet: number; // 이번 판 판돈
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

interface NetSeqDiceRoomData {
  roomId: number;
  status: 'EMPTY' | 'WAITING' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER';
  players: SeqDicePlayer[];
  pot: number;
  waitlist: WaitlistPlayer[];
  spectators: SpectatorPlayer[];
  baseTimeout: number;
  anteBet: number;
  roundNumber: number;
  board: ChipOwner[]; // 36칸 (6x6) 1차원 배열
  currentTurn: 1 | 2;
  dice: [number, number] | null; // 현재 굴린 주사위 2개 (null이면 굴리기 대기)
  lastMoveIdx: number | null;
  winningLine: number[]; // 승리한 5칸 인덱스
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

const WOOD_TABLE_THEMES = [
  'radial-gradient(circle at center, #795548 0%, #4e342e 65%, #2b1810 100%)',
];

const INITIAL_CHIPS = 10000;
const DEFAULT_TIMEOUT_SEC = 45;

/**
 * 6x6 (36칸) Sequence Dice 보드 숫자 배치
 * - 네 귀퉁이(0, 5, 30, 35): 2 (주사위 1+1)
 * - 중앙 4칸(14, 15, 20, 21): 12 (주사위 6+6)
 * - 외곽 테두리: 3, 4, 5, 6 나선형 배치
 * - 내부 테두리: 7, 8, 9 나선형 배치
 */
const BOARD_NUMBERS: readonly number[] = [
  2, 3, 4, 5, 6, 2,
  6, 7, 8, 9, 7, 3,
  5, 9, 12, 12, 8, 4,
  4, 8, 12, 12, 9, 5,
  3, 7, 9, 8, 7, 6,
  2, 6, 5, 4, 3, 2,
];

/**
 * 6x6 보드에서 가능한 모든 5연속(시퀀스) 승리 라인 (가로 12 + 세로 12 + 대각선 8 = 32개)
 */
const WINNING_LINES_5: readonly number[][] = (() => {
  const lines: number[][] = [];
  // 가로 5연속
  for (let r = 0; r < 6; r++) {
    lines.push([r * 6 + 0, r * 6 + 1, r * 6 + 2, r * 6 + 3, r * 6 + 4]);
    lines.push([r * 6 + 1, r * 6 + 2, r * 6 + 3, r * 6 + 4, r * 6 + 5]);
  }
  // 세로 5연속
  for (let c = 0; c < 6; c++) {
    lines.push([0 * 6 + c, 1 * 6 + c, 2 * 6 + c, 3 * 6 + c, 4 * 6 + c]);
    lines.push([1 * 6 + c, 2 * 6 + c, 3 * 6 + c, 4 * 6 + c, 5 * 6 + c]);
  }
  // 우하향 대각선 5연속
  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c <= 1; c++) {
      lines.push([
        r * 6 + c,
        (r + 1) * 6 + (c + 1),
        (r + 2) * 6 + (c + 2),
        (r + 3) * 6 + (c + 3),
        (r + 4) * 6 + (c + 4),
      ]);
    }
  }
  // 좌하향 대각선 5연속
  for (let r = 0; r <= 1; r++) {
    for (let c = 4; c <= 5; c++) {
      lines.push([
        r * 6 + c,
        (r + 1) * 6 + (c - 1),
        (r + 2) * 6 + (c - 2),
        (r + 3) * 6 + (c - 3),
        (r + 4) * 6 + (c - 4),
      ]);
    }
  }
  return lines;
})();

function createEmptyBoard(): ChipOwner[] {
  return Array(36).fill(0);
}

/**
 * 특정 플레이어(owner)가 5연속 시퀀스를 완성했는지 확인
 */
function findWinningSequence(board: ChipOwner[], owner: 1 | 2): number[] | null {
  for (const line of WINNING_LINES_5) {
    if (line.every((idx) => board[idx] === owner)) {
      return line;
    }
  }
  return null;
}

/**
 * 현재 주사위 합계(sum)에 따라 선택 가능한 유효 보드 칸 인덱스 목록 반환
 */
function getValidTargetsForRoll(
  board: ChipOwner[],
  diceSum: number,
  currentTurn: 1 | 2
): number[] {
  const opponent: 1 | 2 = currentTurn === 1 ? 2 : 1;
  const targets: number[] = [];

  if (diceSum === 10) {
    // 10 = REMOVE CHIP: 상대방 칩 중 하나 제거
    for (let i = 0; i < 36; i++) {
      if (board[i] === opponent) {
        targets.push(i);
      }
    }
    return targets;
  }

  if (diceSum === 11) {
    // 11 = WILD: 아무 빈 칸이나 배치 가능
    for (let i = 0; i < 36; i++) {
      if (board[i] === 0) {
        targets.push(i);
      }
    }
    return targets;
  }

  // 일반 숫자 (2, 3, 4, 5, 6, 7, 8, 9, 12): 해당 숫자의 빈 칸
  for (let i = 0; i < 36; i++) {
    if (BOARD_NUMBERS[i] === diceSum && board[i] === 0) {
      targets.push(i);
    }
  }
  return targets;
}

function createDefaultSeqDiceRoom(roomId: number): NetSeqDiceRoomData {
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
    board: createEmptyBoard(),
    currentTurn: 1,
    dice: null,
    lastMoveIdx: null,
    winningLine: [],
    turnDeadline: null,
    turnNotice: '',
    winnerAnnouncement: '',
    roundWinnerId: null,
    waitingSince: null,
  };
}

/**
 * 주사위 눈금 도트 렌더링 컴포넌트
 */
function DiceFacePipGrid({ value, size = 'md' }: { value: number; size?: 'sm' | 'md' | 'lg' }) {
  const pipMap: Record<number, number[]> = {
    1: [4],
    2: [2, 6],
    3: [2, 4, 6],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };
  const activePips = new Set(pipMap[value] || []);

  return (
    <span className={`sd-dice-face size-${size}`}>
      {Array.from({ length: 9 }, (_, idx) => (
        <span key={idx} className={`sd-pip ${activePips.has(idx) ? 'on' : ''}`} />
      ))}
    </span>
  );
}

export default function Page10() {
  const [appMode, setAppMode] = useState<
    'HOME' | 'SOLO' | 'NET_LOBBY' | 'NET_ROOM' | 'HALL_OF_FAME'
  >('HOME');

  const [mySessionId] = useState<string>(() => {
    const saved = sessionStorage.getItem('seqdice_net_uid');
    if (saved) return saved;
    const generated = `sd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('seqdice_net_uid', generated);
    return generated;
  });

  // 넷게임 상태
  const [rooms, setRooms] = useState<NetSeqDiceRoomData[]>(
    [1, 2, 3, 4].map(createDefaultSeqDiceRoom)
  );
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [joinModalRoom, setJoinModalRoom] = useState<NetSeqDiceRoomData | null>(null);
  const [joinPlayerName, setJoinPlayerName] = useState<string>('');
  const [remainingSeconds, setRemainingSeconds] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [waitingCountdownSec, setWaitingCountdownSec] = useState<number>(420);
  const [isRollingAnim, setIsRollingAnim] = useState<boolean>(false);

  const timeoutHandledRef = useRef<number | null>(null);
  const lastSpokenNoticeRef = useRef<string>('');
  const lastCountdownSpokenRef = useRef<number | null>(null);
  const roomsRefLatest = useRef<NetSeqDiceRoomData[]>(rooms);

  useEffect(() => {
    roomsRefLatest.current = rooms;
  }, [rooms]);

  // 단독게임(SOLO) 상태
  const [gameState, setGameState] = useState<
    'SETUP' | 'READY' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER'
  >('SETUP');
  const [soloPlayers, setSoloPlayers] = useState<SeqDicePlayer[]>([
    {
      id: '1',
      name: '레드킹',
      chipColor: 1,
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
    },
    {
      id: '2',
      name: '블루퀸',
      chipColor: 2,
      chips: INITIAL_CHIPS,
      wins: 0,
      currentBet: 0,
      isEliminated: false,
    },
  ]);

  const [soloName1, setSoloName1] = useState('레드킹');
  const [soloName2, setSoloName2] = useState('블루퀸');
  const [soloAnteBet, setSoloAnteBet] = useState<number>(1000);
  const [soloTimeoutSec, setSoloTimeoutSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRemainingSec, setSoloRemainingSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRoundNum, setSoloRoundNum] = useState<number>(1);
  const [soloPot, setSoloPot] = useState<number>(0);

  const [soloBoard, setSoloBoard] = useState<ChipOwner[]>(createEmptyBoard());
  const [soloTurn, setSoloTurn] = useState<1 | 2>(1);
  const [soloDice, setSoloDice] = useState<[number, number] | null>(null);
  const [soloLastMoveIdx, setSoloLastMoveIdx] = useState<number | null>(null);
  const [soloWinningLine, setSoloWinningLine] = useState<number[]>([]);
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

  const showToast = useCallback(
    (text: string, type: 'info' | 'success' | 'danger' | 'celebrate' = 'info') => {
      setToast({ id: Date.now(), text, type });
    },
    []
  );

  const speakKorean = useCallback((text: string, interrupt = true) => {
    if (!text || !('speechSynthesis' in window)) return;
    const cleanText = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
    if (!cleanText) return;
    if (interrupt) {
      window.speechSynthesis.cancel();
    }
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.12;
    utterance.pitch = 1.05;
    window.speechSynthesis.speak(utterance);
  }, []);

  const playSound = useCallback((kind: 'roll' | 'place' | 'remove' | 'chip' | 'win' | 'tick') => {
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
        roll: [320, 480, 390, 560],
        place: [260, 180],
        remove: [420, 220],
        chip: [880, 1174.66],
        win: [523.25, 659.25, 783.99, 1046.5, 1318.5],
        tick: [987.77],
      };

      notesMap[kind].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === 'place' ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.05);
        gain.gain.setValueAtTime(0.18, ctx.currentTime + idx * 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.05 + 0.16);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.05);
        osc.stop(ctx.currentTime + idx * 0.05 + 0.16);
      });
    } catch {
      // 오디오 차단 예외 무시
    }
  }, []);

  const triggerChipAnimation = useCallback(
    (playerName: string, amount: number, color: string) => {
      playSound('chip');
      const id = Date.now() + Math.random();
      setChipFlyEffects((prev) => [...prev, { id, playerName, amount, color }]);
      window.setTimeout(() => {
        setChipFlyEffects((prev) => prev.filter((item) => item.id !== id));
      }, 1050);
    },
    [playSound]
  );

  const triggerFireworksCelebration = useCallback(
    (announcementText: string) => {
      playSound('win');
      speakKorean(announcementText);
      setShowFireworks(true);
      window.setTimeout(() => {
        setShowFireworks(false);
      }, 4500);
    },
    [playSound, speakKorean]
  );

  const handleCountdownCue = useCallback(
    (secLeft: number) => {
      if (lastCountdownSpokenRef.current === secLeft) return;
      lastCountdownSpokenRef.current = secLeft;

      if (secLeft === 10) {
        playSound('tick');
        speakKorean('10초 남았습니다.', false);
      } else if (secLeft >= 1 && secLeft <= 5) {
        playSound('tick');
        speakKorean(String(secLeft), false);
      }
    },
    [playSound, speakKorean]
  );

  const saveHallOfFameRecord = (
    type: 'SOLO' | 'NET',
    record: { name: string; scoreOrLevel: string }
  ) => {
    const key = type === 'SOLO' ? 'seqdice_hof_solo' : 'seqdice_hof_net';
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
    const key = type === 'SOLO' ? 'seqdice_hof_solo' : 'seqdice_hof_net';
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      return [];
    }
  };

  // =========================================================================
  // 방 나가기 공통 처리 (버튼 클릭 & 브라우저 창 닫기 시 공용)
  // =========================================================================
  const leaveRoomById = useCallback(
    async (roomIdToLeave: number) => {
      const roomRef = ref(db, `seqdice_rooms/room_${roomIdToLeave}`);
      try {
        await runTransaction(roomRef, (roomData) => {
          if (!roomData) return roomData;
          const room = roomData as NetSeqDiceRoomData;
          const filteredPlayers = (room.players || []).filter((p) => p.id !== mySessionId);
          const filteredWaitlist = (room.waitlist || []).filter((w) => w.id !== mySessionId);
          const filteredSpectators = (room.spectators || []).filter((s) => s.id !== mySessionId);

          if (filteredPlayers.length === 0 && filteredSpectators.length === 0) {
            return createDefaultSeqDiceRoom(room.roomId);
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

    const presenceRef = ref(db, `seqdice_presence/room_${selectedRoomId}/${mySessionId}`);
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
        const roomRef = ref(db, `seqdice_rooms/room_${id}`);
        const snap = await get(roomRef);
        if (!snap.exists()) {
          await set(roomRef, createDefaultSeqDiceRoom(id));
        }
      }
    };
    void ensureRoomsExist();

    const roomsRef = ref(db, 'seqdice_rooms');
    const unsubscribe = onValue(roomsRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      const loadedRooms: NetSeqDiceRoomData[] = [1, 2, 3, 4].map((id) => {
        const rData = data[`room_${id}`];
        const def = createDefaultSeqDiceRoom(id);
        if (!rData) return def;

        const normalizedBoard: ChipOwner[] = Array.from({ length: 36 }, (_, i) => {
          const val = rData.board?.[i];
          return val === 1 || val === 2 ? val : 0;
        });

        const parsedDice: [number, number] | null =
          Array.isArray(rData.dice) && rData.dice.length === 2
            ? [Number(rData.dice[0]), Number(rData.dice[1])]
            : null;

        return {
          ...def,
          ...rData,
          players: (rData.players || []).map((p: SeqDicePlayer, idx: number) => ({
            ...p,
            chipColor: p.chipColor === 2 ? 2 : idx === 0 ? 1 : 2,
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
          dice: parsedDice,
          lastMoveIdx: typeof rData.lastMoveIdx === 'number' ? rData.lastMoveIdx : null,
          winningLine: Array.isArray(rData.winningLine) ? rData.winningLine : [],
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
    activeNetRoom,
    triggerFireworksCelebration,
    speakKorean,
  ]);

  /**
   * 넷게임 라운드 승리 정산 (5연속 시퀀스 달성 시)
   */
  const settleNetSeqDiceWin = (
    room: NetSeqDiceRoomData,
    winnerColor: 1 | 2,
    winLine: number[]
  ) => {
    const winner = room.players.find((p) => p.chipColor === winnerColor) || room.players[0];
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

    room.winningLine = winLine;
    room.pot = 0;
    room.dice = null;
    room.turnDeadline = null;
    room.turnNotice = '';
    room.roundWinnerId = winner.id;

    if (anyBusted) {
      room.status = 'MATCH_OVER';
      room.winnerAnnouncement = `👑 최종 우승! ${winner.name}님이 5연속 시퀀스 완성으로 상대 판돈을 모두 소진시켰습니다!`;
    } else {
      room.status = 'ROUND_OVER';
      room.winnerAnnouncement = `🎊 ${winner.name}님 5연속 시퀀스 완성! 판돈 ${wonPot.toLocaleString()}칩 독식! (${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}칩)`;
    }

    saveHallOfFameRecord('NET', {
      name: winner.name,
      scoreOrLevel: `${winnerObj.wins}승 · 보유 ${winnerObj.chips.toLocaleString()}칩`,
    });
  };

  /**
   * 넷게임 턴 시간 초과 자동 처리
   */
  const handleNetTurnTimeout = useCallback(async (room: NetSeqDiceRoomData) => {
    const roomRef = ref(db, `seqdice_rooms/room_${room.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const r = roomData as NetSeqDiceRoomData;
      if (r.status !== 'PLAYING') return r;

      const turnColor: 1 | 2 = r.currentTurn === 2 ? 2 : 1;
      const playersList = Array.isArray(r.players) ? r.players : [];
      const actor = playersList.find((p) => p.chipColor === turnColor);
      const boardCopy: ChipOwner[] = Array.from({ length: 36 }, (_, i) => {
        const val = r.board?.[i];
        return val === 1 || val === 2 ? val : 0;
      });

      let activeDice: [number, number] | null =
        Array.isArray(r.dice) && r.dice.length === 2
          ? [Number(r.dice[0]), Number(r.dice[1])]
          : null;

      if (!activeDice) {
        activeDice = [Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1];
      }
      const sum = activeDice[0] + activeDice[1];
      const targets = getValidTargetsForRoll(boardCopy, sum, turnColor);

      if (targets.length > 0) {
        const chosenIdx = targets[Math.floor(Math.random() * targets.length)];
        if (sum === 10) boardCopy[chosenIdx] = 0;
        else boardCopy[chosenIdx] = turnColor;
        r.board = boardCopy;
        r.lastMoveIdx = chosenIdx;
      }

      r.dice = null;
      const winLine = findWinningSequence(boardCopy, turnColor);
      if (winLine) {
        settleNetSeqDiceWin(r, turnColor, winLine);
        return r;
      }

      const nextColor: 1 | 2 = turnColor === 1 ? 2 : 1;
      const nextPlayer = playersList.find((p) => p.chipColor === nextColor);
      r.currentTurn = nextColor;
      r.turnDeadline = Date.now() + (r.baseTimeout || DEFAULT_TIMEOUT_SEC) * 1000;
      r.turnNotice = `⏰ 시간 초과로 ${actor?.name ?? '플레이어'}님 자동 진행! 👉 ${nextPlayer?.name ?? '상대'}님 차례!`;
      return r;
    });
  }, []);

  // 넷게임 카운트다운 타이머 (프리미티브 값만 의존성에 배치하여 트랜잭션 경합 방지)
  const netRoomId = activeNetRoom?.roomId ?? null;
  const netRoomStatus = activeNetRoom?.status ?? null;
  const netTurnDeadline = activeNetRoom?.turnDeadline ?? null;
  const netWaitingSince = activeNetRoom?.waitingSince ?? null;

  useEffect(() => {
    if (appMode !== 'NET_ROOM' || !netRoomId) {
      setRemainingSeconds(DEFAULT_TIMEOUT_SEC);
      setWaitingCountdownSec(420);
      return;
    }

    const timer = window.setInterval(async () => {
      const now = Date.now();

      if (netRoomStatus === 'WAITING' && netWaitingSince) {
        const elapsedSec = (now - netWaitingSince) / 1000;
        const leftSec = Math.max(0, 420 - Math.floor(elapsedSec));
        setWaitingCountdownSec(leftSec);

        if (elapsedSec >= 425) {
          const roomRef = ref(db, `seqdice_rooms/room_${netRoomId}`);
          await set(roomRef, createDefaultSeqDiceRoom(netRoomId));
          showToast('⏳ 대기 시간이 7분을 초과하여 방이 초기화되었습니다.', 'info');
          setSelectedRoomId(null);
          setAppMode('NET_LOBBY');
          return;
        }
      }

      if (netRoomStatus === 'PLAYING' && netTurnDeadline) {
        const diff = Math.max(0, Math.ceil((netTurnDeadline - now) / 1000));
        setRemainingSeconds(diff);
        handleCountdownCue(diff);

        if (diff === 0 && timeoutHandledRef.current !== netTurnDeadline) {
          timeoutHandledRef.current = netTurnDeadline;
          const latestRoom = roomsRefLatest.current.find((r) => r.roomId === netRoomId);
          if (latestRoom) {
            void handleNetTurnTimeout(latestRoom);
          }
        }
      }
    }, 300);

    return () => window.clearInterval(timer);
  }, [
    appMode,
    netRoomId,
    netRoomStatus,
    netTurnDeadline,
    netWaitingSince,
    handleCountdownCue,
    handleNetTurnTimeout,
    showToast,
  ]);

  const handleEnterRoomSubmit = async (asSpectator = false) => {
    if (!joinModalRoom) return;
    const trimmedName = joinPlayerName ? joinPlayerName.trim() : '';
    if (!trimmedName) {
      alert('참가할 이름을 입력해주세요!');
      return;
    }

    const roomRef = ref(db, `seqdice_rooms/room_${joinModalRoom.roomId}`);

    try {
      let joinResultType = 'PLAYER';

      await runTransaction(roomRef, (roomData) => {
        const room: NetSeqDiceRoomData =
          roomData || createDefaultSeqDiceRoom(joinModalRoom.roomId);
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
          const newPlayer: SeqDicePlayer = {
            id: mySessionId,
            name: trimmedName,
            chipColor,
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
    const clampedTimeout = Math.min(180, Math.max(15, newTimeout));
    const roomRef = ref(db, `seqdice_rooms/room_${activeNetRoom.roomId}`);
    await update(roomRef, {
      anteBet: newAnteBet,
      baseTimeout: clampedTimeout,
      waitingSince: Date.now(),
    });
  };

  const handleStartNetRound = async (isNextRound = false) => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `seqdice_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetSeqDiceRoomData;
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
      const nextActive: SeqDicePlayer[] = [...survivingPlayers];
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

      const preparedPlayers: SeqDicePlayer[] = orderedActive.map((p, idx) => {
        collectedPot += equalStake;
        return {
          ...p,
          chipColor: idx === 0 ? 1 : 2,
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
      room.board = createEmptyBoard();
      room.currentTurn = 1;
      room.dice = null;
      room.lastMoveIdx = null;
      room.winningLine = [];
      room.turnDeadline = Date.now() + (room.baseTimeout || DEFAULT_TIMEOUT_SEC) * 1000;
      room.winnerAnnouncement = '';
      room.roundWinnerId = null;
      room.turnNotice = `🎲 [${nextRound}국] 동일 판돈 ${equalStake.toLocaleString()}칩 베팅! 🔴레드 ${preparedPlayers[0].name}님 주사위를 굴려주세요!`;
      room.waitingSince = null;

      return room;
    });

    triggerChipAnimation('전원', activeNetRoom.anteBet, '#d32f2f');
  };

  /**
   * 넷게임 주사위 굴리기 (트랜잭션 안정화 및 오류 피드백 강화)
   */
  const handleNetRollDice = async () => {
    if (!activeNetRoom) return;
    if (activeNetRoom.status !== 'PLAYING') {
      showToast('현재 게임 진행 중이 아닙니다.', 'info');
      return;
    }
    if (activeNetRoom.dice !== null) {
      showToast('이미 주사위를 굴렸습니다. 보드에서 칸을 선택하세요!', 'info');
      return;
    }

    const roomPlayers = activeNetRoom.players || [];
    const amISpectator = (activeNetRoom.spectators || []).some((s) => s.id === mySessionId);
    const activeTurnPlayer = roomPlayers.find((p) => p.chipColor === activeNetRoom.currentTurn);

    if (amISpectator || !activeTurnPlayer || activeTurnPlayer.id !== mySessionId) {
      showToast('내 차례가 아닙니다.', 'danger');
      return;
    }

    playSound('roll');
    setIsRollingAnim(true);
    window.setTimeout(() => setIsRollingAnim(false), 380);

    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const sum = d1 + d2;

    const roomRef = ref(db, `seqdice_rooms/room_${activeNetRoom.roomId}`);

    try {
      const txResult = await runTransaction(roomRef, (roomData) => {
        if (!roomData) return roomData;
        const room = roomData as NetSeqDiceRoomData;

        if (room.status !== 'PLAYING') return room;
        if (Array.isArray(room.dice) && room.dice.length === 2) return room;

        const turnColor: 1 | 2 = room.currentTurn === 2 ? 2 : 1;
        const playersList = Array.isArray(room.players) ? room.players : [];
        const currentActor = playersList.find((p) => p.chipColor === turnColor);

        if (!currentActor || currentActor.id !== mySessionId) {
          return room;
        }

        const boardCopy: ChipOwner[] = Array.from({ length: 36 }, (_, i) => {
          const val = room.board?.[i];
          return val === 1 || val === 2 ? val : 0;
        });

        const validTargets = getValidTargetsForRoll(boardCopy, sum, turnColor);
        const nextDeadline = Date.now() + (room.baseTimeout || DEFAULT_TIMEOUT_SEC) * 1000;

        if (validTargets.length === 0) {
          if (sum === 2 || sum === 12) {
            room.dice = null;
            room.turnDeadline = nextDeadline;
            room.turnNotice = `🎲 ${currentActor.name}님 주사위 [${d1}+${d2}=${sum}]! 보너스 턴으로 한 번 더 굴립니다!`;
          } else {
            const nextColor: 1 | 2 = turnColor === 1 ? 2 : 1;
            const nextPlayer = playersList.find((p) => p.chipColor === nextColor);
            room.dice = null;
            room.currentTurn = nextColor;
            room.turnDeadline = nextDeadline;
            room.turnNotice = `🎲 ${currentActor.name}님 [${d1}+${d2}=${sum}] 나왔으나 선택 가능한 칸이 없어 👉 ${nextPlayer?.name ?? '상대'}님 차례로 넘어갑니다!`;
          }
          return room;
        }

        room.dice = [d1, d2];
        room.turnDeadline = nextDeadline;

        if (sum === 10) {
          room.turnNotice = `🎲 [${d1}+${d2}=10] REMOVE CHIP! 상대방 칩 하나를 눌러 제거하세요!`;
        } else if (sum === 11) {
          room.turnNotice = `🎲 [${d1}+${d2}=11] WILD! 보드의 빈 칸 아무 곳이나 눌러 칩을 놓으세요!`;
        } else if (sum === 2 || sum === 12) {
          room.turnNotice = `🎲 [${d1}+${d2}=${sum}] 보너스 칸 배치 후 주사위를 한 번 더 굴립니다!`;
        } else {
          room.turnNotice = `🎲 ${currentActor.name}님 주사위 [${d1}+${d2}=${sum}]! 반짝이는 [${sum}] 칸을 선택하세요.`;
        }

        return room;
      });

      if (!txResult.committed) {
        showToast('차례 정보 동기화 중입니다. 잠시 후 다시 눌러주세요.', 'info');
      }
    } catch (err) {
      console.error('주사위 굴리기 트랜잭션 실패:', err);
      showToast('Firebase 업데이트 중 오류가 발생했습니다.', 'danger');
    }
  };

  /**
   * 넷게임 보드 칸 선택 처리
   */
  const handleNetCellClick = async (idx: number) => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING' || !activeNetRoom.dice) return;
    const actor = (activeNetRoom.players || []).find(
      (p) => p.chipColor === activeNetRoom.currentTurn
    );
    if (!actor || actor.id !== mySessionId) return;

    const sum = activeNetRoom.dice[0] + activeNetRoom.dice[1];
    const validTargets = getValidTargetsForRoll(
      activeNetRoom.board,
      sum,
      activeNetRoom.currentTurn
    );
    if (!validTargets.includes(idx)) {
      showToast('현재 주사위 눈금으로 선택할 수 없는 칸입니다!', 'danger');
      return;
    }

    playSound(sum === 10 ? 'remove' : 'place');
    const roomRef = ref(db, `seqdice_rooms/room_${activeNetRoom.roomId}`);

    try {
      await runTransaction(roomRef, (roomData) => {
        if (!roomData) return roomData;
        const room = roomData as NetSeqDiceRoomData;
        if (room.status !== 'PLAYING' || !Array.isArray(room.dice) || room.dice.length !== 2) {
          return room;
        }

        const turnColor: 1 | 2 = room.currentTurn === 2 ? 2 : 1;
        const playersList = Array.isArray(room.players) ? room.players : [];
        const currentActor = playersList.find((p) => p.chipColor === turnColor);
        if (!currentActor || currentActor.id !== mySessionId) return room;

        const rollSum = Number(room.dice[0]) + Number(room.dice[1]);
        const boardCopy: ChipOwner[] = Array.from({ length: 36 }, (_, i) => {
          const val = room.board?.[i];
          return val === 1 || val === 2 ? val : 0;
        });
        const targets = getValidTargetsForRoll(boardCopy, rollSum, turnColor);
        if (!targets.includes(idx)) return room;

        if (rollSum === 10) {
          boardCopy[idx] = 0; // 상대 칩 제거
        } else {
          boardCopy[idx] = turnColor; // 내 칩 배치
        }

        room.board = boardCopy;
        room.lastMoveIdx = idx;
        room.dice = null;

        // 5연속 시퀀스 승리 판정
        const winLine = findWinningSequence(boardCopy, turnColor);
        if (winLine) {
          settleNetSeqDiceWin(room, turnColor, winLine);
          return room;
        }

        const nextDeadline = Date.now() + (room.baseTimeout || DEFAULT_TIMEOUT_SEC) * 1000;

        // 2 또는 12는 한 번 더 주사위 굴리기 보너스!
        if (rollSum === 2 || rollSum === 12) {
          room.currentTurn = turnColor;
          room.turnDeadline = nextDeadline;
          room.turnNotice = `✨ [${rollSum}] 보너스! ${currentActor.name}님이 주사위를 한 번 더 굴립니다!`;
          return room;
        }

        const nextColor: 1 | 2 = turnColor === 1 ? 2 : 1;
        const nextPlayer = playersList.find((p) => p.chipColor === nextColor);
        room.currentTurn = nextColor;
        room.turnDeadline = nextDeadline;
        room.turnNotice =
          rollSum === 10
            ? `💥 ${currentActor.name}님이 상대 칩 제거 완료! 👉 ${nextPlayer?.name ?? '상대'}님 주사위를 굴려주세요!`
            : `✅ ${currentActor.name}님 [${BOARD_NUMBERS[idx]}] 칸 배치 완료! 👉 ${nextPlayer?.name ?? '상대'}님 주사위를 굴려주세요!`;

        return room;
      });
    } catch (err) {
      console.error('칸 선택 트랜잭션 오류:', err);
      showToast('보드 동기화 중 오류가 발생했습니다.', 'danger');
    }
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
    setSoloPlayers([
      {
        id: '1',
        name: soloName1.trim() || '레드킹',
        chipColor: 1,
        chips: INITIAL_CHIPS,
        wins: 0,
        currentBet: 0,
        isEliminated: false,
      },
      {
        id: '2',
        name: soloName2.trim() || '블루퀸',
        chipColor: 2,
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

    const preparedPlayers = orderedPlayers.map((p) => {
      totalPot += equalStake;
      return {
        ...p,
        chips: p.chips - equalStake,
        currentBet: equalStake,
      };
    });

    triggerChipAnimation('전원', equalStake, '#d32f2f');
    const notice = `🎲 [${nextRound}국] 동일 판돈 ${equalStake.toLocaleString()}칩 베팅! 🔴레드 ${preparedPlayers[0].name}님 주사위를 굴려주세요!`;

    setSoloRoundNum(nextRound);
    setSoloPot(totalPot);
    setSoloPlayers(preparedPlayers);
    setSoloBoard(createEmptyBoard());
    setSoloTurn(1);
    setSoloDice(null);
    setSoloLastMoveIdx(null);
    setSoloWinningLine([]);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setWinnerAnnouncement('');
    setShowFireworks(false);
    setTurnNotice(notice);
    speakKorean(notice);
    setGameState('PLAYING');
  };

  const settleSoloSeqDiceWin = useCallback(
    (winnerColor: 1 | 2, winLine: number[]) => {
      const winner = soloPlayers.find((p) => p.chipColor === winnerColor) || soloPlayers[0];
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
        ? `👑 최종 우승! ${winner.name}님이 5연속 시퀀스를 완성하여 상대 판돈을 모두 소진시켰습니다!`
        : `🎊 ${winner.name}님 5연속 시퀀스 완성! 판돈 ${soloPot.toLocaleString()}칩 독식! (${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}칩)`;

      setSoloPlayers(settledPlayers);
      setSoloWinningLine(winLine);
      setSoloPot(0);
      setSoloDice(null);
      setTurnNotice('');
      setWinnerAnnouncement(announcement);
      setGameState(anyBusted ? 'MATCH_OVER' : 'ROUND_OVER');
      triggerFireworksCelebration(announcement);

      saveHallOfFameRecord('SOLO', {
        name: winner.name,
        scoreOrLevel: `${winnerObj.wins}승 · 보유 ${winnerObj.chips.toLocaleString()}칩`,
      });
    },
    [soloPlayers, soloPot, triggerFireworksCelebration]
  );

  const handleSoloRollDice = useCallback(
    (isAuto = false) => {
      if (gameState !== 'PLAYING' || soloDice !== null) return;

      playSound('roll');
      setIsRollingAnim(true);
      window.setTimeout(() => setIsRollingAnim(false), 380);

      const d1 = Math.floor(Math.random() * 6) + 1;
      const d2 = Math.floor(Math.random() * 6) + 1;
      const sum = d1 + d2;
      const actor = soloPlayers.find((p) => p.chipColor === soloTurn)!;
      const validTargets = getValidTargetsForRoll(soloBoard, sum, soloTurn);

      setSoloRemainingSec(soloTimeoutSec);
      lastCountdownSpokenRef.current = null;

      if (validTargets.length === 0) {
        if (sum === 2 || sum === 12) {
          const notice = `🎲 ${actor.name}님 주사위 [${d1}+${d2}=${sum}]! 보너스 턴으로 한 번 더 굴립니다!`;
          setSoloDice(null);
          setTurnNotice(notice);
          speakKorean(notice);
        } else {
          const nextColor: 1 | 2 = soloTurn === 1 ? 2 : 1;
          const nextPlayer = soloPlayers.find((p) => p.chipColor === nextColor)!;
          const notice = `🎲 ${actor.name}님 [${d1}+${d2}=${sum}] 나왔으나 선택 가능한 칸이 없어 👉 ${nextPlayer.name}님 차례로 넘어갑니다!`;
          setSoloDice(null);
          setSoloTurn(nextColor);
          setTurnNotice(notice);
          speakKorean(notice);
        }
        return;
      }

      setSoloDice([d1, d2]);
      const prefix = isAuto ? '⏰ 자동 주사위! ' : '🎲 ';
      let notice = `${prefix}${actor.name}님 주사위 [${d1}+${d2}=${sum}]! 반짝이는 [${sum}] 칸을 선택하세요.`;
      if (sum === 10) {
        notice = `${prefix}[${d1}+${d2}=10] REMOVE CHIP! 상대방 칩 하나를 눌러 제거하세요!`;
      } else if (sum === 11) {
        notice = `${prefix}[${d1}+${d2}=11] WILD! 보드의 빈 칸 아무 곳이나 눌러 칩을 놓으세요!`;
      } else if (sum === 2 || sum === 12) {
        notice = `${prefix}[${d1}+${d2}=${sum}] 보너스 칸 배치 후 주사위를 한 번 더 굴립니다!`;
      }
      setTurnNotice(notice);
      speakKorean(notice);
    },
    [gameState, soloDice, playSound, soloPlayers, soloTurn, soloBoard, soloTimeoutSec, speakKorean]
  );

  const handleSoloCellClick = useCallback(
    (idx: number, isAuto = false) => {
      if (gameState !== 'PLAYING' || !soloDice) return;
      const sum = soloDice[0] + soloDice[1];
      const validTargets = getValidTargetsForRoll(soloBoard, sum, soloTurn);

      if (!validTargets.includes(idx)) {
        if (!isAuto) showToast('현재 주사위 눈금으로 선택할 수 없는 칸입니다!', 'danger');
        return;
      }

      playSound(sum === 10 ? 'remove' : 'place');
      const nextBoard = [...soloBoard];
      if (sum === 10) {
        nextBoard[idx] = 0;
      } else {
        nextBoard[idx] = soloTurn;
      }

      setSoloBoard(nextBoard);
      setSoloLastMoveIdx(idx);
      setSoloDice(null);

      const winLine = findWinningSequence(nextBoard, soloTurn);
      if (winLine) {
        settleSoloSeqDiceWin(soloTurn, winLine);
        return;
      }

      const actor = soloPlayers.find((p) => p.chipColor === soloTurn)!;
      setSoloRemainingSec(soloTimeoutSec);
      lastCountdownSpokenRef.current = null;

      if (sum === 2 || sum === 12) {
        const notice = `✨ [${sum}] 보너스! ${actor.name}님이 주사위를 한 번 더 굴립니다!`;
        setTurnNotice(notice);
        speakKorean(notice);
        return;
      }

      const nextColor: 1 | 2 = soloTurn === 1 ? 2 : 1;
      const nextPlayer = soloPlayers.find((p) => p.chipColor === nextColor)!;
      const notice =
        sum === 10
          ? `💥 ${actor.name}님이 상대 칩 제거 완료! 👉 ${nextPlayer.name}님 주사위를 굴려주세요!`
          : `✅ ${actor.name}님 [${BOARD_NUMBERS[idx]}] 칸 배치 완료! 👉 ${nextPlayer.name}님 주사위를 굴려주세요!`;
      setSoloTurn(nextColor);
      setTurnNotice(notice);
      speakKorean(notice);
    },
    [
      gameState,
      soloDice,
      soloBoard,
      soloTurn,
      showToast,
      playSound,
      settleSoloSeqDiceWin,
      soloPlayers,
      soloTimeoutSec,
      speakKorean,
    ]
  );

  // 단독게임(SOLO) 타이머
  useEffect(() => {
    if (appMode !== 'SOLO' || gameState !== 'PLAYING') return;

    const timer = window.setInterval(() => {
      setSoloRemainingSec((prev) => {
        const next = Math.max(0, prev - 1);
        handleCountdownCue(next);
        if (next === 0) {
          if (!soloDice) {
            handleSoloRollDice(true);
          } else {
            const sum = soloDice[0] + soloDice[1];
            const validTargets = getValidTargetsForRoll(soloBoard, sum, soloTurn);
            if (validTargets.length > 0) {
              const randIdx = validTargets[Math.floor(Math.random() * validTargets.length)];
              handleSoloCellClick(randIdx, true);
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
    soloDice,
    soloBoard,
    soloTurn,
    handleCountdownCue,
    handleSoloRollDice,
    handleSoloCellClick,
  ]);

  // =========================================================================
  // 6x6 Sequence Dice 보드 렌더링
  // =========================================================================
  const renderSequenceDiceBoard = (
    board: ChipOwner[],
    activeTurn: 1 | 2,
    activeDice: [number, number] | null,
    canInteract: boolean,
    lastMoveIdx: number | null,
    winningLine: number[],
    onCellClick: (idx: number) => void
  ) => {
    const diceSum = activeDice ? activeDice[0] + activeDice[1] : null;
    const validTargetsSet = new Set(
      canInteract && diceSum !== null ? getValidTargetsForRoll(board, diceSum, activeTurn) : []
    );
    const winSet = new Set(winningLine);

    return (
      <div className="sd-board-casing">
        {/* 상단 블랙 베젤 */}
        <div className="sd-top-bezel">
          <span className="sd-bezel-emblem">🎲</span>
          <span className="sd-rule-pill upside-down">11 = WILD</span>
          <span className="sd-brand-title upside-down">SEQUENCE DICE.</span>
          <span className="sd-rule-pill upside-down">10 = REMOVE CHIP</span>
          <span className="sd-bezel-emblem">🎲</span>
        </div>

        {/* 6x6 중앙 흰색 & 회색 격자 보드 */}
        <div className="sd-grid-6x6">
          {BOARD_NUMBERS.map((num, idx) => {
            const chipOwner = board[idx];
            const isCornerTwo = num === 2;
            const isCenterTwelve = num === 12;
            const isSpecialTile = isCornerTwo || isCenterTwelve;
            const isTarget = validTargetsSet.has(idx);
            const isLast = lastMoveIdx === idx;
            const isWinCell = winSet.has(idx);
            const needsUnderline = num === 6 || num === 9;

            return (
              <button
                key={idx}
                type="button"
                disabled={!isTarget}
                onClick={() => onCellClick(idx)}
                className={`sd-cell ${isSpecialTile ? 'special-tile' : 'normal-tile'} ${
                  isTarget ? (diceSum === 10 ? 'target-remove' : 'target-place') : ''
                } ${isLast ? 'last-moved' : ''} ${isWinCell ? 'win-highlight' : ''}`}
                aria-label={`${num}번 칸`}
              >
                <span className="sd-corner-num top-left">{num}</span>
                <span className="sd-corner-num bottom-right">{num}</span>

                {isCornerTwo ? (
                  <div className="sd-tile-dice-pair">
                    <DiceFacePipGrid value={1} size="sm" />
                    <DiceFacePipGrid value={1} size="sm" />
                  </div>
                ) : isCenterTwelve ? (
                  <div className="sd-tile-dice-pair">
                    <DiceFacePipGrid value={6} size="sm" />
                    <DiceFacePipGrid value={6} size="sm" />
                  </div>
                ) : (
                  <span className={`sd-center-number ${needsUnderline ? 'underlined' : ''}`}>
                    {num}
                  </span>
                )}

                {chipOwner !== 0 && (
                  <span
                    className={`sd-board-chip ${chipOwner === 1 ? 'red-chip' : 'blue-chip'} ${
                      isLast ? 'chip-drop-anim' : ''
                    } ${isWinCell ? 'chip-win-pulse' : ''}`}
                  >
                    <i className="sd-chip-groove" />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* 하단 블랙 베젤 */}
        <div className="sd-bottom-bezel">
          <span className="sd-bezel-emblem">🎲</span>
          <span className="sd-rule-pill">10 = REMOVE CHIP</span>
          <span className="sd-brand-title">SEQUENCE DICE.</span>
          <span className="sd-rule-pill">11 = WILD</span>
          <span className="sd-bezel-emblem">🎲</span>
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
      <div className="sd-container" style={{ background: WOOD_TABLE_THEMES[0] }}>
        <div className="setup-card home-entry-card">
          <div className="home-castle-icon">🎲🔴🔵</div>
          <h1 className="setup-title">SEQUENCE DICE (시퀀스 다이스)</h1>
          <p className="home-subtitle">
            주사위 2개로 만드는 5연속 시퀀스 · 동일 판돈 승자 독식 · 승점 &amp; 판돈 누적
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
              <span className="mode-desc">2인 로컬 대결 · 동일 판돈 연승 매치</span>
            </button>

            <button
              type="button"
              className="mode-select-btn net"
              onClick={() => setAppMode('NET_LOBBY')}
            >
              <span className="mode-icon">🌐</span>
              <strong>넷게임</strong>
              <span className="mode-desc">실시간 4개 테이블 대전 &amp; 관망</span>
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
      <div className="sd-container" style={{ background: WOOD_TABLE_THEMES[0], padding: '16px' }}>
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
            <h2 style={{ margin: 0, color: '#1e293b' }}>🏅 명예의 전당</h2>
            <div style={{ width: '60px' }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div className="hof-box">
              <h3 className="hof-title solo">🎮 단독 매치 TOP 10</h3>
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
                      <span style={{ color: '#b91c1c', fontWeight: 800 }}>{rec.scoreOrLevel}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="hof-box">
              <h3 className="hof-title net">🌐 넷게임 TOP 10</h3>
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
                      <span style={{ color: '#1d4ed8', fontWeight: 800 }}>{rec.scoreOrLevel}</span>
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
      <div className="sd-container" style={{ background: WOOD_TABLE_THEMES[0] }}>
        <div className="net-lobby-container">
          <div className="net-lobby-header">
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, fontSize: '19px', color: '#0f172a' }}>
              🌐 SEQUENCE DICE 넷게임 (4개 방)
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

              let statusBadgeText = '🟢 빈 테이블';
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
                    <span className="room-number-title">🎲 제 {room.roomId} 다이스룸</span>
                    <span className={`room-status-pill ${statusClass}`}>{statusBadgeText}</span>
                  </div>

                  <div className="room-rules-info">
                    <span>💰 동일 판돈: {room.anteBet.toLocaleString()}칩</span>
                    <span>⏱️ 턴 제한: {room.baseTimeout}초</span>
                  </div>

                  <div className="room-members-box">
                    <div className="room-members-label">참가자 ({roomPlayers.length}/2):</div>
                    <div className="room-members-chips">
                      {roomPlayers.length === 0 ? (
                        <span className="empty-member-text">첫 번째 참가자를 기다리고 있습니다</span>
                      ) : (
                        roomPlayers.map((p) => (
                          <span key={p.id} className="member-chip">
                            <span
                              className={`mini-chip-icon ${p.chipColor === 1 ? 'red' : 'blue'}`}
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
                      ? '👉 클릭하여 방 열기 또는 관망하기'
                      : isPlaying || isFull
                      ? '👉 클릭하여 다음 판 예약 또는 관망하기'
                      : '👉 클릭하여 대결 참가 또는 관망하기'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {joinModalRoom && (
          <div className="modal-overlay" onClick={() => setJoinModalRoom(null)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h2 style={{ margin: '0 0 8px' }}>🎲 제 {joinModalRoom.roomId} 다이스룸 입장</h2>
              <p className="modal-subtext">
                동일 판돈 <strong>{joinModalRoom.anteBet.toLocaleString()}칩</strong>을 걸고 5연속
                시퀀스 승부를 펼칩니다.
              </p>

              <input
                type="text"
                className="player-input"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: '14px' }}
                placeholder="참가자 이름 입력 (예: 레드킹)"
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
                  🚀 게임 참가 / 예약
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
          className="sd-container"
          style={{
            background: WOOD_TABLE_THEMES[0],
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div className="setup-card" style={{ textAlign: 'center' }}>
            <h2>⏳ 테이블 정보를 불러오는 중입니다...</h2>
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
        <div className="sd-container" style={{ background: WOOD_TABLE_THEMES[0] }}>
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
                제 {activeNetRoom.roomId}룸 · 대기 중 (⏱️ {countdownStr})
              </span>
            </div>

            <h1 className="setup-title" style={{ marginTop: '14px' }}>
              🎲 SEQUENCE DICE 대기실 {amISpectator ? '👀 [관망모드]' : ''}
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
                ⏱️ 턴 제한시간: <strong>{activeNetRoom.baseTimeout}초</strong>{' '}
                {isHost ? '(방장 설정 가능)' : ''}
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700 }}>15초</span>
                <input
                  type="range"
                  min={15}
                  max={180}
                  step={15}
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
              <label className="setting-label">🧭 입장한 플레이어 (2명 입장 시 시작 가능)</label>
              <div className="player-list">
                {roomPlayers.map((p, idx) => (
                  <div key={p.id} className="player-item">
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span
                        className={`mini-chip-icon large ${p.chipColor === 1 ? 'red' : 'blue'}`}
                      />
                      {p.name} ({p.chipColor === 1 ? '🔴레드' : '🔵블루'}){' '}
                      {idx === 0 && '👑(방장)'} {p.id === mySessionId && '(나)'}
                    </span>
                    <span style={{ fontSize: '12px', color: '#15803d' }}>
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
              🚀 게임 시작! (전원 {activeNetRoom.anteBet.toLocaleString()}칩 동일 베팅)
            </button>
          </div>
        </div>
      );
    }

    const activeTurnPlayer = roomPlayers.find((p) => p.chipColor === activeNetRoom.currentTurn);
    const isMyTurn =
      activeNetRoom.status === 'PLAYING' &&
      !amISpectator &&
      activeTurnPlayer?.id === mySessionId;
    const isRoundEnded =
      activeNetRoom.status === 'ROUND_OVER' || activeNetRoom.status === 'MATCH_OVER';
    const netDiceSum = activeNetRoom.dice ? activeNetRoom.dice[0] + activeNetRoom.dice[1] : null;

    return (
      <div className="sd-container" style={{ background: WOOD_TABLE_THEMES[0] }}>
        {renderFireworksAndChips()}

        {toast && (
          <div key={toast.id} className={`sd-toast ${toast.type}`}>
            {toast.text}
          </div>
        )}

        <div className="play-wrapper compact-tablet-mode">
          {/* 상단 헤더 */}
          <div className="game-header compact-header">
            <div className="net-level-timer-box">
              <span className="net-level-badge">
                제 {activeNetRoom.roundNumber}국 {amISpectator ? '👀[관망]' : ''}
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
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${isActive ? 'active-turn-spotlight' : ''}`}
                  >
                    <div className="player-badge-top">
                      <span
                        className={`mini-chip-icon ${p.chipColor === 1 ? 'red' : 'blue'}`}
                      />
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '▶ '}
                        {p.name}
                        {p.id === mySessionId ? '(나)' : ''}
                      </strong>
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

          {/* 중앙 게임 테이블 */}
          <div className="sd-table-board">
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
                      : `🔥 다음 라운드 시작 (${activeNetRoom.anteBet.toLocaleString()}칩)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={activeNetRoom.turnNotice} className="sd-notice-banner">
                {activeNetRoom.turnNotice}
              </div>
            )}

            {/* 상단 POT & 주사위 액션 스트립 */}
            <div className="sd-pot-dice-strip">
              <div className="center-pot-box">
                <span className="pot-label">💰 누적 POT</span>
                <strong className="pot-amount">
                  {(activeNetRoom.pot || 0).toLocaleString()} 칩
                </strong>
              </div>

              {activeNetRoom.status === 'PLAYING' && (
                <div className="dice-control-cluster">
                  {activeNetRoom.dice ? (
                    <div className={`rolled-dice-pair ${isRollingAnim ? 'rolling' : ''}`}>
                      <DiceFacePipGrid value={activeNetRoom.dice[0]} size="md" />
                      <DiceFacePipGrid value={activeNetRoom.dice[1]} size="md" />
                      <span className="dice-sum-badge">
                        합계 {netDiceSum}
                        {netDiceSum === 10
                          ? ' (제거)'
                          : netDiceSum === 11
                          ? ' (와일드)'
                          : netDiceSum === 2 || netDiceSum === 12
                          ? ' (보너스)'
                          : ''}
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-roll-dice"
                      disabled={!isMyTurn}
                      onClick={() => void handleNetRollDice()}
                    >
                      🎲 주사위 2개 굴리기
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* 6x6 Sequence Dice 보드 */}
            <div className="board-center-stage">
              {renderSequenceDiceBoard(
                activeNetRoom.board,
                activeNetRoom.currentTurn,
                activeNetRoom.dice,
                isMyTurn,
                activeNetRoom.lastMoveIdx,
                activeNetRoom.winningLine,
                (idx) => void handleNetCellClick(idx)
              )}
            </div>
          </div>

          {/* 하단 상태 도크 */}
          <div className="sd-bottom-dock">
            <div className="dock-top-status">
              {amISpectator ? (
                <span className="waiting-dock-msg">👀 관망 모드로 대결을 지켜보고 있습니다.</span>
              ) : isRoundEnded ? (
                <span className="waiting-dock-msg">
                  🏆 라운드 종료! 상단의 <strong>[다음 라운드 시작]</strong> 버튼으로 승수와 판돈을
                  이어가세요!
                </span>
              ) : (
                <span className="turn-owner-pill large-turn-pill">
                  {activeNetRoom.currentTurn === 1 ? '🔴 레드' : '🔵 블루'}{' '}
                  {activeTurnPlayer?.name}님 차례
                  {isMyTurn
                    ? activeNetRoom.dice
                      ? ' · 보드에서 반짝이는 숫자 칸을 선택하세요!'
                      : ' · [주사위 2개 굴리기] 버튼을 눌러주세요!'
                    : ' · 상대방 진행 중...'}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // 5. 단독게임(SOLO) - 2인 로컬 Sequence Dice 연승 매치
  // =========================================================================
  const currentSoloPlayer =
    soloPlayers.find((p) => p.chipColor === soloTurn) || soloPlayers[0];
  const isSoloEnded = gameState === 'ROUND_OVER' || gameState === 'MATCH_OVER';
  const soloDiceSum = soloDice ? soloDice[0] + soloDice[1] : null;

  return (
    <div className="sd-container" style={{ background: WOOD_TABLE_THEMES[0] }}>
      {renderFireworksAndChips()}

      {toast && (
        <div key={toast.id} className={`sd-toast ${toast.type}`}>
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
          <h1 className="setup-title">🎲 SEQUENCE DICE (단독게임 설정)</h1>

          <div className="setting-section">
            <label className="setting-label">
              💰 매 라운드 동일 판돈 설정 (초기 지급 10,000칩)
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
              <span style={{ fontSize: '12px', fontWeight: 700 }}>15초</span>
              <input
                type="range"
                min={15}
                max={180}
                step={15}
                value={soloTimeoutSec}
                style={{ flex: 1 }}
                onChange={(e) => setSoloTimeoutSec(Number(e.target.value))}
              />
              <span style={{ fontSize: '12px', fontWeight: 700 }}>180초</span>
            </div>
          </div>

          <div className="setting-section">
            <label className="setting-label">🧭 플레이어 이름 설정 (2인 대전)</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="player-item">
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="mini-chip-icon large red" />
                  <span>선공 (레드 칩)</span>
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
                  <span className="mini-chip-icon large blue" />
                  <span>후공 (블루 칩)</span>
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
            ➡️ 선공/후공 확인하러 가기
          </button>
        </div>
      )}

      {gameState === 'READY' && (
        <div className="order-panel">
          <div className="order-header">
            <h2 style={{ margin: 0, fontSize: '20px', color: '#0f172a' }}>
              📋 레드/블루 칩 배정을 확인하세요
            </h2>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: '8px 14px', fontSize: '13px' }}
              onClick={swapSoloOrder}
            >
              🔄 레드/블루 맞바꾸기
            </button>
          </div>

          <div className="order-list">
            {soloPlayers.map((player) => (
              <div key={player.id} className="order-item">
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span
                    className={`mini-chip-icon large ${player.chipColor === 1 ? 'red' : 'blue'}`}
                  />
                  <strong>{player.chipColor === 1 ? '선공 (🔴 레드)' : '후공 (🔵 블루)'}</strong>
                  <span>{player.name}</span>
                </span>
                <span style={{ fontSize: '13px', color: '#475569', fontWeight: 800 }}>
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
              🚀 게임 시작! (전원 {soloAnteBet.toLocaleString()}칩 동일 베팅)
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
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${isActive ? 'active-turn-spotlight' : ''}`}
                  >
                    <div className="player-badge-top">
                      <span
                        className={`mini-chip-icon ${p.chipColor === 1 ? 'red' : 'blue'}`}
                      />
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '▶ '}
                        {p.name}
                      </strong>
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

          {/* 중앙 게임 테이블 */}
          <div className="sd-table-board">
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
                      : `🔥 다음 라운드 시작 (${soloAnteBet.toLocaleString()}칩)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={turnNotice} className="sd-notice-banner">
                {turnNotice}
              </div>
            )}

            {/* 상단 POT & 주사위 굴리기 스트립 */}
            <div className="sd-pot-dice-strip">
              <div className="center-pot-box">
                <span className="pot-label">💰 누적 POT</span>
                <strong className="pot-amount">{soloPot.toLocaleString()} 칩</strong>
              </div>

              {gameState === 'PLAYING' && (
                <div className="dice-control-cluster">
                  {soloDice ? (
                    <div className={`rolled-dice-pair ${isRollingAnim ? 'rolling' : ''}`}>
                      <DiceFacePipGrid value={soloDice[0]} size="md" />
                      <DiceFacePipGrid value={soloDice[1]} size="md" />
                      <span className="dice-sum-badge">
                        합계 {soloDiceSum}
                        {soloDiceSum === 10
                          ? ' (제거)'
                          : soloDiceSum === 11
                          ? ' (와일드)'
                          : soloDiceSum === 2 || soloDiceSum === 12
                          ? ' (보너스)'
                          : ''}
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-roll-dice"
                      onClick={() => handleSoloRollDice(false)}
                    >
                      🎲 주사위 2개 굴리기
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* 6x6 Sequence Dice 보드 */}
            <div className="board-center-stage">
              {renderSequenceDiceBoard(
                soloBoard,
                soloTurn,
                soloDice,
                gameState === 'PLAYING',
                soloLastMoveIdx,
                soloWinningLine,
                (idx) => handleSoloCellClick(idx, false)
              )}
            </div>
          </div>

          {/* 하단 상태 도크 */}
          <div className="sd-bottom-dock">
            <div className="dock-top-status">
              {isSoloEnded ? (
                <span className="waiting-dock-msg">
                  🎉 라운드 종료! <strong>[다음 라운드 시작]</strong>을 눌러 레드/블루를 교대해
                  계속 대결하세요!
                </span>
              ) : (
                <span className="turn-owner-pill large-turn-pill">
                  {soloTurn === 1 ? '🔴 레드' : '🔵 블루'} {currentSoloPlayer.name}님 차례 · 🏆
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