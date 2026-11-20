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
import './Page4.css';

export type FlipCardKind = 'NUMBER' | 'MODIFIER' | 'ACTION';
export type FlipActionType = 'FREEZE' | 'FLIP_THREE' | 'SECOND_CHANCE';
export type FlipModifierType = 'PLUS_2' | 'PLUS_4' | 'PLUS_6' | 'PLUS_8' | 'PLUS_10' | 'MULTI_2';

export interface Flip7Card {
  id: string;
  kind: FlipCardKind;
  numberValue?: number; // 0 ~ 12
  modifierType?: FlipModifierType;
  actionType?: FlipActionType;
  label: string;
  subLabel: string;
}

export type FlipRoundResult = 'NONE' | 'WIN' | 'FLIP7_WIN' | 'LOSE' | 'BUST' | 'OUT';

export interface Flip7Player {
  id: string;
  name: string;
  color: string;
  numberCards: Flip7Card[];
  modifierCards: Flip7Card[];
  hasSecondChance: boolean;
  chips: number;
  wins: number;
  totalPoints: number;
  currentBet: number;
  hasPlacedBet: boolean;
  isStayed: boolean;
  isBusted: boolean;
  isFlip7: boolean;
  isEliminated: boolean; // 판돈 소진 시 아웃
  roundScore: number;
  roundResult: FlipRoundResult;
}

interface WaitlistPlayer {
  id: string;
  name: string;
}

interface SpectatorPlayer {
  id: string;
  name: string;
}

interface PendingActionState {
  actorId: string;
  actorName: string;
  actionType: 'FREEZE' | 'FLIP_THREE';
  cardLabel: string;
}

interface NetFlip7RoomData {
  roomId: number;
  status: 'EMPTY' | 'WAITING' | 'BETTING' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER';
  players: Flip7Player[];
  pot: number;
  waitlist: WaitlistPlayer[];
  spectators: SpectatorPlayer[];
  baseTimeout: number;
  minBet: number;
  roundNumber: number;
  deck: Flip7Card[];
  discardPile: Flip7Card[];
  currentPlayerIdx: number;
  pendingAction: PendingActionState | null;
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

interface ChipFlyEffect {
  id: number;
  playerName: string;
  amount: number;
  color: string;
}

const PLAYER_BG_COLORS = [
  'radial-gradient(circle at 50% 20%, #1e1b4b 0%, #0f172a 65%, #020617 100%)',
  'radial-gradient(circle at 50% 20%, #3b0764 0%, #1e1b4b 65%, #020617 100%)',
  'radial-gradient(circle at 50% 20%, #064e3b 0%, #0f172a 65%, #020617 100%)',
  'radial-gradient(circle at 50% 20%, #451a03 0%, #1e1b4b 65%, #020617 100%)',
];

const PIECE_COLORS = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b'];
const INITIAL_CHIPS = 10000;
const DEFAULT_TIMEOUT_SEC = 90;

const SITUATION_LINES = {
  BET_START: (round: number) => [
    `${round}라운드 시작! 판돈을 걸고 행운의 카드를 뒤집으세요!`,
    `새 라운드가 열렸습니다! 승부사 여러분, 베팅할 칩을 올려주세요.`,
  ],
  BET_PLACED: (name: string, amount: number) => [
    `${name}님이 ${amount.toLocaleString()}칩을 판돈에 걸었습니다!`,
    `찰칵! ${name}님의 베팅 ${amount.toLocaleString()}칩!`,
  ],
  PLAYER_TURN: (name: string) => [
    `${name}님 차례입니다! 카드를 한 장 더 뒤집을까요(HIT), 멈출까요(STAY)?`,
    `${name}님의 선택! FLIP 7에 도전하시겠습니까?`,
  ],
  HIT_SAFE: (name: string, cardLabel: string) => [
    `${name}님 [${cardLabel}] 획득! 안전하게 점수를 쌓았습니다.`,
    `나이스! ${name}님이 [${cardLabel}] 카드를 뽑았습니다!`,
  ],
  STAY: (name: string, score: number) => [
    `${name}님이 멈추고 ${score}점을 안전하게 확정했습니다!`,
    `현명한 선택! ${name}님 STAY 선언 (${score}점 확정)!`,
  ],
  BUST: (name: string, dupNum: number) => [
    `앗! ${name}님 숫자 [${dupNum}] 중복으로 버스트! 이번 판 0점 처리됩니다.`,
    `충격! [${dupNum}] 카드가 겹치면서 ${name}님 버스트되었습니다!`,
  ],
  SECOND_CHANCE_SAVE: (name: string, dupNum: number) => [
    `🛡️ 기적! ${name}님이 세컨드 찬스로 중복 숫자 [${dupNum}] 버스트를 방어했습니다!`,
    `🛡️ 세컨드 찬스 발동! ${name}님이 위기에서 살아남았습니다!`,
  ],
  FLIP_7: (name: string) => [
    `👑 대박!! ${name}님이 서로 다른 숫자 7장을 모아 FLIP 7 (+15점 보너스) 달성!`,
    `🎊 전설의 FLIP 7 완성! ${name}님이 라운드를 즉시 종료시킵니다!`,
  ],
};

function pickRandomLine(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}

function getShortName(name: string): string {
  const trimmed = name ? name.trim() : '';
  return trimmed ? trimmed.slice(0, 2) : '?';
}

function createFlip7Deck(): Flip7Card[] {
  const deck: Flip7Card[] = [];
  const uid = () => Math.random().toString(36).slice(2, 7);

  deck.push({
    id: `num-0-${uid()}`,
    kind: 'NUMBER',
    numberValue: 0,
    label: '0',
    subLabel: 'ZERO',
  });

  for (let num = 1; num <= 12; num++) {
    for (let c = 0; c < num; c++) {
      deck.push({
        id: `num-${num}-${c}-${uid()}`,
        kind: 'NUMBER',
        numberValue: num,
        label: String(num),
        subLabel: `${num} PTS`,
      });
    }
  }

  const modifiers: { type: FlipModifierType; label: string; sub: string }[] = [
    { type: 'PLUS_2', label: '+2', sub: 'BONUS' },
    { type: 'PLUS_4', label: '+4', sub: 'BONUS' },
    { type: 'PLUS_6', label: '+6', sub: 'BONUS' },
    { type: 'PLUS_8', label: '+8', sub: 'BONUS' },
    { type: 'PLUS_10', label: '+10', sub: 'BONUS' },
    { type: 'MULTI_2', label: '×2', sub: 'DOUBLE' },
  ];
  modifiers.forEach((m) => {
    deck.push({
      id: `mod-${m.type}-${uid()}`,
      kind: 'MODIFIER',
      modifierType: m.type,
      label: m.label,
      subLabel: m.sub,
    });
  });

  const actions: { type: FlipActionType; label: string; sub: string }[] = [
    { type: 'FREEZE', label: '❄️ FREEZE', sub: '즉시 스탠드' },
    { type: 'FLIP_THREE', label: '⚡ FLIP 3', sub: '강제 3장 뽑기' },
    { type: 'SECOND_CHANCE', label: '🛡️ 2ND CHANCE', sub: '버스트 1회 방어' },
  ];
  actions.forEach((a) => {
    for (let i = 0; i < 3; i++) {
      deck.push({
        id: `act-${a.type}-${i}-${uid()}`,
        kind: 'ACTION',
        actionType: a.type,
        label: a.label,
        subLabel: a.sub,
      });
    }
  });

  return deck.sort(() => Math.random() - 0.5);
}

function calculateFlip7RoundScore(
  player: Pick<Flip7Player, 'numberCards' | 'modifierCards' | 'isBusted' | 'isFlip7'>
): number {
  if (player.isBusted) return 0;

  const numberSum = player.numberCards.reduce((acc, c) => acc + (c.numberValue ?? 0), 0);
  const hasMultiplier = player.modifierCards.some((m) => m.modifierType === 'MULTI_2');
  let flatBonus = 0;

  for (const m of player.modifierCards) {
    if (m.modifierType === 'PLUS_2') flatBonus += 2;
    else if (m.modifierType === 'PLUS_4') flatBonus += 4;
    else if (m.modifierType === 'PLUS_6') flatBonus += 6;
    else if (m.modifierType === 'PLUS_8') flatBonus += 8;
    else if (m.modifierType === 'PLUS_10') flatBonus += 10;
  }

  const flip7Bonus = player.isFlip7 || player.numberCards.length >= 7 ? 15 : 0;
  return numberSum * (hasMultiplier ? 2 : 1) + flatBonus + flip7Bonus;
}

function drawOneCard(
  deck: Flip7Card[],
  discardPile: Flip7Card[]
): { card: Flip7Card; nextDeck: Flip7Card[]; nextDiscard: Flip7Card[] } {
  let d = [...deck];
  let disc = [...discardPile];
  if (d.length === 0) {
    d = disc.length > 0 ? [...disc].sort(() => Math.random() - 0.5) : createFlip7Deck();
    disc = [];
  }
  const card = d.shift()!;
  return { card, nextDeck: d, nextDiscard: disc };
}

function settleFlip7Round(
  players: Flip7Player[],
  totalPot: number,
  minBet: number,
  isNetMode: boolean
): {
  settledPlayers: Flip7Player[];
  winners: string[];
  announcement: string;
  carryOverPot: number;
  isMatchOver: boolean;
} {
  const scoredPlayers = players.map((p) => {
    if (p.isEliminated) return { ...p, roundScore: 0, roundResult: 'OUT' as FlipRoundResult };
    const rScore = calculateFlip7RoundScore(p);
    return { ...p, roundScore: rScore };
  });

  const nonBusted = scoredPlayers.filter((p) => !p.isEliminated && !p.isBusted && p.roundScore > 0);

  if (nonBusted.length === 0) {
    const updated = scoredPlayers.map((p) => {
      if (p.isEliminated) return p;
      const outNow = isNetMode && p.chips < minBet;
      return {
        ...p,
        isEliminated: outNow,
        roundResult: (outNow ? 'OUT' : p.isBusted ? 'BUST' : 'LOSE') as FlipRoundResult,
      };
    });
    const survivors = updated.filter((p) => !p.isEliminated);
    return {
      settledPlayers: updated,
      winners: [],
      announcement: isNetMode
        ? `💥 유효 득점자가 없습니다! 판돈 ${totalPot.toLocaleString()}칩이 다음 판으로 이월됩니다.`
        : `💥 전원 버스트 또는 0점으로 무승부입니다!`,
      carryOverPot: isNetMode ? totalPot : 0,
      isMatchOver: isNetMode && survivors.length <= 1,
    };
  }

  const maxScore = Math.max(...nonBusted.map((p) => p.roundScore));
  const roundWinners = nonBusted.filter((p) => p.roundScore === maxScore);
  const winnerNames = roundWinners.map((w) => w.name);
  const prizePerWinner = isNetMode ? Math.floor(totalPot / roundWinners.length) : 0;

  const finalPlayers = scoredPlayers.map((p) => {
    if (p.isEliminated) return p;
    const isWin = !p.isBusted && p.roundScore === maxScore;
    const nextChips = isWin ? p.chips + prizePerWinner : p.chips;
    const outNow = isNetMode && nextChips < minBet;

    return {
      ...p,
      chips: nextChips,
      wins: isWin ? p.wins + 1 : p.wins,
      totalPoints: (p.totalPoints || 0) + p.roundScore,
      isEliminated: outNow,
      roundResult: (outNow
        ? 'OUT'
        : isWin
        ? p.isFlip7
          ? 'FLIP7_WIN'
          : 'WIN'
        : p.isBusted
        ? 'BUST'
        : 'LOSE') as FlipRoundResult,
    };
  });

  const survivors = finalPlayers.filter((p) => !p.isEliminated);
  const isMatchOver = isNetMode && survivors.length <= 1;

  let announcement = '';
  if (isMatchOver && survivors.length === 1) {
    announcement = `👑 최종 우승! ${survivors[0].name}님이 모든 판돈(${survivors[0].chips.toLocaleString()}칩)을 차지하며 최후의 승자가 되었습니다!`;
  } else if (isNetMode) {
    announcement = `🎊 ${winnerNames.join(', ')}님 라운드 승리! (${maxScore}점 · 판돈 +${prizePerWinner.toLocaleString()}칩 획득)`;
  } else {
    announcement = `🎊 ${winnerNames.join(', ')}님 라운드 승리! (${maxScore}점 획득)`;
  }

  return {
    settledPlayers: finalPlayers,
    winners: winnerNames,
    announcement,
    carryOverPot: 0,
    isMatchOver,
  };
}

function createDefaultFlip7Room(roomId: number): NetFlip7RoomData {
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
    currentPlayerIdx: 0,
    pendingAction: null,
    turnDeadline: null,
    turnNotice: '',
    winnerAnnouncement: '',
    winnersList: [],
    waitingSince: null,
  };
}

export default function Page4() {
  const [appMode, setAppMode] = useState<'HOME' | 'SOLO' | 'NET_LOBBY' | 'NET_ROOM' | 'HALL_OF_FAME'>('HOME');

  const [mySessionId] = useState<string>(() => {
    const saved = sessionStorage.getItem('flip7_net_uid');
    if (saved) return saved;
    const generated = `f7_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('flip7_net_uid', generated);
    return generated;
  });

  const [rooms, setRooms] = useState<NetFlip7RoomData[]>([1, 2, 3, 4].map(createDefaultFlip7Room));
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [joinModalRoom, setJoinModalRoom] = useState<NetFlip7RoomData | null>(null);
  const [joinPlayerName, setJoinPlayerName] = useState<string>('');
  const [remainingSeconds, setRemainingSeconds] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [waitingCountdownSec, setWaitingCountdownSec] = useState<number>(420);
  const timeoutHandledRef = useRef<number | null>(null);
  const lastSpokenNoticeRef = useRef<string>('');
  const lastCountdownSpokenRef = useRef<number | null>(null);

  const [gameState, setGameState] = useState<'SETUP' | 'READY' | 'PLAYING' | 'ROUND_OVER'>('SETUP');
  const [players, setPlayers] = useState<Flip7Player[]>([
    {
      id: '1',
      name: '플레이어1',
      color: PIECE_COLORS[0],
      numberCards: [],
      modifierCards: [],
      hasSecondChance: false,
      chips: INITIAL_CHIPS,
      wins: 0,
      totalPoints: 0,
      currentBet: 0,
      hasPlacedBet: true,
      isStayed: false,
      isBusted: false,
      isFlip7: false,
      isEliminated: false,
      roundScore: 0,
      roundResult: 'NONE',
    },
    {
      id: '2',
      name: '플레이어2',
      color: PIECE_COLORS[1],
      numberCards: [],
      modifierCards: [],
      hasSecondChance: false,
      chips: INITIAL_CHIPS,
      wins: 0,
      totalPoints: 0,
      currentBet: 0,
      hasPlacedBet: true,
      isStayed: false,
      isBusted: false,
      isFlip7: false,
      isEliminated: false,
      roundScore: 0,
      roundResult: 'NONE',
    },
  ]);
  const [inputName, setInputName] = useState('');
  const [soloTimeoutSec, setSoloTimeoutSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRemainingSec, setSoloRemainingSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRoundNum, setSoloRoundNum] = useState<number>(1);
  const [netSelectedBet, setNetSelectedBet] = useState<number>(500);

  const [deck, setDeck] = useState<Flip7Card[]>([]);
  const [discardPile, setDiscardPile] = useState<Flip7Card[]>([]);
  const [currentPlayerIdx, setCurrentPlayerIdx] = useState<number>(0);
  const [soloPendingAction, setSoloPendingAction] = useState<PendingActionState | null>(null);
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

  const playSound = (kind: 'flip' | 'chip' | 'bust' | 'win' | 'tick' | 'action') => {
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
        flip: [520, 720],
        chip: [880, 1174.66],
        bust: [290, 195],
        action: [660, 880, 660],
        win: [523.25, 659.25, 783.99, 1046.5, 1318.5],
        tick: [987.77],
      };

      notesMap[kind].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === 'bust' ? 'sawtooth' : kind === 'chip' ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.07);
        gain.gain.setValueAtTime(kind === 'tick' ? 0.16 : 0.14, ctx.currentTime + idx * 0.07);
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
    const key = type === 'SOLO' ? 'flip7_hof_solo' : 'flip7_hof_net';
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
    const key = type === 'SOLO' ? 'flip7_hof_solo' : 'flip7_hof_net';
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      return [];
    }
  };

  const applyDrawnCardToPlayer = (
    allPlayers: Flip7Player[],
    targetIdx: number,
    currentDeck: Flip7Card[],
    currentDiscard: Flip7Card[],
    actorIdx: number
  ): {
    updatedPlayers: Flip7Player[];
    nextDeck: Flip7Card[];
    nextDiscard: Flip7Card[];
    notice: string;
    immediateRoundEnd: boolean;
    pendingAction: PendingActionState | null;
    soundToPlay: 'flip' | 'bust' | 'action' | 'win';
  } => {
    const playersCopy = allPlayers.map((p) => ({
      ...p,
      numberCards: [...(p.numberCards || [])],
      modifierCards: [...(p.modifierCards || [])],
    }));
    const target = playersCopy[targetIdx];
    const actor = playersCopy[actorIdx];

    const { card, nextDeck, nextDiscard } = drawOneCard(currentDeck, currentDiscard);

    if (card.kind === 'NUMBER') {
      const val = card.numberValue ?? 0;
      const isDuplicate = target.numberCards.some((c) => c.numberValue === val);

      if (isDuplicate) {
        if (target.hasSecondChance) {
          target.hasSecondChance = false;
          nextDiscard.push(card);
          return {
            updatedPlayers: playersCopy,
            nextDeck,
            nextDiscard,
            notice: pickRandomLine(SITUATION_LINES.SECOND_CHANCE_SAVE(target.name, val)),
            immediateRoundEnd: false,
            pendingAction: null,
            soundToPlay: 'action',
          };
        } else {
          target.numberCards.push(card);
          target.isBusted = true;
          target.isStayed = true;
          target.roundScore = 0;
          return {
            updatedPlayers: playersCopy,
            nextDeck,
            nextDiscard,
            notice: pickRandomLine(SITUATION_LINES.BUST(target.name, val)),
            immediateRoundEnd: false,
            pendingAction: null,
            soundToPlay: 'bust',
          };
        }
      }

      target.numberCards.push(card);
      if (target.numberCards.length >= 7) {
        target.isFlip7 = true;
        target.isStayed = true;
        target.roundScore = calculateFlip7RoundScore(target);
        return {
          updatedPlayers: playersCopy,
          nextDeck,
          nextDiscard,
          notice: pickRandomLine(SITUATION_LINES.FLIP_7(target.name)),
          immediateRoundEnd: true,
          pendingAction: null,
          soundToPlay: 'win',
        };
      }

      target.roundScore = calculateFlip7RoundScore(target);
      return {
        updatedPlayers: playersCopy,
        nextDeck,
        nextDiscard,
        notice: `🃏 ${pickRandomLine(SITUATION_LINES.HIT_SAFE(target.name, card.label))}`,
        immediateRoundEnd: false,
        pendingAction: null,
        soundToPlay: 'flip',
      };
    }

    if (card.kind === 'MODIFIER') {
      target.modifierCards.push(card);
      target.roundScore = calculateFlip7RoundScore(target);
      return {
        updatedPlayers: playersCopy,
        nextDeck,
        nextDiscard,
        notice: `✨ ${target.name}님이 보너스 카드 [${card.label}]을 획득했습니다!`,
        immediateRoundEnd: false,
        pendingAction: null,
        soundToPlay: 'flip',
      };
    }

    if (card.actionType === 'SECOND_CHANCE') {
      if (!target.hasSecondChance) {
        target.hasSecondChance = true;
        return {
          updatedPlayers: playersCopy,
          nextDeck,
          nextDiscard,
          notice: `🛡️ ${target.name}님이 [세컨드 찬스] 카드를 확보했습니다! (버스트 1회 방어)`,
          immediateRoundEnd: false,
          pendingAction: null,
          soundToPlay: 'action',
        };
      } else {
        const candidateIdx = playersCopy.findIndex(
          (p, idx) =>
            idx !== targetIdx &&
            !p.isEliminated &&
            !p.isBusted &&
            !p.isStayed &&
            !p.hasSecondChance
        );
        if (candidateIdx !== -1) {
          playersCopy[candidateIdx].hasSecondChance = true;
          return {
            updatedPlayers: playersCopy,
            nextDeck,
            nextDiscard,
            notice: `🛡️ ${target.name}님이 중복된 [세컨드 찬스]를 ${playersCopy[candidateIdx].name}님에게 전달했습니다!`,
            immediateRoundEnd: false,
            pendingAction: null,
            soundToPlay: 'action',
          };
        }
        nextDiscard.push(card);
        return {
          updatedPlayers: playersCopy,
          nextDeck,
          nextDiscard,
          notice: `🛡️ 이미 세컨드 찬스를 보유 중이어서 카드가 버려졌습니다.`,
          immediateRoundEnd: false,
          pendingAction: null,
          soundToPlay: 'flip',
        };
      }
    }

    const eligibleTargets = playersCopy.filter(
      (p) => !p.isEliminated && !p.isBusted && !p.isStayed
    );

    if (eligibleTargets.length === 1) {
      const soloTargetIdx = playersCopy.findIndex((p) => p.id === eligibleTargets[0].id);
      if (card.actionType === 'FREEZE') {
        playersCopy[soloTargetIdx].isStayed = true;
        playersCopy[soloTargetIdx].roundScore = calculateFlip7RoundScore(playersCopy[soloTargetIdx]);
        nextDiscard.push(card);
        return {
          updatedPlayers: playersCopy,
          nextDeck,
          nextDiscard,
          notice: `❄️ [FREEZE] 발동! ${playersCopy[soloTargetIdx].name}님이 즉시 스탠드 처리되었습니다!`,
          immediateRoundEnd: false,
          pendingAction: null,
          soundToPlay: 'action',
        };
      } else {
        return executeFlipThreeOnTarget(playersCopy, soloTargetIdx, nextDeck, [...nextDiscard, card]);
      }
    }

    nextDiscard.push(card);
    return {
      updatedPlayers: playersCopy,
      nextDeck,
      nextDiscard,
      notice: `⚡ ${actor.name}님이 [${card.label}] 카드를 뽑았습니다! 적용할 플레이어를 선택하세요!`,
      immediateRoundEnd: false,
      pendingAction: {
        actorId: actor.id,
        actorName: actor.name,
        actionType: card.actionType === 'FREEZE' ? 'FREEZE' : 'FLIP_THREE',
        cardLabel: card.label,
      },
      soundToPlay: 'action',
    };
  };

  const executeFlipThreeOnTarget = (
    allPlayers: Flip7Player[],
    targetIdx: number,
    currentDeck: Flip7Card[],
    currentDiscard: Flip7Card[]
  ): {
    updatedPlayers: Flip7Player[];
    nextDeck: Flip7Card[];
    nextDiscard: Flip7Card[];
    notice: string;
    immediateRoundEnd: boolean;
    pendingAction: PendingActionState | null;
    soundToPlay: 'flip' | 'bust' | 'action' | 'win';
  } => {
    const pList = allPlayers.map((p) => ({
      ...p,
      numberCards: [...(p.numberCards || [])],
      modifierCards: [...(p.modifierCards || [])],
    }));
    let d = [...currentDeck];
    let disc = [...currentDiscard];
    const targetName = pList[targetIdx].name;
    const drawnLabels: string[] = [];

    for (let step = 0; step < 3; step++) {
      if (pList[targetIdx].isBusted || pList[targetIdx].isStayed || pList[targetIdx].isFlip7) {
        break;
      }
      const { card, nextDeck, nextDiscard } = drawOneCard(d, disc);
      d = nextDeck;
      disc = nextDiscard;
      drawnLabels.push(card.label);

      if (card.kind === 'NUMBER') {
        const val = card.numberValue ?? 0;
        const dup = pList[targetIdx].numberCards.some((c) => c.numberValue === val);
        if (dup) {
          if (pList[targetIdx].hasSecondChance) {
            pList[targetIdx].hasSecondChance = false;
            disc.push(card);
          } else {
            pList[targetIdx].numberCards.push(card);
            pList[targetIdx].isBusted = true;
            pList[targetIdx].isStayed = true;
            pList[targetIdx].roundScore = 0;
            return {
              updatedPlayers: pList,
              nextDeck: d,
              nextDiscard: disc,
              notice: `⚡ [FLIP 3] ${targetName}님이 (${drawnLabels.join(', ')})를 뽑다 숫자 [${val}] 중복으로 버스트!`,
              immediateRoundEnd: false,
              pendingAction: null,
              soundToPlay: 'bust',
            };
          }
        } else {
          pList[targetIdx].numberCards.push(card);
          if (pList[targetIdx].numberCards.length >= 7) {
            pList[targetIdx].isFlip7 = true;
            pList[targetIdx].isStayed = true;
            pList[targetIdx].roundScore = calculateFlip7RoundScore(pList[targetIdx]);
            return {
              updatedPlayers: pList,
              nextDeck: d,
              nextDiscard: disc,
              notice: `👑 [FLIP 3] 중 ${targetName}님이 숫자 7장을 완성하며 FLIP 7 달성!`,
              immediateRoundEnd: true,
              pendingAction: null,
              soundToPlay: 'win',
            };
          }
        }
      } else if (card.kind === 'MODIFIER') {
        pList[targetIdx].modifierCards.push(card);
      } else if (card.actionType === 'SECOND_CHANCE') {
        if (!pList[targetIdx].hasSecondChance) {
          pList[targetIdx].hasSecondChance = true;
        } else {
          disc.push(card);
        }
      } else if (card.actionType === 'FREEZE') {
        pList[targetIdx].isStayed = true;
        disc.push(card);
        break;
      } else {
        disc.push(card);
      }
    }

    pList[targetIdx].roundScore = calculateFlip7RoundScore(pList[targetIdx]);
    return {
      updatedPlayers: pList,
      nextDeck: d,
      nextDiscard: disc,
      notice: `⚡ [FLIP 3] ${targetName}님이 [${drawnLabels.join(', ')}] 카드를 강제로 뽑았습니다!`,
      immediateRoundEnd: false,
      pendingAction: null,
      soundToPlay: 'action',
    };
  };

  useEffect(() => {
    if (appMode !== 'NET_LOBBY' && appMode !== 'NET_ROOM') return;

    const ensureRoomsExist = async () => {
      for (const id of [1, 2, 3, 4]) {
        const roomRef = ref(db, `flip7_rooms/room_${id}`);
        const snap = await get(roomRef);
        if (!snap.exists()) {
          await set(roomRef, createDefaultFlip7Room(id));
        }
      }
    };
    ensureRoomsExist();

    const roomsRef = ref(db, 'flip7_rooms');
    const unsubscribe = onValue(roomsRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      const loadedRooms: NetFlip7RoomData[] = [1, 2, 3, 4].map((id) => {
        const rData = data[`room_${id}`];
        const def = createDefaultFlip7Room(id);
        if (!rData) return def;
        return {
          ...def,
          ...rData,
          players: (rData.players || []).map((p: Flip7Player) => ({
            ...p,
            numberCards: p.numberCards || [],
            modifierCards: p.modifierCards || [],
            chips: typeof p.chips === 'number' ? p.chips : INITIAL_CHIPS,
            wins: typeof p.wins === 'number' ? p.wins : 0,
            totalPoints: typeof p.totalPoints === 'number' ? p.totalPoints : 0,
            isEliminated: Boolean(p.isEliminated),
          })),
          pot: typeof rData.pot === 'number' ? rData.pot : 0,
          waitlist: rData.waitlist || [],
          spectators: rData.spectators || [],
          deck: rData.deck || [],
          discardPile: rData.discardPile || [],
          winnersList: rData.winnersList || [],
          pendingAction: rData.pendingAction || null,
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
          const roomRef = ref(db, `flip7_rooms/room_${activeNetRoom.roomId}`);
          await set(roomRef, createDefaultFlip7Room(activeNetRoom.roomId));
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
    if (appMode !== 'SOLO' || gameState !== 'PLAYING') {
      return;
    }

    const timer = window.setInterval(() => {
      setSoloRemainingSec((prev) => {
        const next = Math.max(0, prev - 1);
        handleCountdownCue(next);
        if (next === 0) {
          if (soloPendingAction) {
            const target = players.find(
              (p) => !p.isEliminated && !p.isBusted && !p.isStayed
            );
            if (target) handleSoloSelectActionTarget(target.id);
          } else {
            handleSoloStay();
          }
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [appMode, gameState, currentPlayerIdx, soloTimeoutSec, soloPendingAction]);

  const handleEnterRoomSubmit = async (asSpectator = false) => {
    if (!joinModalRoom) return;
    const trimmedName = joinPlayerName ? joinPlayerName.trim() : '';
    if (!trimmedName) {
      alert('참가할 이름을 입력해주세요!');
      return;
    }

    const roomRef = ref(db, `flip7_rooms/room_${joinModalRoom.roomId}`);

    try {
      let joinResultType = 'PLAYER';

      await runTransaction(roomRef, (roomData) => {
        const room: NetFlip7RoomData = roomData || createDefaultFlip7Room(joinModalRoom.roomId);
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
          const newPlayer: Flip7Player = {
            id: mySessionId,
            name: trimmedName,
            color: PIECE_COLORS[idx],
            numberCards: [],
            modifierCards: [],
            hasSecondChance: false,
            chips: INITIAL_CHIPS,
            wins: 0,
            totalPoints: 0,
            currentBet: 0,
            hasPlacedBet: false,
            isStayed: false,
            isBusted: false,
            isFlip7: false,
            isEliminated: false,
            roundScore: 0,
            roundResult: 'NONE',
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
        showToast('⏳ 다음 매치 예약자로 등록되었습니다!', 'info');
      }
    } catch (err) {
      console.error(err);
      alert('방 입장 중 오류가 발생했습니다.');
    }
  };

  const updateRoomSettings = async (newMinBet: number, newTimeout: number) => {
    if (!activeNetRoom) return;
    const clampedTimeout = Math.min(180, Math.max(30, newTimeout));
    const roomRef = ref(db, `flip7_rooms/room_${activeNetRoom.roomId}`);
    await update(roomRef, {
      minBet: newMinBet,
      baseTimeout: clampedTimeout,
      waitingSince: Date.now(),
    });
  };

  const handleStartNetBettingPhase = async (isNextRound = false, isNewMatch = false) => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `flip7_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetFlip7RoomData;
      if (!room.players) room.players = [];
      if (!room.waitlist) room.waitlist = [];

      const nextRound = isNextRound && !isNewMatch ? (room.roundNumber || 1) + 1 : 1;
      let basePlayers = [...room.players];
      let remainingWaitlist = [...room.waitlist];

      if (!isNextRound || isNewMatch) {
        const availableSlots = Math.max(0, 4 - basePlayers.length);
        const joiningWaiters = remainingWaitlist.slice(0, availableSlots);
        remainingWaitlist = remainingWaitlist.slice(availableSlots);

        const converted: Flip7Player[] = joiningWaiters.map((w) => ({
          id: w.id,
          name: w.name,
          color: PIECE_COLORS[0],
          numberCards: [],
          modifierCards: [],
          hasSecondChance: false,
          chips: INITIAL_CHIPS,
          wins: 0,
          totalPoints: 0,
          currentBet: 0,
          hasPlacedBet: false,
          isStayed: false,
          isBusted: false,
          isFlip7: false,
          isEliminated: false,
          roundScore: 0,
          roundResult: 'NONE',
        }));
        basePlayers = [...basePlayers, ...converted];
      }

      const activeSurvivors = basePlayers.filter((p) =>
        isNewMatch ? true : !p.isEliminated && p.chips >= room.minBet
      );

      if (activeSurvivors.length < 2) {
        room.status = basePlayers.length === 0 ? 'EMPTY' : 'WAITING';
        room.players = basePlayers;
        room.waitlist = remainingWaitlist;
        return room;
      }

      const carryOverPot =
        room.status === 'ROUND_OVER' && !isNewMatch && room.winnersList.length === 0
          ? room.pot || 0
          : 0;

      const resetPlayers = basePlayers.map((p, idx) => {
        const chipsToUse = isNewMatch || !isNextRound ? INITIAL_CHIPS : p.chips;
        const eliminated = !isNewMatch && isNextRound && (p.isEliminated || chipsToUse < room.minBet);
        return {
          ...p,
          color: PIECE_COLORS[idx % PIECE_COLORS.length],
          numberCards: [],
          modifierCards: [],
          hasSecondChance: false,
          chips: chipsToUse,
          wins: isNewMatch || !isNextRound ? 0 : p.wins || 0,
          totalPoints: isNewMatch || !isNextRound ? 0 : p.totalPoints || 0,
          currentBet: 0,
          hasPlacedBet: eliminated,
          isStayed: eliminated,
          isBusted: false,
          isFlip7: false,
          isEliminated: eliminated,
          roundScore: 0,
          roundResult: (eliminated ? 'OUT' : 'NONE') as FlipRoundResult,
        };
      });

      const freshDeck = room.deck && room.deck.length > 25 ? room.deck : createFlip7Deck();

      room.status = 'BETTING';
      room.roundNumber = nextRound;
      room.players = resetPlayers;
      room.pot = carryOverPot;
      room.waitlist = remainingWaitlist;
      room.deck = freshDeck;
      room.discardPile = room.discardPile || [];
      room.currentPlayerIdx = 0;
      room.pendingAction = null;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.winnerAnnouncement = '';
      room.winnersList = [];
      room.turnNotice = `💰 [${nextRound}라운드 · 판돈 베팅] ${pickRandomLine(
        SITUATION_LINES.BET_START(nextRound)
      )}`;
      room.waitingSince = null;

      return room;
    });

    setNetSelectedBet(activeNetRoom.minBet);
  };

  const handleNetPlaceBet = async (betAmount: number) => {
    if (!activeNetRoom || activeNetRoom.status !== 'BETTING') return;
    const me = activeNetRoom.players.find((p) => p.id === mySessionId);
    if (!me || me.hasPlacedBet || me.isEliminated) return;

    const actualBet = Math.min(me.chips, Math.max(activeNetRoom.minBet, betAmount));
    triggerChipAnimation(me.name, actualBet, me.color);

    const roomRef = ref(db, `flip7_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetFlip7RoomData;
      if (room.status !== 'BETTING') return room;

      const pIdx = room.players.findIndex((p) => p.id === mySessionId);
      if (pIdx === -1 || room.players[pIdx].hasPlacedBet || room.players[pIdx].isEliminated) {
        return room;
      }

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
        room.turnNotice = `🪙 ${pickRandomLine(SITUATION_LINES.BET_PLACED(actor.name, pay))}`;
        return room;
      }

      let dCopy = [...(room.deck || createFlip7Deck())];
      const discCopy = [...(room.discardPile || [])];

      room.players = room.players.map((p) => {
        if (p.isEliminated) return p;
        let drawnIdx = dCopy.findIndex((c) => c.kind === 'NUMBER');
        if (drawnIdx === -1) {
          dCopy = createFlip7Deck();
          drawnIdx = dCopy.findIndex((c) => c.kind === 'NUMBER');
        }
        const [initCard] = dCopy.splice(drawnIdx, 1);
        const updatedP: Flip7Player = {
          ...p,
          numberCards: [initCard],
          modifierCards: [],
          hasSecondChance: false,
          isStayed: false,
          isBusted: false,
          isFlip7: false,
        };
        updatedP.roundScore = calculateFlip7RoundScore(updatedP);
        return updatedP;
      });

      room.deck = dCopy;
      room.discardPile = discCopy;

      const firstActiveIdx = room.players.findIndex(
        (p) => !p.isEliminated && !p.isStayed && !p.isBusted
      );
      const activeP = room.players[firstActiveIdx];
      room.status = 'PLAYING';
      room.currentPlayerIdx = firstActiveIdx;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `🎯 ${pickRandomLine(SITUATION_LINES.PLAYER_TURN(activeP.name))}`;
      return room;
    });
  };

  const finalizeOrAdvanceNetTurn = (
    room: NetFlip7RoomData,
    updatedPlayers: Flip7Player[],
    nextDeck: Flip7Card[],
    nextDiscard: Flip7Card[],
    fromIdx: number,
    actionNotice: string,
    immediateRoundEnd: boolean,
    pendingAction: PendingActionState | null
  ) => {
    room.players = updatedPlayers;
    room.deck = nextDeck;
    room.discardPile = nextDiscard;
    room.pendingAction = pendingAction;

    if (pendingAction) {
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = actionNotice;
      return;
    }

    const anyAlive = updatedPlayers.some(
      (p) => !p.isEliminated && !p.isStayed && !p.isBusted
    );

    if (immediateRoundEnd || !anyAlive) {
      const settled = settleFlip7Round(
        updatedPlayers,
        room.pot || 0,
        room.minBet,
        true
      );
      room.players = settled.settledPlayers;
      room.pot = settled.carryOverPot;
      room.status = settled.isMatchOver ? 'MATCH_OVER' : 'ROUND_OVER';
      room.turnDeadline = null;
      room.turnNotice = '';
      room.winnersList = settled.winners;
      room.winnerAnnouncement = settled.announcement;

      settled.settledPlayers.forEach((sp) => {
        if (sp.roundResult === 'WIN' || sp.roundResult === 'FLIP7_WIN') {
          saveHallOfFameRecord('NET', {
            name: sp.name,
            scoreOrLevel: `${sp.wins}승 · 보유 ${sp.chips.toLocaleString()}칩`,
          });
        }
      });
      return;
    }

    let nextIdx = -1;
    for (let offset = 1; offset <= updatedPlayers.length; offset++) {
      const candidate = (fromIdx + offset) % updatedPlayers.length;
      const p = updatedPlayers[candidate];
      if (!p.isEliminated && !p.isStayed && !p.isBusted) {
        nextIdx = candidate;
        break;
      }
    }

    const nextActor = updatedPlayers[nextIdx];
    room.currentPlayerIdx = nextIdx;
    room.turnDeadline = Date.now() + room.baseTimeout * 1000;
    room.turnNotice = `${actionNotice} 👉 다음은 ${nextActor.name}님 차례입니다!`;
  };

  const handleNetPlayAction = async (action: 'HIT' | 'STAY') => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING' || activeNetRoom.pendingAction) return;
    const currIdx = activeNetRoom.currentPlayerIdx % activeNetRoom.players.length;
    const currP = activeNetRoom.players[currIdx];
    if (!currP || currP.id !== mySessionId) return;

    const roomRef = ref(db, `flip7_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetFlip7RoomData;
      if (room.status !== 'PLAYING' || room.pendingAction) return room;

      const idx = room.currentPlayerIdx % room.players.length;
      const actor = room.players[idx];
      if (!actor || actor.id !== mySessionId) return room;

      if (action === 'STAY') {
        const updated = room.players.map((p, i) => {
          if (i !== idx) return p;
          const rScore = calculateFlip7RoundScore(p);
          return { ...p, isStayed: true, roundScore: rScore };
        });
        const confirmedScore = updated[idx].roundScore;
        finalizeOrAdvanceNetTurn(
          room,
          updated,
          room.deck || [],
          room.discardPile || [],
          idx,
          `✋ ${pickRandomLine(SITUATION_LINES.STAY(actor.name, confirmedScore))}`,
          false,
          null
        );
        return room;
      }

      const res = applyDrawnCardToPlayer(
        room.players,
        idx,
        room.deck || [],
        room.discardPile || [],
        idx
      );
      playSound(res.soundToPlay);

      finalizeOrAdvanceNetTurn(
        room,
        res.updatedPlayers,
        res.nextDeck,
        res.nextDiscard,
        idx,
        res.notice,
        res.immediateRoundEnd,
        res.pendingAction
      );
      return room;
    });
  };

  const handleNetSelectActionTarget = async (targetPlayerId: string) => {
    if (!activeNetRoom || activeNetRoom.status !== 'PLAYING' || !activeNetRoom.pendingAction) return;
    if (activeNetRoom.pendingAction.actorId !== mySessionId) return;

    const roomRef = ref(db, `flip7_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetFlip7RoomData;
      if (room.status !== 'PLAYING' || !room.pendingAction) return room;
      if (room.pendingAction.actorId !== mySessionId) return room;

      const targetIdx = room.players.findIndex((p) => p.id === targetPlayerId);
      if (targetIdx === -1) return room;
      const actorIdx = room.currentPlayerIdx % room.players.length;

      if (room.pendingAction.actionType === 'FREEZE') {
        const updated = room.players.map((p, i) => {
          if (i !== targetIdx) return p;
          const rScore = calculateFlip7RoundScore(p);
          return { ...p, isStayed: true, roundScore: rScore };
        });
        playSound('action');
        finalizeOrAdvanceNetTurn(
          room,
          updated,
          room.deck || [],
          room.discardPile || [],
          actorIdx,
          `❄️ [FREEZE] ${room.pendingAction.actorName}님이 ${updated[targetIdx].name}님을 얼려 스탠드시켰습니다!`,
          false,
          null
        );
        return room;
      }

      const res = executeFlipThreeOnTarget(
        room.players,
        targetIdx,
        room.deck || [],
        room.discardPile || []
      );
      playSound(res.soundToPlay);
      finalizeOrAdvanceNetTurn(
        room,
        res.updatedPlayers,
        res.nextDeck,
        res.nextDiscard,
        actorIdx,
        res.notice,
        res.immediateRoundEnd,
        null
      );
      return room;
    });
  };

  const handleNetTurnTimeout = async (room: NetFlip7RoomData) => {
    const roomRef = ref(db, `flip7_rooms/room_${room.roomId}`);

    if (room.status === 'BETTING') {
      await runTransaction(roomRef, (roomData) => {
        if (!roomData) return roomData;
        const r = roomData as NetFlip7RoomData;
        if (r.status !== 'BETTING') return r;

        let addedPot = 0;
        r.players = r.players.map((p) => {
          if (p.isEliminated || p.hasPlacedBet) return p;
          const autoPay = Math.min(p.chips, r.minBet);
          addedPot += autoPay;
          return { ...p, chips: p.chips - autoPay, currentBet: autoPay, hasPlacedBet: true };
        });
        r.pot = (r.pot || 0) + addedPot;

        let dCopy = [...(r.deck || createFlip7Deck())];
        r.players = r.players.map((p) => {
          if (p.isEliminated) return p;
          let drawnIdx = dCopy.findIndex((c) => c.kind === 'NUMBER');
          if (drawnIdx === -1) {
            dCopy = createFlip7Deck();
            drawnIdx = dCopy.findIndex((c) => c.kind === 'NUMBER');
          }
          const [initCard] = dCopy.splice(drawnIdx, 1);
          const up: Flip7Player = {
            ...p,
            numberCards: [initCard],
            modifierCards: [],
            hasSecondChance: false,
            isStayed: false,
            isBusted: false,
            isFlip7: false,
          };
          up.roundScore = calculateFlip7RoundScore(up);
          return up;
        });
        r.deck = dCopy;

        const firstIdx = r.players.findIndex((p) => !p.isEliminated && !p.isStayed && !p.isBusted);
        const nextP = r.players[firstIdx];
        r.status = 'PLAYING';
        r.currentPlayerIdx = firstIdx;
        r.turnDeadline = Date.now() + r.baseTimeout * 1000;
        r.turnNotice = `⏰ 시간 초과로 기본 베팅이 완료되었습니다. ${nextP.name}님 차례입니다.`;
        return r;
      });
      return;
    }

    if (room.status === 'PLAYING') {
      await runTransaction(roomRef, (roomData) => {
        if (!roomData) return roomData;
        const r = roomData as NetFlip7RoomData;
        if (r.status !== 'PLAYING') return r;

        const idx = r.currentPlayerIdx % r.players.length;
        const updated = r.players.map((p, i) =>
          i === idx ? { ...p, isStayed: true, roundScore: calculateFlip7RoundScore(p) } : p
        );
        finalizeOrAdvanceNetTurn(
          r,
          updated,
          r.deck || [],
          r.discardPile || [],
          idx,
          `⏰ 시간 초과로 ${updated[idx].name}님이 자동 스탠드 처리되었습니다.`,
          false,
          null
        );
        return r;
      });
    }
  };

  const handleLeaveNetRoom = async () => {
    if (!activeNetRoom) {
      setAppMode('NET_LOBBY');
      return;
    }

    const roomRef = ref(db, `flip7_rooms/room_${activeNetRoom.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetFlip7RoomData;
      const filteredPlayers = (room.players || []).filter((p) => p.id !== mySessionId);
      const filteredWaitlist = (room.waitlist || []).filter((w) => w.id !== mySessionId);
      const filteredSpectators = (room.spectators || []).filter((s) => s.id !== mySessionId);

      if (filteredPlayers.length === 0 && filteredSpectators.length === 0) {
        return createDefaultFlip7Room(room.roomId);
      }
      room.players = filteredPlayers;
      room.waitlist = filteredWaitlist;
      room.spectators = filteredSpectators;
      return room;
    });

    setSelectedRoomId(null);
    setAppMode('NET_LOBBY');
  };

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
        numberCards: [],
        modifierCards: [],
        hasSecondChance: false,
        chips: INITIAL_CHIPS,
        wins: 0,
        totalPoints: 0,
        currentBet: 0,
        hasPlacedBet: true,
        isStayed: false,
        isBusted: false,
        isFlip7: false,
        isEliminated: false,
        roundScore: 0,
        roundResult: 'NONE',
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
      showToast('최소 2명 이상의 플레이어를 등록해주세요!', 'info');
      return;
    }
    setGameState('READY');
  };

  const startSoloRound = (isNextRound = false) => {
    const nextRound = isNextRound ? soloRoundNum + 1 : 1;
    let dCopy = deck.length > 25 ? [...deck] : createFlip7Deck();

    const initialized = players.map((p, idx) => {
      let drawnIdx = dCopy.findIndex((c) => c.kind === 'NUMBER');
      if (drawnIdx === -1) {
        dCopy = createFlip7Deck();
        drawnIdx = dCopy.findIndex((c) => c.kind === 'NUMBER');
      }
      const [initCard] = dCopy.splice(drawnIdx, 1);
      const up: Flip7Player = {
        ...p,
        color: PIECE_COLORS[idx % PIECE_COLORS.length],
        numberCards: [initCard],
        modifierCards: [],
        hasSecondChance: false,
        wins: isNextRound ? p.wins : 0,
        totalPoints: isNextRound ? p.totalPoints : 0,
        isStayed: false,
        isBusted: false,
        isFlip7: false,
        isEliminated: false,
        roundScore: 0,
        roundResult: 'NONE',
      };
      up.roundScore = calculateFlip7RoundScore(up);
      return up;
    });

    const notice = `🎯 [${nextRound}라운드] ${pickRandomLine(
      SITUATION_LINES.PLAYER_TURN(initialized[0].name)
    )}`;
    setSoloRoundNum(nextRound);
    setDeck(dCopy);
    setDiscardPile([]);
    setPlayers(initialized);
    setCurrentPlayerIdx(0);
    setSoloPendingAction(null);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setWinnerAnnouncement('');
    setShowFireworks(false);
    setTurnNotice(notice);
    speakKorean(notice);
    setGameState('PLAYING');
  };

  const finalizeOrAdvanceSoloTurn = (
    updatedPlayers: Flip7Player[],
    nextDeck: Flip7Card[],
    nextDiscard: Flip7Card[],
    fromIdx: number,
    actionNotice: string,
    immediateRoundEnd: boolean,
    pendingAction: PendingActionState | null
  ) => {
    setPlayers(updatedPlayers);
    setDeck(nextDeck);
    setDiscardPile(nextDiscard);
    setSoloPendingAction(pendingAction);

    if (pendingAction) {
      setSoloRemainingSec(soloTimeoutSec);
      lastCountdownSpokenRef.current = null;
      setTurnNotice(actionNotice);
      speakKorean(actionNotice);
      return;
    }

    const anyAlive = updatedPlayers.some((p) => !p.isStayed && !p.isBusted);
    if (immediateRoundEnd || !anyAlive) {
      const settled = settleFlip7Round(updatedPlayers, 0, 0, false);
      setPlayers(settled.settledPlayers);
      setTurnNotice('');
      setWinnerAnnouncement(settled.announcement);
      setGameState('ROUND_OVER');

      if (settled.winners.length > 0) {
        triggerFireworksCelebration(settled.announcement);
        settled.settledPlayers.forEach((sp) => {
          if (sp.roundResult === 'WIN' || sp.roundResult === 'FLIP7_WIN') {
            saveHallOfFameRecord('SOLO', {
              name: sp.name,
              scoreOrLevel: `${sp.wins}승 · 누적 ${sp.totalPoints}점`,
            });
          }
        });
      } else {
        speakKorean(settled.announcement);
      }
      return;
    }

    let nextIdx = -1;
    for (let offset = 1; offset <= updatedPlayers.length; offset++) {
      const candidate = (fromIdx + offset) % updatedPlayers.length;
      if (!updatedPlayers[candidate].isStayed && !updatedPlayers[candidate].isBusted) {
        nextIdx = candidate;
        break;
      }
    }

    const nextActor = updatedPlayers[nextIdx];
    const fullNotice = `${actionNotice} 👉 다음은 ${nextActor.name}님 차례입니다!`;
    setCurrentPlayerIdx(nextIdx);
    setSoloRemainingSec(soloTimeoutSec);
    lastCountdownSpokenRef.current = null;
    setTurnNotice(fullNotice);
    speakKorean(fullNotice);
  };

  const handleSoloHit = () => {
    if (gameState !== 'PLAYING' || soloPendingAction) return;
    const res = applyDrawnCardToPlayer(
      players,
      currentPlayerIdx,
      deck,
      discardPile,
      currentPlayerIdx
    );
    playSound(res.soundToPlay);
    finalizeOrAdvanceSoloTurn(
      res.updatedPlayers,
      res.nextDeck,
      res.nextDiscard,
      currentPlayerIdx,
      res.notice,
      res.immediateRoundEnd,
      res.pendingAction
    );
  };

  const handleSoloStay = () => {
    if (gameState !== 'PLAYING' || soloPendingAction) return;
    const actor = players[currentPlayerIdx];
    const updated = players.map((p, i) => {
      if (i !== currentPlayerIdx) return p;
      const rScore = calculateFlip7RoundScore(p);
      return { ...p, isStayed: true, roundScore: rScore };
    });
    const confirmedScore = updated[currentPlayerIdx].roundScore;
    finalizeOrAdvanceSoloTurn(
      updated,
      deck,
      discardPile,
      currentPlayerIdx,
      `✋ ${pickRandomLine(SITUATION_LINES.STAY(actor.name, confirmedScore))}`,
      false,
      null
    );
  };

  const handleSoloSelectActionTarget = (targetPlayerId: string) => {
    if (gameState !== 'PLAYING' || !soloPendingAction) return;
    const targetIdx = players.findIndex((p) => p.id === targetPlayerId);
    if (targetIdx === -1) return;

    if (soloPendingAction.actionType === 'FREEZE') {
      const updated = players.map((p, i) => {
        if (i !== targetIdx) return p;
        return { ...p, isStayed: true, roundScore: calculateFlip7RoundScore(p) };
      });
      playSound('action');
      finalizeOrAdvanceSoloTurn(
        updated,
        deck,
        discardPile,
        currentPlayerIdx,
        `❄️ [FREEZE] ${soloPendingAction.actorName}님이 ${updated[targetIdx].name}님을 얼려 스탠드시켰습니다!`,
        false,
        null
      );
      return;
    }

    const res = executeFlipThreeOnTarget(players, targetIdx, deck, discardPile);
    playSound(res.soundToPlay);
    finalizeOrAdvanceSoloTurn(
      res.updatedPlayers,
      res.nextDeck,
      res.nextDiscard,
      currentPlayerIdx,
      res.notice,
      res.immediateRoundEnd,
      null
    );
  };

  // =========================================================================
  // 실제 Flip 7 보드게임 카드 & 포커 칩 UI 렌더러
  // =========================================================================
  const renderFlipCard = (card: Flip7Card, isDuplicateBust = false) => {
    const isModifier = card.kind === 'MODIFIER';
    const numVal = card.numberValue ?? 0;

    let tierClass = 'card-zero';
    if (isModifier) {
      tierClass = 'card-modifier';
    } else if (numVal === 0) {
      tierClass = 'card-zero';
    } else if (numVal <= 3) {
      tierClass = 'card-cyan';
    } else if (numVal <= 6) {
      tierClass = 'card-emerald';
    } else if (numVal <= 9) {
      tierClass = 'card-amber';
    } else {
      tierClass = 'card-crimson';
    }

    // 실제 Flip 7 카드 하단에는 덱 내 해당 숫자 카드 총 개수(0은 1장, 1~12는 숫자만큼)가 점으로 표시됨
    const deckCopiesCount = isModifier ? 0 : numVal === 0 ? 1 : numVal;

    return (
      <div
        key={card.id}
        className={`f7-card ${tierClass} ${isDuplicateBust ? 'card-bust-shake' : ''}`}
      >
        <div className="f7-card-inner-frame">
          <span className="f7-card-corner top-left">{card.label}</span>
          <div className="f7-card-center-art">
            <span className="f7-card-main">{card.label}</span>
            <span className="f7-card-sub">{card.subLabel}</span>
          </div>
          {deckCopiesCount > 0 && (
            <div className="f7-card-pips" title={`덱 내 총 ${deckCopiesCount}장`}>
              {Array.from({ length: Math.min(deckCopiesCount, 12) }).map((_, idx) => (
                <i key={idx} className="f7-pip-dot" />
              ))}
            </div>
          )}
          <span className="f7-card-corner bottom-right">{card.label}</span>
        </div>
      </div>
    );
  };

  const renderCasinoChipStack = (amount: number, label?: string) => {
    const stackCount = amount <= 0 ? 1 : amount < 1000 ? 2 : amount < 3000 ? 3 : amount < 7000 ? 4 : 5;
    const chipColorClass =
      amount >= 5000 ? 'chip-gold' : amount >= 2000 ? 'chip-red' : 'chip-blue';

    return (
      <div className="casino-chip-widget">
        <div className="chip-stack-visual">
          {Array.from({ length: stackCount }).map((_, idx) => (
            <div
              key={idx}
              className={`casino-chip-disc ${chipColorClass}`}
              style={{ bottom: `${idx * 4}px`, zIndex: idx + 1 }}
            >
              <span>7</span>
            </div>
          ))}
        </div>
        <div className="chip-stack-info">
          {label && <span className="chip-stack-label">{label}</span>}
          <strong className="chip-stack-value">{amount.toLocaleString()}</strong>
        </div>
      </div>
    );
  };

  const renderResultBadge = (result: FlipRoundResult) => {
    switch (result) {
      case 'FLIP7_WIN':
        return <span className="f7-res-badge flip7">👑 FLIP 7 대승리! (+15점)</span>;
      case 'WIN':
        return <span className="f7-res-badge win">🎉 라운드 승리!</span>;
      case 'BUST':
        return <span className="f7-res-badge lose">💥 버스트 (중복 숫자)</span>;
      case 'OUT':
        return <span className="f7-res-badge out">🚫 판돈 소진 아웃</span>;
      case 'LOSE':
        return <span className="f7-res-badge lose">😢 패배</span>;
      default:
        return null;
    }
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
      <div className="f7-container" style={{ background: PLAYER_BG_COLORS[0] }}>
        <div className="setup-card home-entry-card arcade-panel">
          <div className="f7-logo-badge">
            <span className="logo-word">FLIP</span>
            <span className="logo-seven">7</span>
          </div>
          <p className="home-subtitle">중복 없이 서로 다른 숫자 7장을 뒤집어라!</p>

          <div className="preview-fan-cards" aria-hidden="true">
            <div className="mini-fan-card c1">3</div>
            <div className="mini-fan-card c2">7</div>
            <div className="mini-fan-card c3">12</div>
            <div className="mini-fan-card c4">×2</div>
          </div>

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
              <span className="mode-desc">한 기기에서 2~4인이 함께 즐기는 로컬 대전</span>
            </button>

            <button
              type="button"
              className="mode-select-btn net"
              onClick={() => setAppMode('NET_LOBBY')}
            >
              <span className="mode-icon">🪙</span>
              <strong>넷게임 (판돈 서바이벌)</strong>
              <span className="mode-desc">칩을 베팅하고 승리 시 독식·누적, 소진 시 아웃!</span>
            </button>
          </div>

          <button
            type="button"
            className="btn btn-arcade-gold"
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
      <div className="f7-container" style={{ background: PLAYER_BG_COLORS[0], padding: '16px' }}>
        <div className="setup-card arcade-panel" style={{ maxWidth: '620px', margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, color: '#fde047', textShadow: '0 2px 4px rgba(0,0,0,0.6)' }}>
              🏅 FLIP 7 명예의 전당
            </h2>
            <div style={{ width: '60px' }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <div className="hof-column-box">
              <h3 style={{ margin: '0 0 10px', fontSize: '15px', color: '#38bdf8', textAlign: 'center' }}>
                🎮 단독 플레이 TOP 10
              </h3>
              {soloRecords.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>기록이 없습니다.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {soloRecords.map((rec, i) => (
                    <div key={rec.id} className="hof-row-item">
                      <span><strong>{i + 1}. {rec.name}</strong></span>
                      <span style={{ color: '#34d399', fontWeight: 800 }}>{rec.scoreOrLevel}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="hof-column-box">
              <h3 style={{ margin: '0 0 10px', fontSize: '15px', color: '#fbbf24', textAlign: 'center' }}>
                🪙 넷플레이 TOP 10
              </h3>
              {netRecords.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>기록이 없습니다.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {netRecords.map((rec, i) => (
                    <div key={rec.id} className="hof-row-item">
                      <span><strong>{i + 1}. {rec.name}</strong></span>
                      <span style={{ color: '#fbbf24', fontWeight: 800 }}>{rec.scoreOrLevel}</span>
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
      <div className="f7-container" style={{ background: PLAYER_BG_COLORS[0] }}>
        <div className="net-lobby-container">
          <div className="net-lobby-header">
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, fontSize: '19px', color: '#fde047', fontWeight: 900 }}>
              🪙 FLIP 7 게임 테이블 로비
            </h2>
            <button
              type="button"
              className="btn btn-arcade-gold"
              style={{ fontSize: '12px', padding: '7px 12px' }}
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
                statusBadgeText = `🔥 ${room.roundNumber}라운드 진행중`;
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
                    <span className="room-number-title">🃏 TABLE #{room.roomId}</span>
                    <span className={`room-status-pill ${statusClass}`}>{statusBadgeText}</span>
                  </div>

                  <div className="room-rules-info">
                    <span>🪙 최소 판돈: {room.minBet.toLocaleString()}칩</span>
                    <span>⏱️ 턴 제한: {room.baseTimeout}초</span>
                  </div>

                  <div className="room-members-box">
                    <div className="room-members-label">착석 플레이어 ({roomPlayers.length}/4):</div>
                    <div className="room-members-chips">
                      {roomPlayers.length === 0 ? (
                        <span className="empty-member-text">첫 번째 도전자 대기 중</span>
                      ) : (
                        roomPlayers.map((p, idx) => (
                          <span
                            key={p.id}
                            className="member-chip"
                            style={{
                              borderColor: PIECE_COLORS[idx],
                              opacity: p.isEliminated ? 0.45 : 1,
                            }}
                          >
                            <i style={{ backgroundColor: PIECE_COLORS[idx] }} />
                            {p.name}{' '}
                            {p.isEliminated
                              ? '(아웃)'
                              : `(${p.wins || 0}승 · ${(p.chips ?? INITIAL_CHIPS).toLocaleString()})`}
                          </span>
                        ))
                      )}
                    </div>
                  </div>

                  {roomSpectators.length > 0 && (
                    <div className="room-waitlist-box" style={{ color: '#7dd3fc', background: 'rgba(14,165,233,0.18)' }}>
                      👀 관망 중 ({roomSpectators.length}명): {roomSpectators.map((s) => s.name).join(', ')}
                    </div>
                  )}

                  {roomWaitlist.length > 0 && (
                    <div className="room-waitlist-box">
                      ⏳ 다음 매치 예약 ({roomWaitlist.length}명):{' '}
                      {roomWaitlist.map((w) => w.name).join(', ')}
                    </div>
                  )}

                  <div className="room-enter-cta">
                    {isEmpty
                      ? '👉 클릭하여 테이블 착석 또는 관망하기'
                      : isPlaying || isFull
                      ? '👉 클릭하여 다음 매치 예약 또는 관망하기'
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
              <h2 style={{ margin: '0 0 8px', color: '#fde047' }}>🃏 TABLE #{joinModalRoom.roomId} 입장</h2>
              <p className="modal-subtext">
                판돈을 걸고 승리하면 총 판돈을 모두 차지합니다! 판돈 소진 시 즉시 아웃됩니다.
              </p>

              <input
                type="text"
                className="player-input"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: '14px' }}
                placeholder="내 닉네임 입력 (예: 럭키세븐)"
                value={joinPlayerName}
                autoFocus
                onChange={(e) => setJoinPlayerName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleEnterRoomSubmit(false)}
              />

              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ flex: 1 }}
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
                  🚀 착석하기 / 예약하기
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // =========================================================================
  // 4. 넷게임 방 내부 (판돈 베팅 -> 승리 시 독식 & 누적 -> 파산 시 아웃)
  // =========================================================================
  if (appMode === 'NET_ROOM') {
    if (!activeNetRoom) {
      return (
        <div className="f7-container" style={{ background: PLAYER_BG_COLORS[0], display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="setup-card arcade-panel" style={{ textAlign: 'center' }}>
            <h2 style={{ color: '#fde047' }}>⏳ 테이블 정보를 불러오는 중입니다...</h2>
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
        <div className="f7-container" style={{ background: PLAYER_BG_COLORS[0] }}>
          <div className="setup-card arcade-panel">
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
                TABLE #{activeNetRoom.roomId} · 대기 중 (⏱️ {countdownStr})
              </span>
            </div>

            <h1 className="setup-title" style={{ marginTop: '14px', color: '#fde047' }}>
              🃏 FLIP 7 대기실 {amISpectator ? '👀 [관망모드]' : ''}
            </h1>

            <div className="setting-section">
              <label className="setting-label">
                🪙 최소 베팅 판돈 설정 (초기 시드 10,000칩) {isHost ? '(방장 설정 가능)' : ''}
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
                ⏱️ 턴 제한시간: <strong style={{ color: '#fde047' }}>{activeNetRoom.baseTimeout}초</strong>
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#cbd5e1' }}>30초</span>
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
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#cbd5e1' }}>180초</span>
              </div>
            </div>

            <div className="setting-section">
              <label className="setting-label">🧭 착석 플레이어 (2명 이상 시 시작 가능)</label>
              <div className="player-list">
                {roomPlayers.map((p, idx) => (
                  <div key={p.id} className="player-item">
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="squircle-dot" style={{ backgroundColor: PIECE_COLORS[idx] }}>
                        {getShortName(p.name)}
                      </span>
                      {p.name} {idx === 0 && '👑(방장)'} {p.id === mySessionId && '(나)'}
                    </span>
                    <span style={{ fontSize: '12px', color: '#fbbf24', fontWeight: 800 }}>
                      🪙 {(p.chips ?? INITIAL_CHIPS).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <button
              type="button"
              className="btn btn-success"
              disabled={roomPlayers.length < 2}
              onClick={() => handleStartNetBettingPhase(false, true)}
            >
              🚀 FLIP 7 게임 시작! ({roomPlayers.length}/4명)
            </button>
          </div>
        </div>
      );
    }

    const netCurrIdx = (activeNetRoom.currentPlayerIdx || 0) % Math.max(1, roomPlayers.length);
    const netCurrPlayer = roomPlayers[netCurrIdx];
    const isMyTurn =
      activeNetRoom.status === 'PLAYING' &&
      !activeNetRoom.pendingAction &&
      netCurrPlayer?.id === mySessionId &&
      !amISpectator;
    const isMyPendingAction =
      activeNetRoom.status === 'PLAYING' &&
      activeNetRoom.pendingAction?.actorId === mySessionId &&
      !amISpectator;
    const myPlayerObj = roomPlayers.find((p) => p.id === mySessionId);
    const isRoundOver = activeNetRoom.status === 'ROUND_OVER';
    const isMatchOver = activeNetRoom.status === 'MATCH_OVER';
    const topDiscard =
      activeNetRoom.discardPile && activeNetRoom.discardPile.length > 0
        ? activeNetRoom.discardPile[activeNetRoom.discardPile.length - 1]
        : null;

    return (
      <div
        className="f7-container"
        style={{ background: PLAYER_BG_COLORS[netCurrIdx % PLAYER_BG_COLORS.length] }}
      >
        {renderFireworksAndChips()}

        {toast && (
          <div key={toast.id} className={`f7-toast ${toast.type}`}>
            {toast.text}
          </div>
        )}

        <div className="play-wrapper compact-tablet-mode">
          <div className="game-header compact-header">
            <div className="net-level-timer-box">
              <span className="net-level-badge">
                {activeNetRoom.roundNumber}R {amISpectator ? '👀' : ''}
              </span>
              {!isRoundOver && !isMatchOver && (
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
                      p.isEliminated || p.isBusted ? 'eliminated' : ''
                    }`}
                    style={{ borderColor: isActive ? '#fde047' : 'rgba(255,255,255,0.18)' }}
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
                      {p.isEliminated ? (
                        <span className="out-pill">🚫아웃</span>
                      ) : (
                        <>
                          <span className="win-count-pill">🏆{p.wins || 0}</span>
                          <span className="badge-score">🪙{(p.chips ?? 0).toLocaleString()}</span>
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
                ? '⏳ 현재 다음 매치 예약 대기 중입니다!'
                : `⏳ 다음 매치 예약자 (${roomWaitlist.length}명): ${roomWaitlist.map((w) => w.name).join(', ')}`}
            </div>
          )}

          {/* 카지노 펠트 테이블 보드 */}
          <div className="f7-table-board felt-surface">
            {isRoundOver || isMatchOver ? (
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
                  {isMatchOver ? (
                    <button
                      type="button"
                      className="btn btn-success"
                      style={{ width: 'auto', padding: '6px 18px', fontSize: '14px' }}
                      onClick={() => handleStartNetBettingPhase(false, true)}
                    >
                      🔄 새 매치 시작 (전원 칩 리셋)
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-success"
                      style={{ width: 'auto', padding: '6px 18px', fontSize: '14px' }}
                      onClick={() => handleStartNetBettingPhase(true, false)}
                    >
                      🔥 다음 라운드 시작 (획득 판돈 누적)
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div key={activeNetRoom.turnNotice} className="f7-notice-banner">
                {activeNetRoom.turnNotice}
              </div>
            )}

            {/* 테이블 중앙: 실물 카드 덱 더미 + 총 판돈(POT) + 버린 카드 더미 */}
            <div className="table-center-dealer-zone">
              <div className="deck-pile-stack" title="남은 드로우 덱">
                <div className="card-back-physical">
                  <span className="back-brand">FLIP</span>
                  <span className="back-seven">7</span>
                </div>
                <span className="pile-count-tag">{(activeNetRoom.deck || []).length}장</span>
              </div>

              <div className="center-pot-medallion">
                {renderCasinoChipStack(activeNetRoom.pot || 0, 'TOTAL POT')}
              </div>

              <div className="discard-pile-slot" title="버린 카드 더미">
                {topDiscard ? (
                  <div className="mini-discard-preview">
                    <span>{topDiscard.label}</span>
                  </div>
                ) : (
                  <div className="empty-discard-outline">DISCARD</div>
                )}
                <span className="pile-count-tag">버림 {(activeNetRoom.discardPile || []).length}</span>
              </div>
            </div>

            {/* 플레이어 좌석 그리드 */}
            <div className="players-seats-grid">
              {roomPlayers.map((p, idx) => {
                const isTurn =
                  !p.isEliminated &&
                  ((activeNetRoom.status === 'PLAYING' && idx === netCurrIdx) ||
                    (activeNetRoom.status === 'BETTING' && !p.hasPlacedBet));
                const liveScore = calculateFlip7RoundScore(p);

                return (
                  <div
                    key={p.id}
                    className={`seat-hand-card ${isTurn ? 'seat-active-turn' : ''} ${
                      p.isEliminated ? 'seat-eliminated' : ''
                    } ${
                      p.roundResult === 'WIN' || p.roundResult === 'FLIP7_WIN'
                        ? 'seat-winner-glow'
                        : ''
                    }`}
                  >
                    <div className="seat-header">
                      <span className="squircle-dot mini" style={{ backgroundColor: p.color }}>
                        {getShortName(p.name)}
                      </span>
                      <strong className={isTurn ? 'seat-hero-name' : ''}>
                        {isTurn && '🔥 '}
                        {p.name}
                        {p.id === mySessionId ? '(나)' : ''}
                      </strong>

                      {!p.isEliminated && (
                        <span className="seat-bet-chip">
                          <i className="mini-chip-dot" />
                          {p.currentBet.toLocaleString()}
                        </span>
                      )}

                      {!p.isEliminated && (
                        <span className="seat-score-tag">
                          {p.isBusted ? '💥 BUST' : `${liveScore} PTS`}
                          {p.isStayed && !p.isBusted ? ' 🔒' : ''}
                        </span>
                      )}
                    </div>

                    {/* Flip 7 7칸 홀더 슬롯 */}
                    {!p.isEliminated && (
                      <div className="flip7-progress-dots">
                        {[0, 1, 2, 3, 4, 5, 6].map((slot) => (
                          <span
                            key={slot}
                            className={`f7-slot-dot ${
                              (p.numberCards || []).length > slot ? 'filled' : ''
                            }`}
                          >
                            {(p.numberCards || [])[slot]?.label ?? '•'}
                          </span>
                        ))}
                      </div>
                    )}

                    {p.roundResult !== 'NONE' && (
                      <div style={{ margin: '2px 0' }}>{renderResultBadge(p.roundResult)}</div>
                    )}

                    <div className="cards-row">
                      {p.isEliminated ? (
                        <span className="bet-status-text" style={{ color: '#fca5a5' }}>
                          🚫 판돈 소진 탈락
                        </span>
                      ) : activeNetRoom.status === 'BETTING' ? (
                        <span className="bet-status-text">
                          {p.hasPlacedBet ? '✅ 판돈 베팅 완료!' : '⏳ 베팅 대기 중...'}
                        </span>
                      ) : (
                        <>
                          {(p.numberCards || []).map((card, cIdx) =>
                            renderFlipCard(
                              card,
                              p.isBusted && cIdx === p.numberCards.length - 1
                            )
                          )}
                          {(p.modifierCards || []).map((card) => renderFlipCard(card))}
                          {p.hasSecondChance && (
                            <div className="f7-card card-second-chance" title="버스트 1회 방어 카드">
                              <div className="f7-card-inner-frame">
                                <span className="f7-card-main" style={{ fontSize: '18px' }}>🛡️</span>
                                <span className="f7-card-sub">2ND CHANCE</span>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {amISpectator && (
            <div className="f7-bottom-dock">
              <div className="waiting-dock-msg">
                👀 관망모드로 실시간 판돈 대결을 시청 중입니다.
              </div>
            </div>
          )}

          {myPlayerObj && !amISpectator && (
            <div
              className="f7-bottom-dock"
              style={{ borderTop: `4px solid ${myPlayerObj.color}` }}
            >
              {myPlayerObj.isEliminated ? (
                <div className="waiting-dock-msg" style={{ color: '#fca5a5' }}>
                  🚫 보유 판돈이 모두 소진되어 이번 매치에서 아웃되었습니다!
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
                              className={`preset-chip-btn ${netSelectedBet === validAmt ? 'active' : ''}`}
                              onClick={() => setNetSelectedBet(validAmt)}
                            >
                              <span className="btn-chip-icon">🪙</span>
                              {i === 3
                                ? `ALL-IN (${validAmt.toLocaleString()})`
                                : `${validAmt.toLocaleString()}`}
                            </button>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        className="btn btn-arcade-hit"
                        style={{ width: '100%' }}
                        onClick={() => handleNetPlaceBet(netSelectedBet)}
                      >
                        🪙 {Math.min(myPlayerObj.chips, netSelectedBet).toLocaleString()}칩 베팅하기!
                      </button>
                    </div>
                  )}

                  {activeNetRoom.status === 'BETTING' && myPlayerObj.hasPlacedBet && (
                    <div className="waiting-dock-msg">
                      ✅ {myPlayerObj.currentBet.toLocaleString()}칩 베팅 완료! 다른 참가자를 기다리는 중...
                    </div>
                  )}

                  {activeNetRoom.status === 'PLAYING' && (
                    <>
                      {isMyPendingAction && activeNetRoom.pendingAction ? (
                        <div className="action-target-panel">
                          <div className="action-target-title">
                            ⚡ <strong>{activeNetRoom.pendingAction.cardLabel}</strong> 적용 대상 선택:
                          </div>
                          <div className="action-target-buttons">
                            {roomPlayers
                              .filter((p) => !p.isEliminated && !p.isBusted && !p.isStayed)
                              .map((target) => (
                                <button
                                  key={target.id}
                                  type="button"
                                  className="f7-act-btn target"
                                  onClick={() => handleNetSelectActionTarget(target.id)}
                                >
                                  🎯 {target.name} {target.id === mySessionId ? '(나)' : ''}
                                </button>
                              ))}
                          </div>
                        </div>
                      ) : activeNetRoom.pendingAction ? (
                        <div className="waiting-dock-msg">
                          ⚡ <strong>{activeNetRoom.pendingAction.actorName}</strong>님이 [{activeNetRoom.pendingAction.cardLabel}] 대상을 선택 중입니다...
                        </div>
                      ) : isMyTurn ? (
                        <div className="f7-actions-row">
                          <button
                            type="button"
                            className="f7-act-btn hit"
                            onClick={() => handleNetPlayAction('HIT')}
                          >
                            🃏 HIT (카드 뒤집기)
                          </button>
                          <button
                            type="button"
                            className="f7-act-btn stay"
                            onClick={() => handleNetPlayAction('STAY')}
                          >
                            ✋ STAY ({calculateFlip7RoundScore(myPlayerObj)}점 확정)
                          </button>
                        </div>
                      ) : (
                        <div className="waiting-dock-msg">
                          ⏳ 현재 <strong>{netCurrPlayer?.name}</strong>님의 차례입니다...
                        </div>
                      )}
                    </>
                  )}

                  {(isRoundOver || isMatchOver) && (
                    <div className="waiting-dock-msg">
                      🏆 상단의 버튼을 눌러 {isMatchOver ? '새 매치를 시작' : '다음 라운드로 판돈을 이어가'}세요!
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
  // 5. 단독게임(SOLO) - 한 기기에서 2~4인 로컬 대전
  // =========================================================================
  const currentPlayer = players[currentPlayerIdx] || players[0];
  const currentBackground =
    gameState === 'PLAYING' && players.length > 0
      ? PLAYER_BG_COLORS[currentPlayerIdx % PLAYER_BG_COLORS.length]
      : PLAYER_BG_COLORS[0];
  const isSoloRoundOver = gameState === 'ROUND_OVER';
  const soloTopDiscard =
    discardPile.length > 0 ? discardPile[discardPile.length - 1] : null;

  return (
    <div className="f7-container" style={{ background: currentBackground }}>
      {renderFireworksAndChips()}

      {toast && (
        <div key={toast.id} className={`f7-toast ${toast.type}`}>
          {toast.text}
        </div>
      )}

      {gameState === 'SETUP' && (
        <div className="setup-card arcade-panel">
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
              className="btn btn-arcade-gold"
              style={{ padding: '6px 12px', fontSize: '12px' }}
              onClick={() => setAppMode('HALL_OF_FAME')}
            >
              🏅 명예의 전당
            </button>
          </div>
          <h1 className="setup-title" style={{ color: '#fde047' }}>🃏 FLIP 7 (단독게임 설정)</h1>

          <div className="setting-section">
            <label className="setting-label">
              ⏱️ 턴 제한시간 설정: <strong style={{ color: '#fde047' }}>{soloTimeoutSec}초</strong>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: '#cbd5e1' }}>30초</span>
              <input
                type="range"
                min={30}
                max={180}
                step={10}
                value={soloTimeoutSec}
                style={{ flex: 1 }}
                onChange={(e) => setSoloTimeoutSec(Number(e.target.value))}
              />
              <span style={{ fontSize: '12px', fontWeight: 700, color: '#cbd5e1' }}>180초</span>
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
        <div className="order-panel arcade-panel">
          <div className="order-header">
            <h2 style={{ margin: 0, fontSize: '20px', color: '#fde047' }}>📋 진행 순서 설정</h2>
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
                  <strong style={{ color: '#38bdf8' }}>{idx + 1}번째</strong>
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
              🚀 FLIP 7 시작!
            </button>
          </div>
        </div>
      )}

      {(gameState === 'PLAYING' || gameState === 'ROUND_OVER') && currentPlayer && (
        <div className="play-wrapper compact-tablet-mode">
          <div className="game-header compact-header">
            <div className="net-level-timer-box">
              <span className="net-level-badge">{soloRoundNum}R</span>
              {!isSoloRoundOver && (
                <span className={`net-timer-badge ${soloRemainingSec <= 10 ? 'urgent' : ''}`}>
                  ⏱️ {soloRemainingSec}초
                </span>
              )}
            </div>

            <div className="player-status-bar">
              {players.map((p, idx) => {
                const isActive = !isSoloRoundOver && idx === currentPlayerIdx;
                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${isActive ? 'active-turn-spotlight' : ''} ${
                      p.isBusted ? 'eliminated' : ''
                    }`}
                    style={{ borderColor: isActive ? '#fde047' : 'rgba(255,255,255,0.18)' }}
                  >
                    <div className="player-badge-top">
                      <span className="squircle-dot mini" style={{ backgroundColor: p.color }}>
                        {getShortName(p.name)}
                      </span>
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '👉 '}
                        {p.name}
                      </strong>
                      <span className="win-count-pill">🏆{p.wins}</span>
                      <span className="badge-score">{p.totalPoints}점</span>
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

          {/* 카지노 펠트 테이블 보드 */}
          <div className="f7-table-board felt-surface">
            {isSoloRoundOver ? (
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
                    onClick={() => startSoloRound(true)}
                  >
                    🔥 다음 라운드 시작 (승수·점수 누적)
                  </button>
                </div>
              </div>
            ) : (
              <div key={turnNotice} className="f7-notice-banner">
                {turnNotice}
              </div>
            )}

            {/* 중앙 실물 덱 & 버림 더미 */}
            <div className="table-center-dealer-zone">
              <div className="deck-pile-stack">
                <div className="card-back-physical">
                  <span className="back-brand">FLIP</span>
                  <span className="back-seven">7</span>
                </div>
                <span className="pile-count-tag">{deck.length}장</span>
              </div>

              <div className="discard-pile-slot">
                {soloTopDiscard ? (
                  <div className="mini-discard-preview">
                    <span>{soloTopDiscard.label}</span>
                  </div>
                ) : (
                  <div className="empty-discard-outline">DISCARD</div>
                )}
                <span className="pile-count-tag">버림 {discardPile.length}</span>
              </div>
            </div>

            <div className="players-seats-grid">
              {players.map((p, idx) => {
                const isTurn = !isSoloRoundOver && idx === currentPlayerIdx;
                const liveScore = calculateFlip7RoundScore(p);

                return (
                  <div
                    key={p.id}
                    className={`seat-hand-card ${isTurn ? 'seat-active-turn' : ''} ${
                      p.roundResult === 'WIN' || p.roundResult === 'FLIP7_WIN'
                        ? 'seat-winner-glow'
                        : ''
                    }`}
                  >
                    <div className="seat-header">
                      <span className="squircle-dot mini" style={{ backgroundColor: p.color }}>
                        {getShortName(p.name)}
                      </span>
                      <strong className={isTurn ? 'seat-hero-name' : ''}>
                        {isTurn && '🔥 '}
                        {p.name}
                      </strong>
                      <span className="seat-score-tag">
                        {p.isBusted ? '💥 BUST' : `${liveScore} PTS`}
                        {p.isStayed && !p.isBusted ? ' 🔒' : ''}
                      </span>
                    </div>

                    <div className="flip7-progress-dots">
                      {[0, 1, 2, 3, 4, 5, 6].map((slot) => (
                        <span
                          key={slot}
                          className={`f7-slot-dot ${
                            (p.numberCards || []).length > slot ? 'filled' : ''
                          }`}
                        >
                          {(p.numberCards || [])[slot]?.label ?? '•'}
                        </span>
                      ))}
                    </div>

                    {p.roundResult !== 'NONE' && (
                      <div style={{ margin: '2px 0' }}>{renderResultBadge(p.roundResult)}</div>
                    )}

                    <div className="cards-row">
                      {(p.numberCards || []).map((card, cIdx) =>
                        renderFlipCard(
                          card,
                          p.isBusted && cIdx === p.numberCards.length - 1
                        )
                      )}
                      {(p.modifierCards || []).map((card) => renderFlipCard(card))}
                      {p.hasSecondChance && (
                        <div className="f7-card card-second-chance" title="버스트 1회 방어 카드">
                          <div className="f7-card-inner-frame">
                            <span className="f7-card-main" style={{ fontSize: '18px' }}>🛡️</span>
                            <span className="f7-card-sub">2ND CHANCE</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div
            className="f7-bottom-dock"
            style={{ borderTop: `4px solid ${currentPlayer.color}` }}
          >
            <div className="dock-top-status">
              <span
                className="turn-owner-pill large-turn-pill"
                style={{ backgroundColor: currentPlayer.color }}
              >
                👉 {currentPlayer.name}님 차례 · 🏆{currentPlayer.wins}승 · 누적{' '}
                {currentPlayer.totalPoints}점
              </span>
            </div>

            {gameState === 'PLAYING' && (
              <>
                {soloPendingAction ? (
                  <div className="action-target-panel">
                    <div className="action-target-title">
                      ⚡ <strong>{soloPendingAction.cardLabel}</strong> 적용 대상 선택:
                    </div>
                    <div className="action-target-buttons">
                      {players
                        .filter((p) => !p.isBusted && !p.isStayed)
                        .map((target) => (
                          <button
                            key={target.id}
                            type="button"
                            className="f7-act-btn target"
                            onClick={() => handleSoloSelectActionTarget(target.id)}
                          >
                            🎯 {target.name}
                          </button>
                        ))}
                    </div>
                  </div>
                ) : (
                  <div className="f7-actions-row">
                    <button type="button" className="f7-act-btn hit" onClick={handleSoloHit}>
                      🃏 HIT (카드 뒤집기)
                    </button>
                    <button type="button" className="f7-act-btn stay" onClick={handleSoloStay}>
                      ✋ STAY ({calculateFlip7RoundScore(currentPlayer)}점 확정)
                    </button>
                  </div>
                )}
              </>
            )}

            {isSoloRoundOver && (
              <div className="waiting-dock-msg">
                🎉 라운드 종료! <strong>[다음 라운드 시작]</strong> 버튼을 눌러 승부를 이어가세요!
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}