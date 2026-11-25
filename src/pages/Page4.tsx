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
import './Page4.css';

// =========================================================================
// 타입 정의 (Strict TypeScript)
// =========================================================================
type ResourceType = 'wood' | 'brick' | 'sheep' | 'wheat' | 'ore';
type TerrainType = ResourceType | 'desert';
type DevCardType = 'knight' | 'victory' | 'road_building' | 'year_of_plenty' | 'monopoly';
type PlayerColor = 'red' | 'blue' | 'orange' | 'white';

type GamePhase =
  | 'SETUP_1_SETTLEMENT'
  | 'SETUP_1_ROAD'
  | 'SETUP_2_SETTLEMENT'
  | 'SETUP_2_ROAD'
  | 'ROLL_DICE'
  | 'ROBBER_MOVE'
  | 'MAIN_TURN'
  | 'ROAD_BUILDING_CARD'
  | 'ROUND_OVER'
  | 'MATCH_OVER';

interface ResourceHand {
  wood: number;
  brick: number;
  sheep: number;
  wheat: number;
  ore: number;
}

interface HexTile {
  id: number;
  q: number;
  r: number;
  cx: number;
  cy: number;
  terrain: TerrainType;
  numberToken: number | null;
}

interface BoardVertex {
  id: number;
  x: number;
  y: number;
  adjacentHexIds: number[];
  adjacentVertexIds: number[];
  adjacentEdgeIds: number[];
}

interface BoardEdge {
  id: number;
  v1: number;
  v2: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface CatanBoardData {
  hexes: HexTile[];
  vertices: BoardVertex[];
  edges: BoardEdge[];
}

interface BuildingSlot {
  ownerId: string;
  color: PlayerColor;
  type: 'settlement' | 'city';
}

interface RoadSlot {
  ownerId: string;
  color: PlayerColor;
}

interface CatanPlayer {
  id: string;
  name: string;
  color: PlayerColor;
  chips: number;
  wins: number;
  resources: ResourceHand;
  devCards: DevCardType[];
  newDevCards: DevCardType[]; // 이번 턴에 구매해 다음 턴부터 사용 가능한 카드
  knightsPlayed: number;
  devCardPlayedThisTurn: boolean;
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

interface NetCatanRoomData {
  roomId: number;
  status: 'EMPTY' | 'WAITING' | 'PLAYING' | 'ROUND_OVER' | 'MATCH_OVER';
  players: CatanPlayer[];
  pot: number;
  waitlist: WaitlistPlayer[];
  spectators: SpectatorPlayer[];
  baseTimeout: number;
  anteBet: number;
  targetVP: number;
  roundNumber: number;
  phase: GamePhase;
  currentTurnIdx: number;
  setupStepIdx: number;
  lastPlacedVertexId: number | null;
  freeRoadsRemaining: number;
  dice: [number, number];
  robberHexId: number;
  longestRoadOwnerId: string | null;
  largestArmyOwnerId: string | null;
  board: CatanBoardData;
  buildings: Record<string, BuildingSlot>;
  roads: Record<string, RoadSlot>;
  devDeck: DevCardType[];
  turnDeadline: number | null;
  turnNotice: string;
  winnerAnnouncement: string;
  waitingSince: number | null;
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

// =========================================================================
// 상수 및 한글 메타데이터
// =========================================================================
const WOOD_BG_THEMES = [
  'radial-gradient(circle at top, #5d4037 0%, #3e2723 60%, #261612 100%)',
  'radial-gradient(circle at top, #4e342e 0%, #321f1a 60%, #1f120e 100%)',
];

const INITIAL_CHIPS = 10000;
const DEFAULT_TIMEOUT_SEC = 90;
const HEX_RADIUS = 56;

const RESOURCE_KEYS: readonly ResourceType[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

const RESOURCE_META: Record<
  ResourceType,
  { label: string; icon: string; badgeBg: string; textColor: string }
> = {
  wood: { label: '목재', icon: '🌲', badgeBg: '#2e7d32', textColor: '#ffffff' },
  brick: { label: '벽돌', icon: '🧱', badgeBg: '#c62828', textColor: '#ffffff' },
  sheep: { label: '양모', icon: '🐑', badgeBg: '#689f38', textColor: '#ffffff' },
  wheat: { label: '밀', icon: '🌾', badgeBg: '#f9a825', textColor: '#2c1810' },
  ore: { label: '철광석', icon: '⛰️', badgeBg: '#546e7a', textColor: '#ffffff' },
};

const TERRAIN_META: Record<
  TerrainType,
  { label: string; icon: string; fill: string; stroke: string }
> = {
  wood: { label: '숲', icon: '🌲', fill: '#388e3c', stroke: '#1b5e20' },
  brick: { label: '언덕', icon: '🧱', fill: '#d84315', stroke: '#8e0000' },
  sheep: { label: '목초지', icon: '🐑', fill: '#8bc34a', stroke: '#558b2f' },
  wheat: { label: '농지', icon: '🌾', fill: '#fbc02d', stroke: '#f57f17' },
  ore: { label: '산', icon: '⛰️', fill: '#78909c', stroke: '#37474f' },
  desert: { label: '사막', icon: '🏜️', fill: '#e6c994', stroke: '#a1887f' },
};

const PLAYER_COLORS: readonly PlayerColor[] = ['red', 'blue', 'orange', 'white'];

const PLAYER_COLOR_META: Record<PlayerColor, { label: string; hex: string; text: string }> = {
  red: { label: '빨강', hex: '#d32f2f', text: '#ffffff' },
  blue: { label: '파랑', hex: '#1976d2', text: '#ffffff' },
  orange: { label: '주황', hex: '#f57c00', text: '#ffffff' },
  white: { label: '하양', hex: '#f5f5f5', text: '#2c1810' },
};

const DEV_CARD_META: Record<DevCardType, { label: string; icon: string; desc: string }> = {
  knight: { label: '기사', icon: '⚔️', desc: '도둑을 이동시키고 인접 플레이어 자원 1장 약탈' },
  victory: { label: '승점 (+1)', icon: '🏛️', desc: '공개 즉시 승점 1점 획득' },
  road_building: { label: '도로 건설', icon: '🛣️', desc: '자원 소모 없이 도로 2개 무료 건설' },
  year_of_plenty: { label: '풍년', icon: '🌽', desc: '원하는 자원 2장을 은행에서 즉시 획득' },
  monopoly: { label: '독점', icon: '💰', desc: '지정한 자원 1종류를 모든 플레이어에게서 회수' },
};

const BUILD_COSTS = {
  road: { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 },
  city: { wood: 0, brick: 0, sheep: 0, wheat: 2, ore: 3 },
  devCard: { wood: 0, brick: 0, sheep: 1, wheat: 1, ore: 1 },
} as const;

// =========================================================================
// 카탄 유틸리티 및 그래프/룰 엔진
// =========================================================================
function createEmptyHand(): ResourceHand {
  return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
}

function getTotalResources(hand: ResourceHand): number {
  return hand.wood + hand.brick + hand.sheep + hand.wheat + hand.ore;
}

function hasEnoughResources(hand: ResourceHand, cost: ResourceHand): boolean {
  return (
    hand.wood >= cost.wood &&
    hand.brick >= cost.brick &&
    hand.sheep >= cost.sheep &&
    hand.wheat >= cost.wheat &&
    hand.ore >= cost.ore
  );
}

function subtractResources(hand: ResourceHand, cost: ResourceHand): ResourceHand {
  return {
    wood: Math.max(0, hand.wood - cost.wood),
    brick: Math.max(0, hand.brick - cost.brick),
    sheep: Math.max(0, hand.sheep - cost.sheep),
    wheat: Math.max(0, hand.wheat - cost.wheat),
    ore: Math.max(0, hand.ore - cost.ore),
  };
}


function shuffleArray<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createShuffledDevDeck(): DevCardType[] {
  const deck: DevCardType[] = [
    ...Array<DevCardType>(14).fill('knight'),
    ...Array<DevCardType>(5).fill('victory'),
    ...Array<DevCardType>(2).fill('road_building'),
    ...Array<DevCardType>(2).fill('year_of_plenty'),
    ...Array<DevCardType>(2).fill('monopoly'),
  ];
  return shuffleArray(deck);
}

/**
 * 19개 육각 타일, 54개 꼭짓점, 72개 변을 기하학적으로 생성
 */
function generateCatanBoard(): { board: CatanBoardData; desertHexId: number } {
  const terrains: TerrainType[] = shuffleArray([
    'wood',
    'wood',
    'wood',
    'wood',
    'brick',
    'brick',
    'brick',
    'sheep',
    'sheep',
    'sheep',
    'sheep',
    'wheat',
    'wheat',
    'wheat',
    'wheat',
    'ore',
    'ore',
    'ore',
    'desert',
  ]);

  const numberTokens = shuffleArray([2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]);

  const axialCoords: [number, number][] = [];
  for (let q = -2; q <= 2; q++) {
    const rMin = Math.max(-2, -q - 2);
    const rMax = Math.min(2, -q + 2);
    for (let r = rMin; r <= rMax; r++) {
      axialCoords.push([q, r]);
    }
  }

  let tokenIdx = 0;
  let desertHexId = 0;

  const hexes: HexTile[] = axialCoords.map(([q, r], id) => {
    const terrain = terrains[id];
    const cx = HEX_RADIUS * Math.sqrt(3) * (q + r / 2);
    const cy = HEX_RADIUS * 1.5 * r;
    let numberToken: number | null = null;

    if (terrain === 'desert') {
      desertHexId = id;
    } else {
      numberToken = numberTokens[tokenIdx++];
    }

    return { id, q, r, cx, cy, terrain, numberToken };
  });

  const vertices: BoardVertex[] = [];
  const edges: BoardEdge[] = [];

  const findOrCreateVertex = (x: number, y: number, hexId: number): number => {
    const existing = vertices.find((v) => Math.hypot(v.x - x, v.y - y) < 4);
    if (existing) {
      if (!existing.adjacentHexIds.includes(hexId)) {
        existing.adjacentHexIds.push(hexId);
      }
      return existing.id;
    }
    const newVertex: BoardVertex = {
      id: vertices.length,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      adjacentHexIds: [hexId],
      adjacentVertexIds: [],
      adjacentEdgeIds: [],
    };
    vertices.push(newVertex);
    return newVertex.id;
  };

  const findOrCreateEdge = (v1: number, v2: number): number => {
    const existing = edges.find(
      (e) => (e.v1 === v1 && e.v2 === v2) || (e.v1 === v2 && e.v2 === v1)
    );
    if (existing) return existing.id;

    const vert1 = vertices[v1];
    const vert2 = vertices[v2];
    const newEdge: BoardEdge = {
      id: edges.length,
      v1,
      v2,
      x1: vert1.x,
      y1: vert1.y,
      x2: vert2.x,
      y2: vert2.y,
    };
    edges.push(newEdge);

    if (!vert1.adjacentVertexIds.includes(v2)) vert1.adjacentVertexIds.push(v2);
    if (!vert2.adjacentVertexIds.includes(v1)) vert2.adjacentVertexIds.push(v1);
    if (!vert1.adjacentEdgeIds.includes(newEdge.id)) vert1.adjacentEdgeIds.push(newEdge.id);
    if (!vert2.adjacentEdgeIds.includes(newEdge.id)) vert2.adjacentEdgeIds.push(newEdge.id);

    return newEdge.id;
  };

  for (const hex of hexes) {
    const cornerIds: number[] = [];
    for (let i = 0; i < 6; i++) {
      const angleRad = ((60 * i - 30) * Math.PI) / 180;
      const vx = hex.cx + HEX_RADIUS * Math.cos(angleRad);
      const vy = hex.cy + HEX_RADIUS * Math.sin(angleRad);
      cornerIds.push(findOrCreateVertex(vx, vy, hex.id));
    }
    for (let i = 0; i < 6; i++) {
      findOrCreateEdge(cornerIds[i], cornerIds[(i + 1) % 6]);
    }
  }

  return {
    board: { hexes, vertices, edges },
    desertHexId,
  };
}

/**
 * 스네이크 드래프트 순서 생성 (예: 3인 -> [0, 1, 2, 2, 1, 0])
 */
function getSetupOrder(playerCount: number): number[] {
  const forward = Array.from({ length: playerCount }, (_, i) => i);
  const backward = [...forward].reverse();
  return [...forward, ...backward];
}

/**
 * 특정 플레이어의 최장 연속 도로 길이 계산 (DFS 백트래킹)
 */
function computeLongestRoadForPlayer(
  playerId: string,
  board: CatanBoardData,
  roads: Record<string, RoadSlot>,
  buildings: Record<string, BuildingSlot>
): number {
  const playerEdges = board.edges.filter((e) => roads[String(e.id)]?.ownerId === playerId);
  if (playerEdges.length === 0) return 0;

  let maxLen = 0;

  const dfs = (currentVertexId: number, visitedEdges: Set<number>): number => {
    const vertex = board.vertices[currentVertexId];
    if (!vertex) return 0;

    // 상대방 마을/도시가 세워진 꼭짓점은 도로 연결 차단
    const blocker = buildings[String(currentVertexId)];
    if (blocker && blocker.ownerId !== playerId && visitedEdges.size > 0) {
      return 0;
    }

    let best = 0;
    for (const edgeId of vertex.adjacentEdgeIds) {
      if (visitedEdges.has(edgeId)) continue;
      if (roads[String(edgeId)]?.ownerId !== playerId) continue;

      const edge = board.edges[edgeId];
      const nextVertexId = edge.v1 === currentVertexId ? edge.v2 : edge.v1;

      visitedEdges.add(edgeId);
      const branchLen = 1 + dfs(nextVertexId, visitedEdges);
      visitedEdges.delete(edgeId);

      if (branchLen > best) best = branchLen;
    }
    return best;
  };

  for (const edge of playerEdges) {
    const visited1 = new Set<number>([edge.id]);
    const len1 = 1 + dfs(edge.v1, visited1);
    if (len1 > maxLen) maxLen = len1;

    const visited2 = new Set<number>([edge.id]);
    const len2 = 1 + dfs(edge.v2, visited2);
    if (len2 > maxLen) maxLen = len2;
  }

  return maxLen;
}

/**
 * 최장 교역로(5개 이상) 보유자 갱신
 */
function evaluateLongestRoadOwner(
  players: CatanPlayer[],
  currentOwnerId: string | null,
  board: CatanBoardData,
  roads: Record<string, RoadSlot>,
  buildings: Record<string, BuildingSlot>
): string | null {
  let bestOwner = currentOwnerId;
  let bestLength =
    currentOwnerId != null
      ? computeLongestRoadForPlayer(currentOwnerId, board, roads, buildings)
      : 4;

  if (bestLength < 5) {
    bestOwner = null;
    bestLength = 4;
  }

  for (const p of players) {
    const len = computeLongestRoadForPlayer(p.id, board, roads, buildings);
    if (len >= 5 && len > bestLength) {
      bestLength = len;
      bestOwner = p.id;
    }
  }
  return bestOwner;
}

/**
 * 최강 기사단(3장 이상) 보유자 갱신
 */
function evaluateLargestArmyOwner(
  players: CatanPlayer[],
  currentOwnerId: string | null
): string | null {
  let bestOwner = currentOwnerId;
  let bestCount =
    currentOwnerId != null
      ? players.find((p) => p.id === currentOwnerId)?.knightsPlayed ?? 2
      : 2;

  if (bestCount < 3) {
    bestOwner = null;
    bestCount = 2;
  }

  for (const p of players) {
    if (p.knightsPlayed >= 3 && p.knightsPlayed > bestCount) {
      bestCount = p.knightsPlayed;
      bestOwner = p.id;
    }
  }
  return bestOwner;
}

/**
 * 플레이어 현재 총 승점 계산
 */
function calculatePlayerVP(
  player: CatanPlayer,
  buildings: Record<string, BuildingSlot>,
  longestRoadOwnerId: string | null,
  largestArmyOwnerId: string | null
): number {
  let vp = 0;

  for (const b of Object.values(buildings)) {
    if (b.ownerId === player.id) {
      vp += b.type === 'city' ? 2 : 1;
    }
  }

  const allDevCards = [...(player.devCards || []), ...(player.newDevCards || [])];
  for (const card of allDevCards) {
    if (card === 'victory') vp += 1;
  }

  if (longestRoadOwnerId === player.id) vp += 2;
  if (largestArmyOwnerId === player.id) vp += 2;

  return vp;
}

/**
 * 꼭짓점에 마을 건설 가능 여부 (거리 2칸 규칙 + 초기 배치 여부)
 */
function canBuildSettlementAt(
  vertexId: number,
  playerId: string,
  board: CatanBoardData,
  buildings: Record<string, BuildingSlot>,
  roads: Record<string, RoadSlot>,
  isSetupPhase: boolean
): boolean {
  const vertex = board.vertices[vertexId];
  if (!vertex) return false;
  if (buildings[String(vertexId)]) return false;

  // 인접 꼭짓점에 건물이 하나라도 있으면 건설 불가
  for (const adjVId of vertex.adjacentVertexIds) {
    if (buildings[String(adjVId)]) return false;
  }

  if (isSetupPhase) return true;

  // 일반 턴에서는 본인 도로와 연결되어 있어야 함
  return vertex.adjacentEdgeIds.some((eId) => roads[String(eId)]?.ownerId === playerId);
}

/**
 * 변에 도로 건설 가능 여부
 */
function canBuildRoadAt(
  edgeId: number,
  playerId: string,
  board: CatanBoardData,
  buildings: Record<string, BuildingSlot>,
  roads: Record<string, RoadSlot>,
  mustTouchVertexId: number | null = null
): boolean {
  const edge = board.edges[edgeId];
  if (!edge) return false;
  if (roads[String(edgeId)]) return false;

  if (mustTouchVertexId !== null) {
    return edge.v1 === mustTouchVertexId || edge.v2 === mustTouchVertexId;
  }

  const endpoints = [edge.v1, edge.v2];
  for (const vId of endpoints) {
    const b = buildings[String(vId)];
    if (b && b.ownerId === playerId) return true;
    // 상대 건물에 막히지 않은 본인 도로와 연결된 경우
    if (!b || b.ownerId === playerId) {
      const vertex = board.vertices[vId];
      if (vertex.adjacentEdgeIds.some((adjEId) => roads[String(adjEId)]?.ownerId === playerId)) {
        return true;
      }
    }
  }
  return false;
}

function createDefaultCatanRoom(roomId: number): NetCatanRoomData {
  const { board, desertHexId } = generateCatanBoard();
  return {
    roomId,
    status: 'EMPTY',
    players: [],
    pot: 0,
    waitlist: [],
    spectators: [],
    baseTimeout: DEFAULT_TIMEOUT_SEC,
    anteBet: 1000,
    targetVP: 10,
    roundNumber: 1,
    phase: 'SETUP_1_SETTLEMENT',
    currentTurnIdx: 0,
    setupStepIdx: 0,
    lastPlacedVertexId: null,
    freeRoadsRemaining: 0,
    dice: [3, 4],
    robberHexId: desertHexId,
    longestRoadOwnerId: null,
    largestArmyOwnerId: null,
    board,
    buildings: {},
    roads: {},
    devDeck: createShuffledDevDeck(),
    turnDeadline: null,
    turnNotice: '',
    winnerAnnouncement: '',
    waitingSince: null,
  };
}

// =========================================================================
// 메인 컴포넌트
// =========================================================================
export default function Page4() {
  const [appMode, setAppMode] = useState<
    'HOME' | 'SOLO' | 'NET_LOBBY' | 'NET_ROOM' | 'HALL_OF_FAME'
  >('HOME');

  const [mySessionId] = useState<string>(() => {
    const saved = sessionStorage.getItem('catan_net_uid');
    if (saved) return saved;
    const generated = `catan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('catan_net_uid', generated);
    return generated;
  });

  // 넷게임 상태
  const [rooms, setRooms] = useState<NetCatanRoomData[]>(
    [1, 2, 3, 4].map(createDefaultCatanRoom)
  );
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [joinModalRoom, setJoinModalRoom] = useState<NetCatanRoomData | null>(null);
  const [joinPlayerName, setJoinPlayerName] = useState<string>('');
  const [remainingSeconds, setRemainingSeconds] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [waitingCountdownSec, setWaitingCountdownSec] = useState<number>(420);
  const timeoutHandledRef = useRef<number | null>(null);
  const lastSpokenNoticeRef = useRef<string>('');
  const lastCountdownSpokenRef = useRef<number | null>(null);

  // 단독게임(SOLO) 상태
  const [soloScreen, setSoloScreen] = useState<'SETUP' | 'PLAY'>('SETUP');
  const [soloPlayerCount, setSoloPlayerCount] = useState<number>(3);
  const [soloNames, setSoloNames] = useState<string[]>([
    '개척자 빨강',
    '항해사 파랑',
    '상인 주황',
    '기사 하양',
  ]);
  const [soloAnteBet, setSoloAnteBet] = useState<number>(1000);
  const [soloTargetVP, setSoloTargetVP] = useState<number>(10);
  const [soloTimeoutSec, setSoloTimeoutSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRemainingSec, setSoloRemainingSec] = useState<number>(DEFAULT_TIMEOUT_SEC);
  const [soloRoom, setSoloRoom] = useState<NetCatanRoomData>(() => createDefaultCatanRoom(0));

  // 공용 모달/이펙트 상태
  const [buildMode, setBuildMode] = useState<'NONE' | 'ROAD' | 'SETTLEMENT' | 'CITY'>('NONE');
  const [tradeModalOpen, setTradeModalOpen] = useState<boolean>(false);
  const [tradeGiveRes, setTradeGiveRes] = useState<ResourceType>('wood');
  const [tradeGetRes, setTradeGetRes] = useState<ResourceType>('brick');
  const [tradeTargetPlayerId, setTradeTargetPlayerId] = useState<string>('BANK');

  const [devEffectModal, setDevEffectModal] = useState<{
    type: 'year_of_plenty' | 'monopoly';
    res1: ResourceType;
    res2: ResourceType;
  } | null>(null);

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
    utterance.rate = 1.12;
    utterance.pitch = 1.05;
    window.speechSynthesis.speak(utterance);
  };

  const playSound = (kind: 'dice' | 'build' | 'chip' | 'win' | 'tick' | 'robber') => {
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
        dice: [320, 480, 390, 560],
        build: [261.63, 392.0, 523.25],
        chip: [880, 1174.66],
        win: [523.25, 659.25, 783.99, 1046.5, 1318.5],
        tick: [987.77],
        robber: [196.0, 146.83],
      };

      notesMap[kind].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === 'robber' ? 'sawtooth' : 'triangle';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.055);
        gain.gain.setValueAtTime(0.16, ctx.currentTime + idx * 0.055);
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
    const key = type === 'SOLO' ? 'catan_hof_solo' : 'catan_hof_net';
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
    const key = type === 'SOLO' ? 'catan_hof_solo' : 'catan_hof_net';
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      return [];
    }
  };

  // =========================================================================
  // 카탄 게임 상태 전이 순수 로직 (단독/넷게임 공용)
  // =========================================================================
  const checkVictoryAndSettle = (
    room: NetCatanRoomData,
    modeType: 'SOLO' | 'NET'
  ): boolean => {
    for (const p of room.players) {
      const vp = calculatePlayerVP(
        p,
        room.buildings || {},
        room.longestRoadOwnerId,
        room.largestArmyOwnerId
      );
      if (vp >= room.targetVP) {
        const wonPot = room.pot || 0;
        room.players = room.players.map((pl) => {
          const isWinner = pl.id === p.id;
          const updatedChips = isWinner ? pl.chips + wonPot : pl.chips;
          return {
            ...pl,
            chips: updatedChips,
            wins: isWinner ? (pl.wins || 0) + 1 : pl.wins || 0,
            isEliminated: updatedChips <= 0,
          };
        });
        const winnerObj = room.players.find((pl) => pl.id === p.id)!;
        const anyBusted = room.players.some((pl) => pl.isEliminated);

        room.pot = 0;
        room.turnDeadline = null;
        room.turnNotice = '';
        room.phase = anyBusted ? 'MATCH_OVER' : 'ROUND_OVER';
        room.status = anyBusted ? 'MATCH_OVER' : 'ROUND_OVER';
        room.winnerAnnouncement = anyBusted
          ? `👑 카탄 최종 정복! ${p.name}님이 ${vp}점으로 승리하며 상대 판돈을 모두 소진시켰습니다!`
          : `🎊 ${p.name}님 ${vp}점 달성 승리! 판돈 ${wonPot.toLocaleString()}칩 독식! (${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}칩)`;

        saveHallOfFameRecord(modeType, {
          name: p.name,
          scoreOrLevel: `${vp}VP · ${winnerObj.wins}승 · ${winnerObj.chips.toLocaleString()}칩`,
        });
        return true;
      }
    }
    return false;
  };

  const applySettlementPlacement = (
    room: NetCatanRoomData,
    playerId: string,
    vertexId: number,
    modeType: 'SOLO' | 'NET'
  ): string | null => {
    const actor = room.players[room.currentTurnIdx];
    if (!actor || actor.id !== playerId) return '현재 차례가 아닙니다.';

    const isSetup =
      room.phase === 'SETUP_1_SETTLEMENT' || room.phase === 'SETUP_2_SETTLEMENT';
    if (!isSetup && room.phase !== 'MAIN_TURN') return '지금은 마을을 건설할 수 없습니다.';

    if (!room.buildings) room.buildings = {};
    if (!room.roads) room.roads = {};

    if (!canBuildSettlementAt(vertexId, playerId, room.board, room.buildings, room.roads, isSetup)) {
      return '거리 규칙(인접 교차로 비어있음) 또는 도로 연결 조건이 맞지 않습니다.';
    }

    if (!isSetup) {
      if (!hasEnoughResources(actor.resources, BUILD_COSTS.settlement)) {
        return '자원이 부족합니다. (목재1, 벽돌1, 양모1, 밀1 필요)';
      }
      actor.resources = subtractResources(actor.resources, BUILD_COSTS.settlement);
    }

    room.buildings[String(vertexId)] = {
      ownerId: actor.id,
      color: actor.color,
      type: 'settlement',
    };
    room.lastPlacedVertexId = vertexId;

    // 2차 초기 배치일 경우 인접 지형 자원 즉시 지급
    if (room.phase === 'SETUP_2_SETTLEMENT') {
      const vertex = room.board.vertices[vertexId];
      const gained: string[] = [];
      for (const hexId of vertex.adjacentHexIds) {
        const hex = room.board.hexes[hexId];
        if (hex && hex.terrain !== 'desert') {
          actor.resources[hex.terrain] += 1;
          gained.push(`${RESOURCE_META[hex.terrain].icon}${RESOURCE_META[hex.terrain].label}`);
        }
      }
      room.phase = 'SETUP_2_ROAD';
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `🏡 ${actor.name}님이 2차 마을 건설! 초기 자원(${
        gained.join(', ') || '없음'
      }) 획득! 인접한 변에 도로를 놓으세요.`;
      return null;
    }

    if (room.phase === 'SETUP_1_SETTLEMENT') {
      room.phase = 'SETUP_1_ROAD';
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.turnNotice = `🏡 ${actor.name}님이 1차 마을 건설! 방금 지은 마을에 이어서 도로를 놓으세요.`;
      return null;
    }

    // 최장 교역로 재평가 (상대 마을이 도로를 끊었을 수 있음)
    room.longestRoadOwnerId = evaluateLongestRoadOwner(
      room.players,
      room.longestRoadOwnerId,
      room.board,
      room.roads,
      room.buildings
    );
    room.turnNotice = `🏡 ${actor.name}님이 새 마을을 건설했습니다! (+1 승점)`;
    checkVictoryAndSettle(room, modeType);
    return null;
  };

  const applyRoadPlacement = (
    room: NetCatanRoomData,
    playerId: string,
    edgeId: number,
    modeType: 'SOLO' | 'NET'
  ): string | null => {
    const actor = room.players[room.currentTurnIdx];
    if (!actor || actor.id !== playerId) return '현재 차례가 아닙니다.';

    const isSetupRoad = room.phase === 'SETUP_1_ROAD' || room.phase === 'SETUP_2_ROAD';
    const isFreeCardRoad = room.phase === 'ROAD_BUILDING_CARD';

    if (!isSetupRoad && !isFreeCardRoad && room.phase !== 'MAIN_TURN') {
      return '지금은 도로를 건설할 수 없습니다.';
    }

    if (!room.buildings) room.buildings = {};
    if (!room.roads) room.roads = {};

    const mustTouchVertex = isSetupRoad ? room.lastPlacedVertexId : null;
    if (!canBuildRoadAt(edgeId, playerId, room.board, room.buildings, room.roads, mustTouchVertex)) {
      return '본인의 마을이나 기존 도로와 연결된 변에만 건설할 수 있습니다.';
    }

    if (!isSetupRoad && !isFreeCardRoad) {
      if (!hasEnoughResources(actor.resources, BUILD_COSTS.road)) {
        return '자원이 부족합니다. (목재1, 벽돌1 필요)';
      }
      actor.resources = subtractResources(actor.resources, BUILD_COSTS.road);
    }

    room.roads[String(edgeId)] = {
      ownerId: actor.id,
      color: actor.color,
    };

    room.longestRoadOwnerId = evaluateLongestRoadOwner(
      room.players,
      room.longestRoadOwnerId,
      room.board,
      room.roads,
      room.buildings
    );

    if (isSetupRoad) {
      const order = getSetupOrder(room.players.length);
      const nextStep = room.setupStepIdx + 1;

      if (nextStep < order.length) {
        room.setupStepIdx = nextStep;
        room.currentTurnIdx = order[nextStep];
        const isSecondRound = nextStep >= room.players.length;
        room.phase = isSecondRound ? 'SETUP_2_SETTLEMENT' : 'SETUP_1_SETTLEMENT';
        room.lastPlacedVertexId = null;
        room.turnDeadline = Date.now() + room.baseTimeout * 1000;
        const nextPlayer = room.players[room.currentTurnIdx];
        room.turnNotice = `🧭 [초기 배치 ${nextStep + 1}/${order.length}] ${nextPlayer.name}님 차례! 마을을 배치할 교차로를 클릭하세요.`;
      } else {
        // 초기 배치 완료 -> 1번 플레이어 주사위 굴리기 시작
        room.currentTurnIdx = 0;
        room.phase = 'ROLL_DICE';
        room.lastPlacedVertexId = null;
        room.turnDeadline = Date.now() + room.baseTimeout * 1000;
        room.turnNotice = `🎲 모든 초기 배치가 끝났습니다! ${room.players[0].name}님 주사위를 굴려주세요!`;
      }
      return null;
    }

    if (isFreeCardRoad) {
      const left = (room.freeRoadsRemaining || 1) - 1;
      if (left > 0) {
        room.freeRoadsRemaining = left;
        room.turnNotice = `🛣️ 도로 건설 카드 효과! 무료 도로 1개를 더 배치하세요.`;
      } else {
        room.freeRoadsRemaining = 0;
        room.phase = 'MAIN_TURN';
        room.turnNotice = `🛣️ ${actor.name}님이 도로 2개 무료 건설을 완료했습니다!`;
      }
      checkVictoryAndSettle(room, modeType);
      return null;
    }

    room.turnNotice = `🛣️ ${actor.name}님이 도로를 건설했습니다!`;
    checkVictoryAndSettle(room, modeType);
    return null;
  };

  const applyCityUpgrade = (
    room: NetCatanRoomData,
    playerId: string,
    vertexId: number,
    modeType: 'SOLO' | 'NET'
  ): string | null => {
    const actor = room.players[room.currentTurnIdx];
    if (!actor || actor.id !== playerId) return '현재 차례가 아닙니다.';
    if (room.phase !== 'MAIN_TURN') return '주사위를 굴린 후 본 턴에서만 도시로 업그레이드할 수 있습니다.';

    const slot = room.buildings?.[String(vertexId)];
    if (!slot || slot.ownerId !== playerId || slot.type !== 'settlement') {
      return '본인의 기존 마을을 선택해야 도시로 업그레이드할 수 있습니다.';
    }

    if (!hasEnoughResources(actor.resources, BUILD_COSTS.city)) {
      return '자원이 부족합니다. (밀2, 철광석3 필요)';
    }

    actor.resources = subtractResources(actor.resources, BUILD_COSTS.city);
    slot.type = 'city';
    room.turnNotice = `🏰 ${actor.name}님이 마을을 도시로 업그레이드했습니다! (자원 2배 생산 · +2 승점)`;
    checkVictoryAndSettle(room, modeType);
    return null;
  };

  const applyDiceRoll = (room: NetCatanRoomData, playerId: string) => {
    const actor = room.players[room.currentTurnIdx];
    if (!actor || actor.id !== playerId || room.phase !== 'ROLL_DICE') return;

    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const sum = d1 + d2;
    room.dice = [d1, d2];
    room.turnDeadline = Date.now() + room.baseTimeout * 1000;

    if (sum === 7) {
      // 7이 나오면 7장 초과 보유자 절반 자동 버림 + 도둑 이동 단계
      const discardedLogs: string[] = [];
      for (const p of room.players) {
        const total = getTotalResources(p.resources);
        if (total > 7) {
          const dropCount = Math.floor(total / 2);
          let dropped = 0;
          while (dropped < dropCount) {
            const avail = RESOURCE_KEYS.filter((k) => p.resources[k] > 0);
            if (avail.length === 0) break;
            const pick = avail[Math.floor(Math.random() * avail.length)];
            p.resources[pick] -= 1;
            dropped++;
          }
          discardedLogs.push(`${p.name}(-${dropCount}장)`);
        }
      }

      room.phase = 'ROBBER_MOVE';
      const discardMsg =
        discardedLogs.length > 0 ? ` [7장 초과 반납: ${discardedLogs.join(', ')}]` : '';
      room.turnNotice = `🏴‍☠️ 주사위 7!${discardMsg} ${actor.name}님, 도둑을 이동시킬 육각 타일을 클릭하세요!`;
      return;
    }

    // 해당 숫자 타일 인접 건물에 자원 생산
    const gainsByPlayer: Record<string, string[]> = {};
    for (const hex of room.board.hexes) {
      if (hex.id === room.robberHexId) continue;
      if (hex.numberToken !== sum || hex.terrain === 'desert') continue;

      const resType = hex.terrain;
      for (const vertex of room.board.vertices) {
        if (!vertex.adjacentHexIds.includes(hex.id)) continue;
        const b = room.buildings?.[String(vertex.id)];
        if (!b) continue;

        const targetPlayer = room.players.find((p) => p.id === b.ownerId);
        if (!targetPlayer) continue;

        const amount = b.type === 'city' ? 2 : 1;
        targetPlayer.resources[resType] += amount;

        if (!gainsByPlayer[targetPlayer.name]) gainsByPlayer[targetPlayer.name] = [];
        gainsByPlayer[targetPlayer.name].push(
          `${RESOURCE_META[resType].icon}${RESOURCE_META[resType].label}+${amount}`
        );
      }
    }

    const summary = Object.entries(gainsByPlayer)
      .map(([name, items]) => `${name}(${items.join(' ')})`)
      .join(', ');

    room.phase = 'MAIN_TURN';
    room.turnNotice = summary
      ? `🎲 주사위 [${sum}]! 생산: ${summary} 👉 ${actor.name}님 건설 및 거래 시간!`
      : `🎲 주사위 [${sum}]! 생산된 자원이 없습니다. 👉 ${actor.name}님 건설 및 거래 시간!`;
  };

  const applyRobberMove = (room: NetCatanRoomData, playerId: string, targetHexId: number) => {
    const actor = room.players[room.currentTurnIdx];
    if (!actor || actor.id !== playerId || room.phase !== 'ROBBER_MOVE') return;
    if (targetHexId === room.robberHexId) return;

    room.robberHexId = targetHexId;
    room.phase = 'MAIN_TURN';
    room.turnDeadline = Date.now() + room.baseTimeout * 1000;

    // 도둑 타일에 인접한 상대 플레이어 중 자원 1장 약탈
    const victimIds = new Set<string>();
    for (const v of room.board.vertices) {
      if (!v.adjacentHexIds.includes(targetHexId)) continue;
      const b = room.buildings?.[String(v.id)];
      if (b && b.ownerId !== actor.id) {
        victimIds.add(b.ownerId);
      }
    }

    const victimsWithCards = room.players.filter(
      (p) => victimIds.has(p.id) && getTotalResources(p.resources) > 0
    );

    if (victimsWithCards.length > 0) {
      const victim = victimsWithCards[Math.floor(Math.random() * victimsWithCards.length)];
      const avail = RESOURCE_KEYS.filter((k) => victim.resources[k] > 0);
      const stolenRes = avail[Math.floor(Math.random() * avail.length)];
      victim.resources[stolenRes] -= 1;
      actor.resources[stolenRes] += 1;
      room.turnNotice = `🏴‍☠️ ${actor.name}님이 도둑을 이동시키고 ${victim.name}님에게서 ${RESOURCE_META[stolenRes].icon}${RESOURCE_META[stolenRes].label} 1장을 약탈했습니다!`;
    } else {
      room.turnNotice = `🏴‍☠️ ${actor.name}님이 도둑을 이동시켰습니다! 건설 및 거래를 진행하세요.`;
    }
  };

  const applyBuyDevCard = (
    room: NetCatanRoomData,
    playerId: string,
    modeType: 'SOLO' | 'NET'
  ): string | null => {
    const actor = room.players[room.currentTurnIdx];
    if (!actor || actor.id !== playerId) return '현재 차례가 아닙니다.';
    if (room.phase !== 'MAIN_TURN') return '주사위를 굴린 후 구매할 수 있습니다.';
    if (!room.devDeck || room.devDeck.length === 0) return '남은 발전 카드가 없습니다.';
    if (!hasEnoughResources(actor.resources, BUILD_COSTS.devCard)) {
      return '자원이 부족합니다. (양모1, 밀1, 철광석1 필요)';
    }

    actor.resources = subtractResources(actor.resources, BUILD_COSTS.devCard);
    const drawn = room.devDeck.shift()!;

    if (!actor.newDevCards) actor.newDevCards = [];
    actor.newDevCards.push(drawn);

    room.turnNotice = `📜 ${actor.name}님이 발전 카드를 1장 구매했습니다!`;
    checkVictoryAndSettle(room, modeType);
    return null;
  };

  const applyPlayDevCard = (
    room: NetCatanRoomData,
    playerId: string,
    cardType: DevCardType,
    extra?: { res1?: ResourceType; res2?: ResourceType }
  ): string | null => {
    const actor = room.players[room.currentTurnIdx];
    if (!actor || actor.id !== playerId) return '현재 차례가 아닙니다.';
    if (room.phase !== 'MAIN_TURN' && room.phase !== 'ROLL_DICE') {
      return '지금은 발전 카드를 사용할 수 없습니다.';
    }
    if (cardType === 'victory') return '승점 카드는 자동 반영됩니다.';
    if (actor.devCardPlayedThisTurn) return '한 턴에 발전 카드는 1장만 사용할 수 있습니다.';

    const idx = (actor.devCards || []).indexOf(cardType);
    if (idx === -1) return '사용 가능한 해당 발전 카드가 없습니다. (구매한 턴에는 사용 불가)';

    actor.devCards.splice(idx, 1);
    actor.devCardPlayedThisTurn = true;

    if (cardType === 'knight') {
      actor.knightsPlayed = (actor.knightsPlayed || 0) + 1;
      room.largestArmyOwnerId = evaluateLargestArmyOwner(room.players, room.largestArmyOwnerId);
      room.phase = 'ROBBER_MOVE';
      room.turnNotice = `⚔️ ${actor.name}님이 기사 카드를 발동! (누적 ${actor.knightsPlayed}회) 도둑을 이동시킬 타일을 클릭하세요!`;
      return null;
    }

    if (cardType === 'road_building') {
      room.phase = 'ROAD_BUILDING_CARD';
      room.freeRoadsRemaining = 2;
      room.turnNotice = `🛣️ ${actor.name}님이 도로 건설 카드를 발동! 무료 도로 2개를 배치하세요.`;
      return null;
    }

    if (cardType === 'year_of_plenty' && extra?.res1 && extra?.res2) {
      actor.resources[extra.res1] += 1;
      actor.resources[extra.res2] += 1;
      room.turnNotice = `🌽 ${actor.name}님이 풍년 카드로 ${RESOURCE_META[extra.res1].label}, ${RESOURCE_META[extra.res2].label} 자원을 획득했습니다!`;
      return null;
    }

    if (cardType === 'monopoly' && extra?.res1) {
      const targetRes = extra.res1;
      let totalCollected = 0;
      for (const p of room.players) {
        if (p.id === actor.id) continue;
        const count = p.resources[targetRes];
        if (count > 0) {
          p.resources[targetRes] = 0;
          totalCollected += count;
        }
      }
      actor.resources[targetRes] += totalCollected;
      room.turnNotice = `💰 ${actor.name}님이 [${RESOURCE_META[targetRes].label}] 독점 카드를 발동하여 총 ${totalCollected}장을 회수했습니다!`;
      return null;
    }

    return null;
  };

  const applyEndTurn = (room: NetCatanRoomData, playerId: string) => {
    const actor = room.players[room.currentTurnIdx];
    if (!actor || actor.id !== playerId) return;

    // 이번 턴 구매한 발전 카드를 사용 가능 목록으로 이동
    actor.devCards = [...(actor.devCards || []), ...(actor.newDevCards || [])];
    actor.newDevCards = [];
    actor.devCardPlayedThisTurn = false;

    const nextIdx = (room.currentTurnIdx + 1) % room.players.length;
    room.currentTurnIdx = nextIdx;
    room.phase = 'ROLL_DICE';
    room.freeRoadsRemaining = 0;
    room.turnDeadline = Date.now() + room.baseTimeout * 1000;

    const nextPlayer = room.players[nextIdx];
    room.turnNotice = `👉 ${nextPlayer.name}님 차례입니다! 주사위를 굴려주세요.`;
  };

  // =========================================================================
  // 방 나가기 & 브라우저 종료 감지
  // =========================================================================
  const leaveRoomById = useCallback(
    async (roomIdToLeave: number) => {
      const roomRef = ref(db, `catan_rooms/room_${roomIdToLeave}`);
      try {
        await runTransaction(roomRef, (roomData) => {
          if (!roomData) return roomData;
          const room = roomData as NetCatanRoomData;
          const filteredPlayers = (room.players || []).filter((p) => p.id !== mySessionId);
          const filteredWaitlist = (room.waitlist || []).filter((w) => w.id !== mySessionId);
          const filteredSpectators = (room.spectators || []).filter((s) => s.id !== mySessionId);

          if (filteredPlayers.length === 0 && filteredSpectators.length === 0) {
            return createDefaultCatanRoom(room.roomId);
          }

          room.players = filteredPlayers.map((p, idx) => ({
            ...p,
            color: PLAYER_COLORS[idx % 4],
          }));
          room.waitlist = filteredWaitlist;
          room.spectators = filteredSpectators;

          if (filteredPlayers.length < 2 && room.status === 'PLAYING') {
            room.status = 'WAITING';
            room.turnNotice = '⚠️ 플레이어가 퇴장하여 대기 상태로 전환되었습니다.';
          }
          return room;
        });
      } catch (err) {
        console.error('방 퇴장 오류:', err);
      }
    },
    [mySessionId]
  );

  useEffect(() => {
    if (appMode !== 'NET_ROOM' || !selectedRoomId) return;

    const presenceRef = ref(db, `catan_presence/room_${selectedRoomId}/${mySessionId}`);
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
        const roomRef = ref(db, `catan_rooms/room_${id}`);
        const snap = await get(roomRef);
        if (!snap.exists()) {
          await set(roomRef, createDefaultCatanRoom(id));
        }
      }
    };
    ensureRoomsExist();

    const roomsRef = ref(db, 'catan_rooms');
    const unsubscribe = onValue(roomsRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      const loadedRooms: NetCatanRoomData[] = [1, 2, 3, 4].map((id) => {
        const rData = data[`room_${id}`];
        const def = createDefaultCatanRoom(id);
        if (!rData) return def;

        return {
          ...def,
          ...rData,
          players: (rData.players || []).map((p: CatanPlayer, idx: number) => ({
            ...p,
            color: p.color || PLAYER_COLORS[idx % 4],
            chips: typeof p.chips === 'number' ? p.chips : INITIAL_CHIPS,
            wins: typeof p.wins === 'number' ? p.wins : 0,
            resources: { ...createEmptyHand(), ...(p.resources || {}) },
            devCards: p.devCards || [],
            newDevCards: p.newDevCards || [],
            knightsPlayed: p.knightsPlayed || 0,
            devCardPlayedThisTurn: Boolean(p.devCardPlayedThisTurn),
            isEliminated: Boolean(p.isEliminated),
          })),
          buildings: rData.buildings || {},
          roads: rData.roads || {},
          devDeck: rData.devDeck || [],
          waitlist: rData.waitlist || [],
          spectators: rData.spectators || [],
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

  // 넷게임 안내 음성 및 폭죽 동기화
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

  // 넷게임 타이머
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
          const roomRef = ref(db, `catan_rooms/room_${activeNetRoom.roomId}`);
          await set(roomRef, createDefaultCatanRoom(activeNetRoom.roomId));
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
          await handleNetTurnTimeout(activeNetRoom);
        }
      }
    }, 350);

    return () => window.clearInterval(timer);
  }, [appMode, activeNetRoom]);

  // 단독게임 타이머
  useEffect(() => {
    if (appMode !== 'SOLO' || soloScreen !== 'PLAY' || soloRoom.status !== 'PLAYING') {
      return;
    }

    const timer = window.setInterval(() => {
      setSoloRemainingSec((prev) => {
        const next = Math.max(0, prev - 1);
        handleCountdownCue(next);
        if (next === 0) {
          setSoloRoom((prevRoom) => {
            const copy: NetCatanRoomData = JSON.parse(JSON.stringify(prevRoom));
            autoAdvanceTimeoutTurn(copy, 'SOLO');
            return copy;
          });
          return soloTimeoutSec;
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [appMode, soloScreen, soloRoom.status, soloTimeoutSec]);

  /**
   * 턴 제한시간 초과 시 자동 진행 처리
   */
  const autoAdvanceTimeoutTurn = (room: NetCatanRoomData, modeType: 'SOLO' | 'NET') => {
    const actor = room.players[room.currentTurnIdx];
    if (!actor) return;

    if (room.phase === 'SETUP_1_SETTLEMENT' || room.phase === 'SETUP_2_SETTLEMENT') {
      const validV = room.board.vertices.find((v) =>
        canBuildSettlementAt(v.id, actor.id, room.board, room.buildings || {}, room.roads || {}, true)
      );
      if (validV) {
        applySettlementPlacement(room, actor.id, validV.id, modeType);
      }
      return;
    }

    if (room.phase === 'SETUP_1_ROAD' || room.phase === 'SETUP_2_ROAD') {
      const validE = room.board.edges.find((e) =>
        canBuildRoadAt(
          e.id,
          actor.id,
          room.board,
          room.buildings || {},
          room.roads || {},
          room.lastPlacedVertexId
        )
      );
      if (validE) {
        applyRoadPlacement(room, actor.id, validE.id, modeType);
      }
      return;
    }

    if (room.phase === 'ROLL_DICE') {
      applyDiceRoll(room, actor.id);
    }

    if (room.phase === 'ROBBER_MOVE') {
      const validHex = room.board.hexes.find((h) => h.id !== room.robberHexId);
      if (validHex) applyRobberMove(room, actor.id, validHex.id);
    }

    applyEndTurn(room, actor.id);
    room.turnNotice = `⏰ 시간 초과로 ${actor.name}님의 턴이 자동 종료되었습니다! 👉 ${
      room.players[room.currentTurnIdx].name
    }님 차례!`;
  };

  // =========================================================================
  // 넷게임 액션 핸들러
  // =========================================================================
  const handleEnterRoomSubmit = async (asSpectator = false) => {
    if (!joinModalRoom) return;
    const trimmedName = joinPlayerName.trim();
    if (!trimmedName) {
      alert('참가할 이름을 입력해주세요!');
      return;
    }

    const roomRef = ref(db, `catan_rooms/room_${joinModalRoom.roomId}`);

    try {
      let joinResultType = 'PLAYER';

      await runTransaction(roomRef, (roomData) => {
        const room: NetCatanRoomData = roomData || createDefaultCatanRoom(joinModalRoom.roomId);
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
          const newPlayer: CatanPlayer = {
            id: mySessionId,
            name: trimmedName,
            color: PLAYER_COLORS[room.players.length % 4],
            chips: INITIAL_CHIPS,
            wins: 0,
            resources: createEmptyHand(),
            devCards: [],
            newDevCards: [],
            knightsPlayed: 0,
            devCardPlayedThisTurn: false,
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

      if (joinResultType === 'SPECTATOR') showToast('👀 관전 모드로 입장했습니다!', 'info');
      else if (joinResultType === 'WAITLIST') showToast('⏳ 다음 판 예약자로 등록되었습니다!', 'info');
    } catch (err) {
      console.error(err);
      alert('방 입장 중 오류가 발생했습니다.');
    }
  };

  const updateNetRoomSettings = async (
    newAnteBet: number,
    newTimeout: number,
    newTargetVP: number
  ) => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `catan_rooms/room_${activeNetRoom.roomId}`);
    await update(roomRef, {
      anteBet: newAnteBet,
      baseTimeout: Math.min(180, Math.max(30, newTimeout)),
      targetVP: newTargetVP,
      waitingSince: Date.now(),
    });
  };

  const handleStartNetRound = async (isNextRound = false) => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `catan_rooms/room_${activeNetRoom.roomId}`);

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetCatanRoomData;
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

      const surviving = basePlayers.filter((p) => !p.isEliminated);
      const nextActive = [...surviving];
      const remainingWaitlist: WaitlistPlayer[] = [];

      for (const w of room.waitlist) {
        if (nextActive.length < 4) {
          nextActive.push({
            id: w.id,
            name: w.name,
            color: PLAYER_COLORS[nextActive.length % 4],
            chips: INITIAL_CHIPS,
            wins: 0,
            resources: createEmptyHand(),
            devCards: [],
            newDevCards: [],
            knightsPlayed: 0,
            devCardPlayedThisTurn: false,
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

      const rotated =
        isNextRound && !isNewMatch
          ? [...nextActive.slice(1), nextActive[0]]
          : nextActive;

      const equalStake = Math.min(ante, ...rotated.map((p) => p.chips));
      let totalPot = isNewMatch ? 0 : room.pot || 0;

      const { board, desertHexId } = generateCatanBoard();

      room.players = rotated.map((p, idx) => {
        totalPot += equalStake;
        return {
          ...p,
          color: PLAYER_COLORS[idx % 4],
          chips: p.chips - equalStake,
          resources: createEmptyHand(),
          devCards: [],
          newDevCards: [],
          knightsPlayed: 0,
          devCardPlayedThisTurn: false,
          isEliminated: false,
        };
      });

      room.status = 'PLAYING';
      room.roundNumber = nextRound;
      room.pot = totalPot;
      room.waitlist = remainingWaitlist;
      room.board = board;
      room.robberHexId = desertHexId;
      room.buildings = {};
      room.roads = {};
      room.devDeck = createShuffledDevDeck();
      room.longestRoadOwnerId = null;
      room.largestArmyOwnerId = null;
      room.phase = 'SETUP_1_SETTLEMENT';
      room.currentTurnIdx = 0;
      room.setupStepIdx = 0;
      room.lastPlacedVertexId = null;
      room.freeRoadsRemaining = 0;
      room.turnDeadline = Date.now() + room.baseTimeout * 1000;
      room.winnerAnnouncement = '';
      room.waitingSince = null;
      room.turnNotice = `🏝️ [제 ${nextRound}국 개척 시작] 동일 판돈 ${equalStake.toLocaleString()}칩 베팅! ${room.players[0].name}님 첫 번째 마을을 배치하세요.`;

      return room;
    });

    triggerChipAnimation('전원', activeNetRoom.anteBet, '#6d4c41');
  };

  const handleNetTurnTimeout = async (room: NetCatanRoomData) => {
    const roomRef = ref(db, `catan_rooms/room_${room.roomId}`);
    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const r = roomData as NetCatanRoomData;
      if (r.status !== 'PLAYING') return r;
      autoAdvanceTimeoutTurn(r, 'NET');
      return r;
    });
  };

  const runNetAction = async (
    mutator: (room: NetCatanRoomData) => string | null,
    soundKind?: 'dice' | 'build' | 'robber'
  ) => {
    if (!activeNetRoom) return;
    const roomRef = ref(db, `catan_rooms/room_${activeNetRoom.roomId}`);
    let errorMsg: string | null = null;

    await runTransaction(roomRef, (roomData) => {
      if (!roomData) return roomData;
      const room = roomData as NetCatanRoomData;
      if (!room.buildings) room.buildings = {};
      if (!room.roads) room.roads = {};
      errorMsg = mutator(room);
      return room;
    });

    if (errorMsg) {
      showToast(errorMsg, 'danger');
    } else if (soundKind) {
      playSound(soundKind);
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
  // 단독게임(SOLO) 시작 및 액션 실행
  // =========================================================================
  const startSoloMatch = (isNextRound = false) => {
    const isFresh = !isNextRound || soloRoom.status === 'MATCH_OVER';
    const nextRound = isFresh ? 1 : soloRoom.roundNumber + 1;
    const { board, desertHexId } = generateCatanBoard();

    const basePlayers: CatanPlayer[] = isFresh
      ? Array.from({ length: soloPlayerCount }, (_, idx) => ({
          id: `solo_${idx + 1}`,
          name: soloNames[idx]?.trim() || `개척자 ${idx + 1}`,
          color: PLAYER_COLORS[idx % 4],
          chips: INITIAL_CHIPS,
          wins: 0,
          resources: createEmptyHand(),
          devCards: [],
          newDevCards: [],
          knightsPlayed: 0,
          devCardPlayedThisTurn: false,
          isEliminated: false,
        }))
      : [...soloRoom.players.slice(1), soloRoom.players[0]];

    const equalStake = Math.min(soloAnteBet, ...basePlayers.map((p) => p.chips));
    let totalPot = isFresh ? 0 : soloRoom.pot;

    const preparedPlayers = basePlayers.map((p, idx) => {
      totalPot += equalStake;
      return {
        ...p,
        color: PLAYER_COLORS[idx % 4],
        chips: p.chips - equalStake,
        resources: createEmptyHand(),
        devCards: [],
        newDevCards: [],
        knightsPlayed: 0,
        devCardPlayedThisTurn: false,
        isEliminated: false,
      };
    });

    const notice = `🏝️ [제 ${nextRound}국 개척 시작] 동일 판돈 ${equalStake.toLocaleString()}칩 베팅! ${preparedPlayers[0].name}님 첫 번째 마을을 배치하세요.`;

    setSoloRoom({
      roomId: 0,
      status: 'PLAYING',
      players: preparedPlayers,
      pot: totalPot,
      waitlist: [],
      spectators: [],
      baseTimeout: soloTimeoutSec,
      anteBet: soloAnteBet,
      targetVP: soloTargetVP,
      roundNumber: nextRound,
      phase: 'SETUP_1_SETTLEMENT',
      currentTurnIdx: 0,
      setupStepIdx: 0,
      lastPlacedVertexId: null,
      freeRoadsRemaining: 0,
      dice: [3, 4],
      robberHexId: desertHexId,
      longestRoadOwnerId: null,
      largestArmyOwnerId: null,
      board,
      buildings: {},
      roads: {},
      devDeck: createShuffledDevDeck(),
      turnDeadline: Date.now() + soloTimeoutSec * 1000,
      turnNotice: notice,
      winnerAnnouncement: '',
      waitingSince: null,
    });

    setSoloRemainingSec(soloTimeoutSec);
    setBuildMode('NONE');
    setShowFireworks(false);
    triggerChipAnimation('전원', equalStake, '#6d4c41');
    speakKorean(notice);
    setSoloScreen('PLAY');
  };

  const runSoloAction = (
    mutator: (room: NetCatanRoomData) => string | null,
    soundKind?: 'dice' | 'build' | 'robber'
  ) => {
    const copy: NetCatanRoomData = JSON.parse(JSON.stringify(soloRoom));
    const err = mutator(copy);
    if (err) {
      showToast(err, 'danger');
      return;
    }
    if (soundKind) playSound(soundKind);

    if (copy.status === 'ROUND_OVER' || copy.status === 'MATCH_OVER') {
      triggerFireworksCelebration(copy.winnerAnnouncement);
    } else if (copy.turnNotice !== soloRoom.turnNotice) {
      speakKorean(copy.turnNotice);
    }

    setSoloRoom(copy);
  };

  // =========================================================================
  // 공용 보드 인터랙션 핸들러 (단독 / 넷게임 통합)
  // =========================================================================
  const handleBoardHexClick = (hexId: number, room: NetCatanRoomData, isSolo: boolean) => {
    const actor = room.players[room.currentTurnIdx];
    if (!actor) return;
    if (!isSolo && actor.id !== mySessionId) return;

    if (room.phase === 'ROBBER_MOVE') {
      if (hexId === room.robberHexId) {
        showToast('현재 도둑이 있는 곳과 다른 타일을 선택하세요!', 'danger');
        return;
      }
      if (isSolo) {
        runSoloAction((r) => {
          applyRobberMove(r, actor.id, hexId);
          return null;
        }, 'robber');
      } else {
        void runNetAction((r) => {
          applyRobberMove(r, mySessionId, hexId);
          return null;
        }, 'robber');
      }
    }
  };

  const handleBoardVertexClick = (vertexId: number, room: NetCatanRoomData, isSolo: boolean) => {
    const actor = room.players[room.currentTurnIdx];
    if (!actor) return;
    if (!isSolo && actor.id !== mySessionId) return;

    const isSetupSettlement =
      room.phase === 'SETUP_1_SETTLEMENT' || room.phase === 'SETUP_2_SETTLEMENT';

    if (isSetupSettlement || (room.phase === 'MAIN_TURN' && buildMode === 'SETTLEMENT')) {
      if (isSolo) {
        runSoloAction((r) => applySettlementPlacement(r, actor.id, vertexId, 'SOLO'), 'build');
      } else {
        void runNetAction((r) => applySettlementPlacement(r, mySessionId, vertexId, 'NET'), 'build');
      }
      setBuildMode('NONE');
      return;
    }

    if (room.phase === 'MAIN_TURN' && buildMode === 'CITY') {
      if (isSolo) {
        runSoloAction((r) => applyCityUpgrade(r, actor.id, vertexId, 'SOLO'), 'build');
      } else {
        void runNetAction((r) => applyCityUpgrade(r, mySessionId, vertexId, 'NET'), 'build');
      }
      setBuildMode('NONE');
    }
  };

  const handleBoardEdgeClick = (edgeId: number, room: NetCatanRoomData, isSolo: boolean) => {
    const actor = room.players[room.currentTurnIdx];
    if (!actor) return;
    if (!isSolo && actor.id !== mySessionId) return;

    const isSetupRoad = room.phase === 'SETUP_1_ROAD' || room.phase === 'SETUP_2_ROAD';
    const isCardRoad = room.phase === 'ROAD_BUILDING_CARD';

    if (isSetupRoad || isCardRoad || (room.phase === 'MAIN_TURN' && buildMode === 'ROAD')) {
      if (isSolo) {
        runSoloAction((r) => applyRoadPlacement(r, actor.id, edgeId, 'SOLO'), 'build');
      } else {
        void runNetAction((r) => applyRoadPlacement(r, mySessionId, edgeId, 'NET'), 'build');
      }
      if (!isCardRoad) setBuildMode('NONE');
    }
  };

  const handleExecuteTrade = (room: NetCatanRoomData, isSolo: boolean) => {
    const actor = room.players[room.currentTurnIdx];
    if (!actor || room.phase !== 'MAIN_TURN') return;
    if (tradeGiveRes === tradeGetRes) {
      showToast('서로 다른 자원을 선택해주세요!', 'danger');
      return;
    }

    const doTrade = (r: NetCatanRoomData): string | null => {
      const me = r.players[r.currentTurnIdx];
      if (!me) return '차례 오류';

      if (tradeTargetPlayerId === 'BANK') {
        if (me.resources[tradeGiveRes] < 4) {
          return `해상 무역은 같은 자원 4장이 필요합니다! (${RESOURCE_META[tradeGiveRes].label} 부족)`;
        }
        me.resources[tradeGiveRes] -= 4;
        me.resources[tradeGetRes] += 1;
        r.turnNotice = `⛵ ${me.name}님이 해상 무역(4:1)으로 ${RESOURCE_META[tradeGiveRes].label} 4장을 내고 ${RESOURCE_META[tradeGetRes].label} 1장을 얻었습니다!`;
        return null;
      }

      const partner = r.players.find((p) => p.id === tradeTargetPlayerId);
      if (!partner) return '거래 상대를 찾을 수 없습니다.';
      if (me.resources[tradeGiveRes] < 1) {
        return `제공할 ${RESOURCE_META[tradeGiveRes].label} 자원이 부족합니다.`;
      }
      if (partner.resources[tradeGetRes] < 1) {
        return `${partner.name}님에게 ${RESOURCE_META[tradeGetRes].label} 자원이 없습니다.`;
      }

      me.resources[tradeGiveRes] -= 1;
      me.resources[tradeGetRes] += 1;
      partner.resources[tradeGetRes] -= 1;
      partner.resources[tradeGiveRes] += 1;
      r.turnNotice = `🤝 ${me.name}님과 ${partner.name}님이 ${RESOURCE_META[tradeGiveRes].label} ↔ ${RESOURCE_META[tradeGetRes].label} 1:1 교환을 완료했습니다!`;
      return null;
    };

    if (isSolo) runSoloAction(doTrade, 'build');
    else void runNetAction(doTrade, 'build');
    setTradeModalOpen(false);
  };

  // =========================================================================
  // SVG 육각 카탄 섬 보드 렌더링
  // =========================================================================
  const renderCatanSvgBoard = (
    room: NetCatanRoomData,
    canInteract: boolean,
    isSolo: boolean
  ) => {
    const actor = room.players[room.currentTurnIdx];
    const actorId = actor?.id ?? '';

    const showSettlementSpots =
      canInteract &&
      (room.phase === 'SETUP_1_SETTLEMENT' ||
        room.phase === 'SETUP_2_SETTLEMENT' ||
        (room.phase === 'MAIN_TURN' && buildMode === 'SETTLEMENT'));

    const showCitySpots =
      canInteract && room.phase === 'MAIN_TURN' && buildMode === 'CITY';

    const showRoadSpots =
      canInteract &&
      (room.phase === 'SETUP_1_ROAD' ||
        room.phase === 'SETUP_2_ROAD' ||
        room.phase === 'ROAD_BUILDING_CARD' ||
        (room.phase === 'MAIN_TURN' && buildMode === 'ROAD'));

    const showRobberTargets = canInteract && room.phase === 'ROBBER_MOVE';

    return (
      <div className="catan-island-frame">
        <svg viewBox="-290 -265 580 530" className="catan-board-svg">
          <defs>
            <radialGradient id="oceanGrad" cx="50%" cy="50%" r="55%">
              <stop offset="0%" stopColor="#29b6f6" />
              <stop offset="65%" stopColor="#0288d1" />
              <stop offset="100%" stopColor="#01579b" />
            </radialGradient>
          </defs>

          {/* 외곽 해안 테두리 */}
          <circle
            cx="0"
            cy="0"
            r="258"
            fill="url(#oceanGrad)"
            stroke="#e6c994"
            strokeWidth="8"
          />

          {/* 1. 19개 육각 지형 타일 */}
          {room.board.hexes.map((hex) => {
            const meta = TERRAIN_META[hex.terrain];
            const points = Array.from({ length: 6 }, (_, i) => {
              const rad = ((60 * i - 30) * Math.PI) / 180;
              return `${hex.cx + (HEX_RADIUS - 1.5) * Math.cos(rad)},${
                hex.cy + (HEX_RADIUS - 1.5) * Math.sin(rad)
              }`;
            }).join(' ');

            const isRobberHere = room.robberHexId === hex.id;
            const isRobberCandidate = showRobberTargets && !isRobberHere;
            const isHighProb = hex.numberToken === 6 || hex.numberToken === 8;

            return (
              <g
                key={hex.id}
                className={isRobberCandidate ? 'svg-clickable-target' : ''}
                onClick={() => isRobberCandidate && handleBoardHexClick(hex.id, room, isSolo)}
              >
                <polygon
                  points={points}
                  fill={meta.fill}
                  stroke={isRobberCandidate ? '#fde047' : '#f3e5ab'}
                  strokeWidth={isRobberCandidate ? 3.5 : 2.5}
                />

                {/* 지형 이모지 & 이름 */}
                <text
                  x={hex.cx}
                  y={hex.cy - 14}
                  textAnchor="middle"
                  fontSize="18"
                  pointerEvents="none"
                >
                  {meta.icon}
                </text>
                <text
                  x={hex.cx}
                  y={hex.cy + 30}
                  textAnchor="middle"
                  fontSize="9.5"
                  fontWeight="800"
                  fill="#fffdf9"
                  stroke="rgba(0,0,0,0.55)"
                  strokeWidth="2.2"
                  paintOrder="stroke"
                  pointerEvents="none"
                >
                  {meta.label}
                </text>

                {/* 숫자 토큰 (2~12) */}
                {hex.numberToken !== null && (
                  <g pointerEvents="none">
                    <circle
                      cx={hex.cx}
                      cy={hex.cy + 8}
                      r="14.5"
                      fill="#fffdf7"
                      stroke="#5d4037"
                      strokeWidth="1.8"
                    />
                    <text
                      x={hex.cx}
                      y={hex.cy + 13}
                      textAnchor="middle"
                      fontSize="14"
                      fontWeight="900"
                      fill={isHighProb ? '#d32f2f' : '#2c1810'}
                    >
                      {hex.numberToken}
                    </text>
                  </g>
                )}

                {/* 도둑 말 */}
                {isRobberHere && (
                  <g pointerEvents="none">
                    <circle
                      cx={hex.cx + 18}
                      cy={hex.cy - 10}
                      r="12"
                      fill="#212121"
                      stroke="#fde047"
                      strokeWidth="2"
                    />
                    <text
                      x={hex.cx + 18}
                      y={hex.cy - 5}
                      textAnchor="middle"
                      fontSize="13"
                    >
                      🏴‍☠️
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* 2. 72개 변 (도로 및 도로 건설 후보) */}
          {room.board.edges.map((edge) => {
            const roadSlot = room.roads?.[String(edge.id)];
            const isSetupRoad =
              room.phase === 'SETUP_1_ROAD' || room.phase === 'SETUP_2_ROAD';
            const canBuildHere =
              showRoadSpots &&
              canBuildRoadAt(
                edge.id,
                actorId,
                room.board,
                room.buildings || {},
                room.roads || {},
                isSetupRoad ? room.lastPlacedVertexId : null
              );

            if (!roadSlot && !canBuildHere) return null;

            return (
              <g
                key={edge.id}
                className={canBuildHere ? 'svg-clickable-target' : ''}
                onClick={() => canBuildHere && handleBoardEdgeClick(edge.id, room, isSolo)}
              >
                {roadSlot ? (
                  <>
                    <line
                      x1={edge.x1}
                      y1={edge.y1}
                      x2={edge.x2}
                      y2={edge.y2}
                      stroke="#2c1810"
                      strokeWidth="9"
                      strokeLinecap="round"
                    />
                    <line
                      x1={edge.x1}
                      y1={edge.y1}
                      x2={edge.x2}
                      y2={edge.y2}
                      stroke={PLAYER_COLOR_META[roadSlot.color].hex}
                      strokeWidth="5.5"
                      strokeLinecap="round"
                    />
                  </>
                ) : (
                  <line
                    x1={edge.x1}
                    y1={edge.y1}
                    x2={edge.x2}
                    y2={edge.y2}
                    stroke="#fde047"
                    strokeWidth="7"
                    strokeDasharray="4 4"
                    strokeLinecap="round"
                    opacity="0.88"
                  />
                )}
              </g>
            );
          })}

          {/* 3. 54개 꼭짓점 (마을, 도시 및 건설 후보) */}
          {room.board.vertices.map((vertex) => {
            const building = room.buildings?.[String(vertex.id)];
            const isSetupSettlement =
              room.phase === 'SETUP_1_SETTLEMENT' || room.phase === 'SETUP_2_SETTLEMENT';

            const canPlaceSettlement =
              showSettlementSpots &&
              canBuildSettlementAt(
                vertex.id,
                actorId,
                room.board,
                room.buildings || {},
                room.roads || {},
                isSetupSettlement
              );

            const canUpgradeCity =
              showCitySpots &&
              building?.ownerId === actorId &&
              building?.type === 'settlement';

            const isClickable = canPlaceSettlement || canUpgradeCity;

            if (!building && !canPlaceSettlement) return null;

            return (
              <g
                key={vertex.id}
                className={isClickable ? 'svg-clickable-target' : ''}
                onClick={() => isClickable && handleBoardVertexClick(vertex.id, room, isSolo)}
              >
                {building ? (
                  building.type === 'settlement' ? (
                    <g>
                      <polygon
                        points={`${vertex.x},${vertex.y - 12} ${vertex.x + 10},${
                          vertex.y - 3
                        } ${vertex.x + 10},${vertex.y + 9} ${vertex.x - 10},${
                          vertex.y + 9
                        } ${vertex.x - 10},${vertex.y - 3}`}
                        fill={PLAYER_COLOR_META[building.color].hex}
                        stroke={canUpgradeCity ? '#fde047' : '#2c1810'}
                        strokeWidth={canUpgradeCity ? 3.5 : 2}
                      />
                    </g>
                  ) : (
                    <g>
                      <rect
                        x={vertex.x - 12}
                        y={vertex.y - 12}
                        width="24"
                        height="24"
                        rx="4"
                        fill={PLAYER_COLOR_META[building.color].hex}
                        stroke="#fde047"
                        strokeWidth="2.5"
                      />
                      <text
                        x={vertex.x}
                        y={vertex.y + 5}
                        textAnchor="middle"
                        fontSize="13"
                        pointerEvents="none"
                      >
                        🏰
                      </text>
                    </g>
                  )
                ) : (
                  <circle
                    cx={vertex.x}
                    cy={vertex.y}
                    r="8.5"
                    fill="rgba(253, 224, 71, 0.85)"
                    stroke="#4e342e"
                    strokeWidth="2"
                  />
                )}
              </g>
            );
          })}
        </svg>
      </div>
    );
  };

  // =========================================================================
  // 공용 플레이 화면 렌더링 (단독 / 넷게임 통합 UI)
  // =========================================================================
  const renderCatanPlayScreen = (room: NetCatanRoomData, isSolo: boolean) => {
    const players = room.players || [];
    const activePlayer = players[room.currentTurnIdx] || players[0];
    const me = isSolo
      ? activePlayer
      : players.find((p) => p.id === mySessionId) || activePlayer;

    const amISpectator =
      !isSolo && (room.spectators || []).some((s) => s.id === mySessionId);
    const amIWaitlisted =
      !isSolo && (room.waitlist || []).some((w) => w.id === mySessionId);

    const isMyTurn =
      room.status === 'PLAYING' &&
      !amISpectator &&
      (isSolo || activePlayer?.id === mySessionId);

    const isRoundEnded = room.status === 'ROUND_OVER' || room.status === 'MATCH_OVER';
    const timeLeft = isSolo ? soloRemainingSec : remainingSeconds;

    return (
      <div className="catan-container" style={{ background: WOOD_BG_THEMES[0] }}>
        {/* 칩 베팅 날아오기 이펙트 */}
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

        {/* 승자 폭죽 */}
        {showFireworks && (
          <div className="fireworks-overlay" aria-hidden="true">
            <div className="firework-burst fb-1" />
            <div className="firework-burst fb-2" />
            <div className="firework-burst fb-3" />
            <div className="firework-burst fb-4" />
            <div className="firework-burst fb-5" />
          </div>
        )}

        {/* 토스트 알림 */}
        {toast && (
          <div key={toast.id} className={`catan-toast ${toast.type}`}>
            {toast.text}
          </div>
        )}

        <div className="play-wrapper compact-tablet-mode">
          {/* 상단 헤더: 라운드/목표점수/타이머 + 플레이어 상태바 */}
          <div className="game-header compact-header">
            <div className="net-level-timer-box">
              <span className="net-level-badge">
                제{room.roundNumber}국 · 목표 {room.targetVP}점
              </span>
              {!isRoundEnded && (
                <span className={`net-timer-badge ${timeLeft <= 10 ? 'urgent' : ''}`}>
                  ⏱️ {timeLeft}초
                </span>
              )}
            </div>

            <div className="player-status-bar">
              {players.map((p, idx) => {
                const isActive = !isRoundEnded && idx === room.currentTurnIdx;
                const vp = calculatePlayerVP(
                  p,
                  room.buildings || {},
                  room.longestRoadOwnerId,
                  room.largestArmyOwnerId
                );
                const cardCount = getTotalResources(p.resources);
                const cMeta = PLAYER_COLOR_META[p.color];

                return (
                  <div
                    key={p.id}
                    className={`player-badge-card ${isActive ? 'active-turn-spotlight' : ''}`}
                  >
                    <div className="player-badge-top">
                      <span
                        className="catan-color-dot"
                        style={{ backgroundColor: cMeta.hex }}
                      />
                      <strong className={isActive ? 'turn-hero-name' : ''}>
                        {isActive && '>'}
                        {p.name}
                      </strong>
                      <span className="vp-score-pill">⭐{vp}점</span>
                      <span className="card-count-pill">🃏{cardCount}</span>
                      {room.longestRoadOwnerId === p.id && (
                        <span className="special-badge" title="최장 교역로 (+2점)">
                          🛣️
                        </span>
                      )}
                      {room.largestArmyOwnerId === p.id && (
                        <span className="special-badge" title="최강 기사단 (+2점)">
                          ⚔️
                        </span>
                      )}
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
              onClick={() => {
                if (isSolo) setSoloScreen('SETUP');
                else void handleLeaveNetRoom();
              }}
              title="나가기"
            >
              🚪
            </button>
          </div>

          {(amIWaitlisted || (room.waitlist || []).length > 0) && !isSolo && !amISpectator && (
            <div className="net-waitlist-strip">
              {amIWaitlisted
                ? '⏳ 현재 다음 판 예약 대기 중입니다!'
                : `⏳ 다음 판 예약자 (${room.waitlist.length}명): ${room.waitlist
                    .map((w) => w.name)
                    .join(', ')}`}
            </div>
          )}

          {/* 중앙 카탄 보드 테이블 */}
          <div className="catan-table-board">
            {isRoundEnded ? (
              <div className="winner-celebration-top-bar">
                <div className="winner-celebrate-title">{room.winnerAnnouncement}</div>
                <div className="winner-celebrate-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ padding: '6px 14px', fontSize: '13px' }}
                    onClick={() => {
                      if (isSolo) setSoloScreen('SETUP');
                      else void handleLeaveNetRoom();
                    }}
                  >
                    🚪 나가기
                  </button>
                  <button
                    type="button"
                    className="btn btn-success"
                    style={{ width: 'auto', padding: '6px 18px', fontSize: '14px' }}
                    onClick={() => {
                      if (isSolo) startSoloMatch(room.status === 'ROUND_OVER');
                      else void handleStartNetRound(room.status === 'ROUND_OVER');
                    }}
                  >
                    {room.status === 'MATCH_OVER'
                      ? '🔄 새 매치 시작 (10,000칩 초기화)'
                      : `🔥 다음 개척 시작 (${room.anteBet.toLocaleString()}칩)`}
                  </button>
                </div>
              </div>
            ) : (
              <div key={room.turnNotice} className="catan-notice-banner">
                {room.turnNotice}
              </div>
            )}

            {/* 상단 상태 스트립: 주사위 + 누적 POT + 건설 비용 요약 */}
            <div className="catan-top-strip">
              <div className="dice-display-box">
                <span className="die-face">{room.dice[0]}</span>
                <span className="die-face">{room.dice[1]}</span>
                <strong className="dice-sum">합 {room.dice[0] + room.dice[1]}</strong>
              </div>

              <div className="center-pot-box">
                <span className="pot-label">💰 누적 POT</span>
                <strong className="pot-amount">{(room.pot || 0).toLocaleString()} 칩</strong>
              </div>

              <div className="cost-guide-mini" title="건설 비용">
                <span>🛣️🌲🧱</span>
                <span>🏡🌲🧱🐑🌾</span>
                <span>🏰🌾2⛰️3</span>
                <span>📜🐑🌾⛰️</span>
              </div>
            </div>

            {/* 육각 섬 보드 */}
            <div className="board-center-stage">
              {renderCatanSvgBoard(room, isMyTurn, isSolo)}
            </div>
          </div>

          {/* 하단 조작 도크: 내 보유 자원 + 발전 카드 + 건설/무역/턴종료 버튼 */}
          <div className="catan-bottom-dock">
            {amISpectator ? (
              <div className="waiting-dock-msg">👀 관전 모드로 개척 대결을 지켜보고 있습니다.</div>
            ) : isRoundEnded ? (
              <div className="waiting-dock-msg">
                🎉 개척 종료! 상단의 <strong>[다음 개척 시작]</strong> 버튼을 눌러 승수와 판돈을
                이어가세요!
              </div>
            ) : (
              <>
                {/* 보유 자원 & 발전 카드 현황 */}
                <div className="my-hand-bar">
                  <div className="my-owner-tag">
                    <span
                      className="catan-color-dot"
                      style={{ backgroundColor: PLAYER_COLOR_META[me.color].hex }}
                    />
                    <strong>{me.name}</strong>
                  </div>

                  <div className="resource-pills-row">
                    {RESOURCE_KEYS.map((resKey) => {
                      const rMeta = RESOURCE_META[resKey];
                      return (
                        <span
                          key={resKey}
                          className="res-pill"
                          style={{ backgroundColor: rMeta.badgeBg, color: rMeta.textColor }}
                        >
                          {rMeta.icon} {rMeta.label} <strong>{me.resources[resKey]}</strong>
                        </span>
                      );
                    })}
                  </div>

                  {/* 사용 가능한 발전 카드 목록 */}
                  {(me.devCards.length > 0 || me.newDevCards.length > 0) && (
                    <div className="dev-cards-row">
                      {me.devCards.map((card, i) => (
                        <button
                          key={`${card}_${i}`}
                          type="button"
                          disabled={!isMyTurn || card === 'victory'}
                          className="dev-card-chip"
                          title={DEV_CARD_META[card].desc}
                          onClick={() => {
                            if (card === 'year_of_plenty' || card === 'monopoly') {
                              setDevEffectModal({ type: card, res1: 'wood', res2: 'brick' });
                            } else if (isSolo) {
                              runSoloAction(
                                (r) => applyPlayDevCard(r, me.id, card),
                                card === 'knight' ? 'robber' : 'build'
                              );
                            } else {
                              void runNetAction(
                                (r) => applyPlayDevCard(r, mySessionId, card),
                                card === 'knight' ? 'robber' : 'build'
                              );
                            }
                          }}
                        >
                          {DEV_CARD_META[card].icon} {DEV_CARD_META[card].label}
                        </button>
                      ))}
                      {me.newDevCards.map((card, i) => (
                        <span
                          key={`new_${card}_${i}`}
                          className="dev-card-chip locked"
                          title="다음 턴부터 사용 가능"
                        >
                          🔒 {DEV_CARD_META[card].label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* 행동 버튼 바 */}
                <div className="action-buttons-bar">
                  {!isMyTurn ? (
                    <span className="waiting-dock-msg">
                      ⏳ <strong>{activePlayer?.name}</strong>님이 개척 행동을 진행 중입니다...
                    </span>
                  ) : room.phase === 'ROLL_DICE' ? (
                    <button
                      type="button"
                      className="btn btn-success"
                      style={{ width: 'auto', padding: '8px 24px' }}
                      onClick={() => {
                        if (isSolo) {
                          runSoloAction((r) => {
                            applyDiceRoll(r, me.id);
                            return null;
                          }, 'dice');
                        } else {
                          void runNetAction((r) => {
                            applyDiceRoll(r, mySessionId);
                            return null;
                          }, 'dice');
                        }
                      }}
                    >
                      🎲 주사위 굴리기
                    </button>
                  ) : room.phase === 'MAIN_TURN' ? (
                    <>
                      <button
                        type="button"
                        className={`btn action-btn ${buildMode === 'ROAD' ? 'selected' : ''}`}
                        onClick={() => setBuildMode((m) => (m === 'ROAD' ? 'NONE' : 'ROAD'))}
                      >
                        🛣️ 도로
                      </button>
                      <button
                        type="button"
                        className={`btn action-btn ${
                          buildMode === 'SETTLEMENT' ? 'selected' : ''
                        }`}
                        onClick={() =>
                          setBuildMode((m) => (m === 'SETTLEMENT' ? 'NONE' : 'SETTLEMENT'))
                        }
                      >
                        🏡 마을
                      </button>
                      <button
                        type="button"
                        className={`btn action-btn ${buildMode === 'CITY' ? 'selected' : ''}`}
                        onClick={() => setBuildMode((m) => (m === 'CITY' ? 'NONE' : 'CITY'))}
                      >
                        🏰 도시
                      </button>
                      <button
                        type="button"
                        className="btn action-btn"
                        onClick={() => {
                          if (isSolo) {
                            runSoloAction((r) => applyBuyDevCard(r, me.id, 'SOLO'), 'build');
                          } else {
                            void runNetAction(
                              (r) => applyBuyDevCard(r, mySessionId, 'NET'),
                              'build'
                            );
                          }
                        }}
                      >
                        📜 발전카드 ({room.devDeck.length})
                      </button>
                      <button
                        type="button"
                        className="btn action-btn"
                        onClick={() => {
                          setTradeTargetPlayerId('BANK');
                          setTradeModalOpen(true);
                        }}
                      >
                        ⛵ 무역/교환
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => {
                          setBuildMode('NONE');
                          if (isSolo) {
                            runSoloAction((r) => {
                              applyEndTurn(r, me.id);
                              return null;
                            });
                            setSoloRemainingSec(soloTimeoutSec);
                          } else {
                            void runNetAction((r) => {
                              applyEndTurn(r, mySessionId);
                              return null;
                            });
                          }
                        }}
                      >
                        ⏭️ 턴 종료
                      </button>
                    </>
                  ) : (
                    <span className="turn-owner-pill large-turn-pill">
                      👆 위 육각 보드에서 노란색으로 표시된 위치를 클릭하세요!
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* 무역 / 교환 모달 */}
        {tradeModalOpen && (
          <div className="modal-overlay" onClick={() => setTradeModalOpen(false)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: '0 0 10px' }}>⛵ 자원 무역 및 플레이어 교환</h3>
              <p className="modal-subtext">
                은행 해상 무역은 <strong>4:1</strong>, 다른 플레이어와는 <strong>1:1</strong>로
                교환합니다.
              </p>

              <div className="setting-section" style={{ textAlign: 'left' }}>
                <label className="setting-label">거래 대상 선택</label>
                <select
                  className="player-input"
                  style={{ width: '100%' }}
                  value={tradeTargetPlayerId}
                  onChange={(e) => setTradeTargetPlayerId(e.target.value)}
                >
                  <option value="BANK">⛵ 은행 해상 무역 (내 자원 4장 → 원하는 자원 1장)</option>
                  {players
                    .filter((p) => p.id !== me.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        🤝 {p.name}님과 1:1 교환 (보유 {getTotalResources(p.resources)}장)
                      </option>
                    ))}
                </select>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="setting-section">
                  <label className="setting-label">
                    내가 줄 자원 ({tradeTargetPlayerId === 'BANK' ? '4장' : '1장'})
                  </label>
                  <select
                    className="player-input"
                    style={{ width: '100%' }}
                    value={tradeGiveRes}
                    onChange={(e) => setTradeGiveRes(e.target.value as ResourceType)}
                  >
                    {RESOURCE_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {RESOURCE_META[k].icon} {RESOURCE_META[k].label} (보유: {me.resources[k]})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="setting-section">
                  <label className="setting-label">받을 자원 (1장)</label>
                  <select
                    className="player-input"
                    style={{ width: '100%' }}
                    value={tradeGetRes}
                    onChange={(e) => setTradeGetRes(e.target.value as ResourceType)}
                  >
                    {RESOURCE_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {RESOURCE_META[k].icon} {RESOURCE_META[k].label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ flex: 1 }}
                  onClick={() => setTradeModalOpen(false)}
                >
                  취소
                </button>
                <button
                  type="button"
                  className="btn btn-success"
                  style={{ flex: 2 }}
                  onClick={() => handleExecuteTrade(room, isSolo)}
                >
                  ✅ 교환 실행
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 풍년 / 독점 발전 카드 자원 선택 모달 */}
        {devEffectModal && (
          <div className="modal-overlay" onClick={() => setDevEffectModal(null)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: '0 0 10px' }}>
                {DEV_CARD_META[devEffectModal.type].icon}{' '}
                {DEV_CARD_META[devEffectModal.type].label} 카드 발동
              </h3>
              <p className="modal-subtext">{DEV_CARD_META[devEffectModal.type].desc}</p>

              <div className="setting-section">
                <label className="setting-label">첫 번째 선택 자원</label>
                <select
                  className="player-input"
                  style={{ width: '100%' }}
                  value={devEffectModal.res1}
                  onChange={(e) =>
                    setDevEffectModal({
                      ...devEffectModal,
                      res1: e.target.value as ResourceType,
                    })
                  }
                >
                  {RESOURCE_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {RESOURCE_META[k].icon} {RESOURCE_META[k].label}
                    </option>
                  ))}
                </select>
              </div>

              {devEffectModal.type === 'year_of_plenty' && (
                <div className="setting-section">
                  <label className="setting-label">두 번째 선택 자원</label>
                  <select
                    className="player-input"
                    style={{ width: '100%' }}
                    value={devEffectModal.res2}
                    onChange={(e) =>
                      setDevEffectModal({
                        ...devEffectModal,
                        res2: e.target.value as ResourceType,
                      })
                    }
                  >
                    {RESOURCE_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {RESOURCE_META[k].icon} {RESOURCE_META[k].label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <button
                type="button"
                className="btn btn-success"
                onClick={() => {
                  const payload = {
                    res1: devEffectModal.res1,
                    res2: devEffectModal.res2,
                  };
                  if (isSolo) {
                    runSoloAction(
                      (r) => applyPlayDevCard(r, me.id, devEffectModal.type, payload),
                      'build'
                    );
                  } else {
                    void runNetAction(
                      (r) => applyPlayDevCard(r, mySessionId, devEffectModal.type, payload),
                      'build'
                    );
                  }
                  setDevEffectModal(null);
                }}
              >
                ✨ 효과 적용하기
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  // =========================================================================
  // 1. 홈 화면 (HOME)
  // =========================================================================
  if (appMode === 'HOME') {
    return (
      <div className="catan-container" style={{ background: WOOD_BG_THEMES[0] }}>
        <div className="setup-card home-entry-card">
          <div className="home-castle-icon">🏝️🏡⛵</div>
          <h1 className="setup-title">카탄의 개척자 (CATAN)</h1>
          <p className="home-subtitle">
            자원 생산과 무역 · 도로와 도시 건설 · 목표 승점 달성 시 판돈 독식
          </p>

          <div className="mode-select-grid">
            <button
              type="button"
              className="mode-select-btn solo"
              onClick={() => {
                setSoloScreen('SETUP');
                setAppMode('SOLO');
              }}
            >
              <span className="mode-icon">🎮</span>
              <strong>단독게임</strong>
              <span className="mode-desc">2~4인 로컬 개척 대결 · 연승 &amp; 판돈 누적</span>
            </button>

            <button
              type="button"
              className="mode-select-btn net"
              onClick={() => setAppMode('NET_LOBBY')}
            >
              <span className="mode-icon">🌐</span>
              <strong>넷게임</strong>
              <span className="mode-desc">실시간 4개 카탄 섬 테이블 대전 &amp; 관전</span>
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
      <div className="catan-container" style={{ background: WOOD_BG_THEMES[0], padding: '16px' }}>
        <div className="setup-card" style={{ maxWidth: '620px', margin: '0 auto' }}>
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
            <h2 style={{ margin: 0, color: '#3e2723' }}>🏅 카탄 명예의 전당</h2>
            <div style={{ width: '60px' }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div className="hof-box">
              <h3 className="hof-title solo">🎮 단독 개척 TOP 10</h3>
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
              <h3 className="hof-title net">🌐 넷개척 TOP 10</h3>
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
      <div className="catan-container" style={{ background: WOOD_BG_THEMES[0] }}>
        <div className="net-lobby-container">
          <div className="net-lobby-header">
            <button type="button" className="btn btn-secondary" onClick={() => setAppMode('HOME')}>
              ⬅️ 홈으로
            </button>
            <h2 style={{ margin: 0, fontSize: '20px', color: '#3e2723' }}>
              🌐 카탄 넷게임 (4개 개척 섬)
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

              let statusBadgeText = '🟢 빈 개척섬';
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
                    <span className="room-number-title">🏝️ 제 {room.roomId} 카탄섬</span>
                    <span className={`room-status-pill ${statusClass}`}>{statusBadgeText}</span>
                  </div>

                  <div className="room-rules-info">
                    <span>💰 판돈: {room.anteBet.toLocaleString()}칩</span>
                    <span>⭐ 목표: {room.targetVP}점</span>
                    <span>⏱️ {room.baseTimeout}초</span>
                  </div>

                  <div className="room-members-box">
                    <div className="room-members-label">개척자 ({roomPlayers.length}/4):</div>
                    <div className="room-members-chips">
                      {roomPlayers.length === 0 ? (
                        <span className="empty-member-text">첫 번째 개척자를 기다리고 있습니다</span>
                      ) : (
                        roomPlayers.map((p) => (
                          <span key={p.id} className="member-chip">
                            <span
                              className="catan-color-dot"
                              style={{ backgroundColor: PLAYER_COLOR_META[p.color].hex }}
                            />
                            {p.name} ({p.wins}승 · {p.chips.toLocaleString()}칩)
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
                      ? '👉 클릭하여 개척섬 열기 또는 관전하기'
                      : isPlaying || isFull
                      ? '👉 클릭하여 다음 판 예약 또는 관전하기'
                      : '👉 클릭하여 개척 참가 또는 관전하기'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {joinModalRoom && (
          <div className="modal-overlay" onClick={() => setJoinModalRoom(null)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h2 style={{ margin: '0 0 8px' }}>🏝️ 제 {joinModalRoom.roomId} 카탄섬 입장</h2>
              <p className="modal-subtext">
                동일 판돈 <strong>{joinModalRoom.anteBet.toLocaleString()}칩</strong> · 목표{' '}
                <strong>{joinModalRoom.targetVP}점</strong> 달성 시 승자 독식!
              </p>

              <input
                type="text"
                className="player-input"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: '14px' }}
                placeholder="개척자 이름 입력 (예: 콜럼버스)"
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
                  🚀 개척 참가 / 예약
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
        <div className="catan-container" style={{ background: WOOD_BG_THEMES[0] }}>
          <div className="setup-card" style={{ textAlign: 'center' }}>
            <h2>⏳ 개척섬 정보를 불러오는 중입니다...</h2>
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
    const isHost = roomPlayers[0]?.id === mySessionId;
    const amISpectator = (activeNetRoom.spectators || []).some((s) => s.id === mySessionId);

    if (activeNetRoom.status === 'WAITING' || activeNetRoom.status === 'EMPTY') {
      const minutes = Math.floor(waitingCountdownSec / 60);
      const seconds = waitingCountdownSec % 60;
      const countdownStr = `${minutes}분 ${seconds < 10 ? '0' : ''}${seconds}초`;

      return (
        <div className="catan-container" style={{ background: WOOD_BG_THEMES[0] }}>
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
                제 {activeNetRoom.roomId}섬 · 대기 중 (⏱️ {countdownStr})
              </span>
            </div>

            <h1 className="setup-title" style={{ marginTop: '14px' }}>
              🏝️ 카탄 개척 대기실 {amISpectator ? '👀 [관전모드]' : ''}
            </h1>

            <div className="setting-section">
              <label className="setting-label">
                💰 동일 판돈 설정 {isHost ? '(방장 설정 가능)' : ''}
              </label>
              <div className="piece-count-selector">
                {[1000, 2000, 3000, 5000].map((val) => (
                  <button
                    key={val}
                    type="button"
                    disabled={!isHost}
                    className={`count-btn ${activeNetRoom.anteBet === val ? 'active' : ''}`}
                    onClick={() =>
                      updateNetRoomSettings(
                        val,
                        activeNetRoom.baseTimeout,
                        activeNetRoom.targetVP
                      )
                    }
                  >
                    {val.toLocaleString()}칩
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-section">
              <label className="setting-label">
                ⭐ 승리 목표 승점 {isHost ? '(방장 설정 가능)' : ''}
              </label>
              <div className="piece-count-selector">
                {[6, 8, 10, 12].map((vp) => (
                  <button
                    key={vp}
                    type="button"
                    disabled={!isHost}
                    className={`count-btn ${activeNetRoom.targetVP === vp ? 'active' : ''}`}
                    onClick={() =>
                      updateNetRoomSettings(
                        activeNetRoom.anteBet,
                        activeNetRoom.baseTimeout,
                        vp
                      )
                    }
                  >
                    {vp}점 승리
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-section">
              <label className="setting-label">
                ⏱️ 턴 제한시간: <strong>{activeNetRoom.baseTimeout}초</strong>
              </label>
              <input
                type="range"
                min={30}
                max={180}
                step={15}
                disabled={!isHost}
                value={activeNetRoom.baseTimeout}
                style={{ width: '100%' }}
                onChange={(e) =>
                  updateNetRoomSettings(
                    activeNetRoom.anteBet,
                    Number(e.target.value),
                    activeNetRoom.targetVP
                  )
                }
              />
            </div>

            <div className="setting-section">
              <label className="setting-label">🧭 입장한 개척자 (2~4명 시작 가능)</label>
              <div className="player-list">
                {roomPlayers.map((p, idx) => (
                  <div key={p.id} className="player-item-a">
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span
                        className="catan-color-dot"
                        style={{ backgroundColor: PLAYER_COLOR_META[p.color].hex }}
                      />
                      {p.name} ({PLAYER_COLOR_META[p.color].label}){' '}
                      {idx === 0 && '👑(방장)'} {p.id === mySessionId && '(나)'}
                    </span>
                    <span style={{ fontSize: '12px', color: '#2e7d32' }}>
                      🏆{p.wins}승 · {p.chips.toLocaleString()}칩
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
              🚀 카탄 개척 시작! (전원 {activeNetRoom.anteBet.toLocaleString()}칩 동일 베팅)
            </button>
          </div>
        </div>
      );
    }

    return renderCatanPlayScreen(activeNetRoom, false);
  }

  // =========================================================================
  // 5. 단독게임(SOLO) 설정 및 플레이
  // =========================================================================
  if (soloScreen === 'SETUP') {
    return (
      <div className="catan-container" style={{ background: WOOD_BG_THEMES[0] }}>
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
          <h1 className="setup-title">🏝️ 카탄의 개척자 (단독게임 설정)</h1>

          <div className="setting-section">
            <label className="setting-label">👥 참여 인원 수</label>
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
            <label className="setting-label">💰 매 대국 동일 판돈 (초기 10,000칩)</label>
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
            <label className="setting-label">⭐ 승리 목표 승점</label>
            <div className="piece-count-selector">
              {[6, 8, 10, 12].map((vp) => (
                <button
                  key={vp}
                  type="button"
                  className={`count-btn ${soloTargetVP === vp ? 'active' : ''}`}
                  onClick={() => setSoloTargetVP(vp)}
                >
                  {vp}점 승리
                </button>
              ))}
            </div>
          </div>

          <div className="setting-section">
            <label className="setting-label">
              ⏱️ 턴 제한시간: <strong>{soloTimeoutSec}초</strong>
            </label>
            <input
              type="range"
              min={30}
              max={180}
              step={15}
              value={soloTimeoutSec}
              style={{ width: '100%' }}
              onChange={(e) => setSoloTimeoutSec(Number(e.target.value))}
            />
          </div>

          <div className="setting-section">
            <label className="setting-label">🧭 개척자 이름 설정</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {Array.from({ length: soloPlayerCount }, (_, idx) => {
                const cMeta = PLAYER_COLOR_META[PLAYER_COLORS[idx]];
                return (
                  <div key={idx} className="player-item-a">
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span
                        className="catan-color-dot"
                        style={{ backgroundColor: cMeta.hex }}
                      />
                      <span>
                        {idx + 1}번 ({cMeta.label})
                      </span>
                    </span>
                    <input
                      type="text"
                      className="player-input"
                      style={{ maxWidth: '210px', padding: '6px 10px' }}
                      value={soloNames[idx] || ''}
                      onChange={(e) => {
                        const next = [...soloNames];
                        next[idx] = e.target.value;
                        setSoloNames(next);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <button type="button" className="btn btn-success" onClick={() => startSoloMatch(false)}>
            🚀 카탄 개척 시작! (전원 {soloAnteBet.toLocaleString()}칩 동일 베팅)
          </button>
        </div>
      </div>
    );
  }

  return renderCatanPlayScreen(soloRoom, true);
}