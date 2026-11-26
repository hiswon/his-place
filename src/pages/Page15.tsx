import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import './Page15.css';

interface StyleConfig {
  welcomeSizeRem: number;
  welcomeColor: string;
  titleSizeRem: number;
  titleColor: string;
  contentSizeRem: number;
  personNameSizeRem: number;
  contentColor: string;
  beforeDateSizeRem: number;
  beforeDateColor: string;
  beforeTimeSizeRem: number;
  beforeTimeColor: string;
  afterDateSizeRem: number;
  afterDateColor: string;
  afterTimeSizeRem: number;
  afterTimeColor: string;
  worshipDateSizeRem: number;
  worshipTimeSizeRem: number;
  showWorshipSeconds: boolean;
  textOpacity: number;
  bgColor: string;
  bgOpacity: number;
  countdownSound: boolean;
  invertMoodAfter: boolean;
}

interface ColorPreset {
  name: string;
  bgColor: string;
  welcomeColor: string;
  titleColor: string;
  contentColor: string;
  beforeDateColor: string;
  beforeTimeColor: string;
  afterDateColor: string;
  afterTimeColor: string;
}

interface WorshipItem {
  title: string;
  slides: string[];
}

interface StageInfo {
  type: 'clock' | 'countdown' | 'midnight' | 'welcome' | 'worship';
  welcomeIdx?: number;
  worshipIdx?: number;
  slideIdx?: number;
  label: string;
}

const KOREAN_COUNTDOWN_WORDS: Record<number, string> = {
  10: '십',
  9: '구',
  8: '팔',
  7: '칠',
  6: '육',
  5: '오',
  4: '사',
  3: '삼',
  2: '이',
  1: '일',
};

const COLOR_PRESETS: ColorPreset[] = [
  {
    name: '1. 화이트/검정',
    bgColor: '#ffffff',
    welcomeColor: '#000000',
    titleColor: '#000000',
    contentColor: '#000000',
    beforeDateColor: '#000000',
    beforeTimeColor: '#000000',
    afterDateColor: '#000000',
    afterTimeColor: '#000000',
  },
  {
    name: '2. 검정/흰색',
    bgColor: '#000000',
    welcomeColor: '#ffffff',
    titleColor: '#ffffff',
    contentColor: '#ffffff',
    beforeDateColor: '#ffffff',
    beforeTimeColor: '#ffffff',
    afterDateColor: '#ffffff',
    afterTimeColor: '#ffffff',
  },
  {
    name: '3. 네이비 골드',
    bgColor: '#0b1d3a',
    welcomeColor: '#ffd166',
    titleColor: '#ffd166',
    contentColor: '#f8fafc',
    beforeDateColor: '#e2e8f0',
    beforeTimeColor: '#ffd166',
    afterDateColor: '#ff6b6b',
    afterTimeColor: '#ffffff',
  },
  {
    name: '4. 포레스트 크림',
    bgColor: '#122b22',
    welcomeColor: '#f4f1ea',
    titleColor: '#a7f3d0',
    contentColor: '#f4f1ea',
    beforeDateColor: '#d1fae5',
    beforeTimeColor: '#f4f1ea',
    afterDateColor: '#fde047',
    afterTimeColor: '#ffffff',
  },
  {
    name: '5. 버건디 아이보리',
    bgColor: '#000000',
    welcomeColor: '#fff8ee',
    titleColor: '#fde68a',
    contentColor: '#fff8ee',
    beforeDateColor: '#f3d5de',
    beforeTimeColor: '#fde68a',
    afterDateColor: '#67e8f9',
    afterTimeColor: '#ffffff',
  },
];

const DEFAULT_WELCOME_TEXT = `Happy New Year/
새해 복 많이 받으세요./`;

const DEFAULT_WORSHIP_TEXT = `찬송/
기뻐하며 경배하세
영광의 주 하나님
주 안에서 우리마음
피어나는 꽃같아/
찬양하며 경배하세
거룩하신 하나님
우리 모든 삶을 드려
주님께 영광 돌려/
;
기도/
홍길동 집사/
;
말씀봉독(요3:16)/
하나님이 세상을 이처럼 사랑하사 독생자를 주셨으니 
이는 그를 믿는 자마다 멸망하지 않고 
영생을 얻게 하려 하심이라(요 3:16)/`;

// HEX 문자열 정규화 (#rrggbb)
const normalizeHex = (hex: string): string => {
  const clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    return (
      '#' +
      clean
        .split('')
        .map((c) => c + c)
        .join('')
    ).toLowerCase();
  }
  return ('#' + clean.padEnd(6, '0').slice(0, 6)).toLowerCase();
};

// 색상 반전 유틸 (분위기 반전용: RGB 보색 반전)
const invertHexColor = (hex: string): string => {
  const full = normalizeHex(hex).replace('#', '');
  const num = parseInt(full, 16);
  const r = 255 - ((num >> 16) & 255);
  const g = 255 - ((num >> 8) & 255);
  const b = 255 - (num & 255);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

// HEX 색상을 RGBA 문자열로 변환
const hexToRgba = (hex: string, opacityPercent: number): string => {
  const full = normalizeHex(hex).replace('#', '');
  const num = parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  const a = Math.max(0, Math.min(100, opacityPercent)) / 100;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

// "2026.12.31" 및 "0.0.0" (또는 "00:00:00") 형식 파싱
const parseTargetDateTime = (dateText: string, timeText: string): Date => {
  const dParts = dateText
    .trim()
    .split(/[.:\-/년월일\s]+/)
    .filter(Boolean)
    .map(Number);
  const tParts = timeText
    .trim()
    .split(/[.:\-시분초\s]+/)
    .filter(Boolean)
    .map(Number);

  const year = dParts[0] || 2026;
  const month = (dParts[1] || 12) - 1;
  const day = dParts[2] || 31;

  const hour = tParts[0] || 0;
  const minute = tParts[1] || 0;
  const second = tParts[2] || 0;

  return new Date(year, month, day, hour, minute, second, 0);
};

const formatDotDate = (d: Date): string =>
  `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;

const formatDotTime = (d: Date): string =>
  `${d.getHours()}.${d.getMinutes()}.${d.getSeconds()}`;

// 컨테이너를 넘지 않도록 글자 크기 자동 축소 보정 래퍼
const FitTextBox: React.FC<{
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  watchKey?: string | number;
}> = ({ children, className = '', style, watchKey }) => {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [fitScale, setFitScale] = useState<number>(1);

  const recalcFit = useCallback(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    inner.style.transform = 'scale(1)';
    const availW = outer.clientWidth;
    const availH = outer.clientHeight;
    if (availW <= 0 || availH <= 0) return;

    const neededW = inner.scrollWidth;
    const neededH = inner.scrollHeight;

    if (neededW > availW || neededH > availH) {
      const ratioW = availW / Math.max(1, neededW);
      const ratioH = availH / Math.max(1, neededH);
      setFitScale(Math.max(0.2, Math.min(1, ratioW, ratioH)));
    } else {
      setFitScale(1);
    }
  }, []);

  useLayoutEffect(() => {
    recalcFit();
  }, [recalcFit, watchKey, style?.fontSize]);

  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const ro = new ResizeObserver(recalcFit);
    ro.observe(outer);
    return () => ro.disconnect();
  }, [recalcFit]);

  return (
    <div ref={outerRef} className="fit-text-outer">
      <div
        ref={innerRef}
        className={`fit-text-inner ${className}`}
        style={{
          ...style,
          transform: fitScale < 1 ? `scale(${fitScale})` : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
};

// 캔버스 폭죽 효과 컴포넌트
const FireworksCanvas: React.FC<{ active: boolean }> = ({ active }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    const resize = () => {
      canvas.width = canvas.parentElement?.clientWidth || window.innerWidth;
      canvas.height = canvas.parentElement?.clientHeight || window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    interface Particle {
      x: number;
      y: number;
      vx: number;
      vy: number;
      alpha: number;
      color: string;
      size: number;
    }

    let particles: Particle[] = [];
    const colors = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#ff2d55'];

    const createBurst = (x: number, y: number) => {
      const color = colors[Math.floor(Math.random() * colors.length)];
      for (let i = 0; i < 65; i++) {
        const angle = (Math.PI * 2 * i) / 65 + (Math.random() - 0.5) * 0.2;
        const speed = Math.random() * 6 + 2;
        particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          alpha: 1,
          color,
          size: Math.random() * 3 + 2,
        });
      }
    };

    createBurst(canvas.width * 0.3, canvas.height * 0.35);
    createBurst(canvas.width * 0.7, canvas.height * 0.3);

    const interval = setInterval(() => {
      createBurst(
        canvas.width * (0.2 + Math.random() * 0.6),
        canvas.height * (0.15 + Math.random() * 0.45)
      );
    }, 900);

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.06;
        p.alpha -= 0.014;
      });
      particles = particles.filter((p) => p.alpha > 0);

      particles.forEach((p) => {
        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
      clearInterval(interval);
      window.removeEventListener('resize', resize);
    };
  }, [active]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="fireworks-canvas" />;
};

export default function Page15() {
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(true);
  const [welcomeInput, setWelcomeInput] = useState<string>(DEFAULT_WELCOME_TEXT);
  const [worshipInput, setWorshipInput] = useState<string>(DEFAULT_WORSHIP_TEXT);

  // 카운트다운 목표 일시 설정 (예: 날짜 2026.12.31, 시간 0.0.0)
  const [targetDateInput, setTargetDateInput] = useState<string>('2027.1.1');
  const [targetTimeInput, setTargetTimeInput] = useState<string>('0.0.0');

  const [styles, setStyles] = useState<StyleConfig>({
    welcomeSizeRem: 7.2,
    welcomeColor: '#ffffff',
    titleSizeRem: 5,
    titleColor: '#ffffff',
    contentSizeRem: 5.8,
    personNameSizeRem: 8.5,
    contentColor: '#ffffff',
    beforeDateSizeRem: 8.5,
    beforeDateColor: '#ffffff',
    beforeTimeSizeRem: 14.5,
    beforeTimeColor: '#ffffff',
    afterDateSizeRem: 16.5,
    afterDateColor: '#e04110',
    afterTimeSizeRem: 8.0,
    afterTimeColor: '#ffffff',
    worshipDateSizeRem: 3.2,
    worshipTimeSizeRem: 2.6,
    showWorshipSeconds: true,
    textOpacity: 100,
    bgColor: '#000000',
    bgOpacity: 100,
    countdownSound: true,
    invertMoodAfter: false,
  });

  // 미리보기 컨테이너 너비에 맞춰 1920x1080 기준 스케일을 자동 계산
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const [previewScale, setPreviewScale] = useState<number>(0.18);

  useEffect(() => {
    if (!isSettingsOpen) return;
    const el = previewBoxRef.current;
    if (!el) return;

    const updateScale = () => {
      const w = el.clientWidth;
      if (w > 0) {
        setPreviewScale(w / 1920);
      }
    };
    updateScale();

    const observer = new ResizeObserver(updateScale);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isSettingsOpen]);

  // 시간 및 시뮬레이션 상태
  const [now, setNow] = useState<Date>(() => new Date());
  const [simOffsetMs, setSimOffsetMs] = useState<number | null>(null);
  const [simStartRealMs, setSimStartRealMs] = useState<number>(0);

  // 화면 단계 인덱스 및 미리보기 상태
  const [stageIndex, setStageIndex] = useState<number>(0);
  const [previewStageIndex, setPreviewStageIndex] = useState<number>(0);
  const [fireworksTriggered, setFireworksTriggered] = useState<boolean>(false);

  // 설정된 목표 일시 Date 객체 (기준 시점)
  const targetDateTime = useMemo(
    () => parseTargetDateTime(targetDateInput, targetTimeInput),
    [targetDateInput, targetTimeInput]
  );

  // 설정 1 파싱: '/' 기준으로 환영 멘트 단계 분리
  const welcomeSlides = useMemo(() => {
    return welcomeInput
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }, [welcomeInput]);

  // 설정 2 파싱: ';' 기준으로 주제(챕터) 분리, '/' 기준으로 각 페이지 분리
  const worshipItems: WorshipItem[] = useMemo(() => {
    const sections = worshipInput
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    return sections.map((sec) => {
      const parts = sec
        .split('/')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      return {
        title: parts[0] || '',
        slides: parts.slice(1),
      };
    });
  }, [worshipInput]);

  // 전체 진행 스테이지 목록 생성
  const stages: StageInfo[] = useMemo(() => {
    const tDateLabel = formatDotDate(targetDateTime);
    const tTimeLabel = formatDotTime(targetDateTime);

    const list: StageInfo[] = [
      { type: 'clock', label: `기준전 · 시계 (${tDateLabel})` },
      { type: 'countdown', label: `기준전 · 카운트다운` },
      { type: 'midnight', label: `기준후 · 도달 (${tDateLabel} ${tTimeLabel})` },
    ];

    welcomeSlides.forEach((_, idx) => {
      list.push({
        type: 'welcome',
        welcomeIdx: idx,
        label: `기준후 · 환영멘트 ${idx + 1}`,
      });
    });

    worshipItems.forEach((item, wIdx) => {
      if (item.slides.length === 0) {
        list.push({
          type: 'worship',
          worshipIdx: wIdx,
          slideIdx: -1,
          label: `예배 · ${item.title} (제목)`,
        });
      } else {
        item.slides.forEach((_, sIdx) => {
          list.push({
            type: 'worship',
            worshipIdx: wIdx,
            slideIdx: sIdx,
            label: `예배 · ${item.title} (${sIdx + 1}/${item.slides.length})`,
          });
        });
      }
    });

    return list;
  }, [targetDateTime, welcomeSlides, worshipItems]);

  // 각 예배 챕터(worshipIdx)가 전체 stages에서 시작하는 인덱스 매핑
  const worshipStartStageIndices = useMemo(() => {
    const map: number[] = [];
    stages.forEach((st, idx) => {
      if (st.type === 'worship' && st.worshipIdx !== undefined) {
        if (map[st.worshipIdx] === undefined) {
          map[st.worshipIdx] = idx;
        }
      }
    });
    return map;
  }, [stages]);

  // 현재 표시 시간 계산
  const currentDisplayTime = useMemo(() => {
    if (simOffsetMs !== null) {
      const elapsed = now.getTime() - simStartRealMs;
      return new Date(simOffsetMs + elapsed);
    }
    return now;
  }, [now, simOffsetMs, simStartRealMs]);

  // 카운트다운 음성 읽기 (10 ~ 1만 읽고 0은 읽지 않음)
  const lastSpokenNumRef = useRef<number | null>(null);
  const speakCountdownNumber = useCallback(
    (num: number) => {
      if (!styles.countdownSound) return;
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      if (num < 1 || num > 10) return;

      const word = KOREAN_COUNTDOWN_WORDS[num];
      if (!word) return;

      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(word);
      utter.lang = 'ko-KR';
      utter.rate = 1.05;
      window.speechSynthesis.speak(utter);
    },
    [styles.countdownSound]
  );

  // 100ms 단위 타이머 루프 & 목표 시점 기반 자동 전환 로직
  useEffect(() => {
    const timer = setInterval(() => {
      const realNow = new Date();
      setNow(realNow);

      const activeTime =
        simOffsetMs !== null
          ? new Date(simOffsetMs + (realNow.getTime() - simStartRealMs))
          : realNow;

      const diffMs = targetDateTime.getTime() - activeTime.getTime();

      // 목표 시각 10초 전 ~ 0초 초과 구간에서 카운트다운 진입
      if (diffMs > 0 && diffMs <= 10500) {
        setStageIndex((prev) => (prev < 1 ? 1 : prev));
        setPreviewStageIndex((prev) => (prev < 1 ? 1 : prev));

        const secLeft = Math.ceil(diffMs / 1000);
        if (secLeft >= 1 && secLeft <= 10 && lastSpokenNumRef.current !== secLeft) {
          lastSpokenNumRef.current = secLeft;
          if (!isSettingsOpen) {
            speakCountdownNumber(secLeft);
          }
        }
      }

      // 목표 시각 도달 시 자정/목표도달 화면 및 폭죽 실행 (0은 읽지 않음)
      if (diffMs <= 0 && diffMs > -2000) {
        lastSpokenNumRef.current = null;
        setStageIndex((prev) => (prev < 2 ? 2 : prev));
        setPreviewStageIndex((prev) => (prev < 2 ? 2 : prev));
        setFireworksTriggered(true);
      }
    }, 100);

    return () => clearInterval(timer);
  }, [targetDateTime, simOffsetMs, simStartRealMs, isSettingsOpen, speakCountdownNumber]);

  // 폭죽 자동 종료 타이머
  useEffect(() => {
    if (!fireworksTriggered) return;
    const t = setTimeout(() => setFireworksTriggered(false), 6000);
    return () => clearTimeout(t);
  }, [fireworksTriggered]);

  // 색상 프리셋 적용
  const applyPreset = (preset: ColorPreset) => {
    setStyles((prev) => ({
      ...prev,
      bgColor: preset.bgColor,
      welcomeColor: preset.welcomeColor,
      titleColor: preset.titleColor,
      contentColor: preset.contentColor,
      beforeDateColor: preset.beforeDateColor,
      beforeTimeColor: preset.beforeTimeColor,
      afterDateColor: preset.afterDateColor,
      afterTimeColor: preset.afterTimeColor,
    }));
  };

  // a. 실제카운트 버튼
  const handleStartRealCount = () => {
    const realNow = new Date();
    lastSpokenNumRef.current = null;
    setNow(realNow);
    setSimOffsetMs(null);
    setStageIndex(0);
    setPreviewStageIndex(0);
    setFireworksTriggered(false);
    setIsSettingsOpen(false);
  };

  // b. 연습카운트 버튼 (설정된 목표 시각 20초 전부터 시작)
  const handleStartPracticeCount = () => {
    const practiceStart = new Date(targetDateTime.getTime() - 20 * 1000);
    lastSpokenNumRef.current = null;
    setSimOffsetMs(practiceStart.getTime());
    setSimStartRealMs(Date.now());
    setNow(new Date());
    setStageIndex(0);
    setPreviewStageIndex(0);
    setFireworksTriggered(false);
    setIsSettingsOpen(false);
  };

  // c. 연습전체화면 버튼
  const handleOpenPracticeFullscreen = () => {
    setIsSettingsOpen(false);
  };

  // 직접 인덱스 이동
  const jumpToStage = (targetIdx: number, isPreview: boolean) => {
    const clamped = Math.max(0, Math.min(stages.length - 1, targetIdx));
    const nextStage = stages[clamped];

    if (
      nextStage?.type === 'midnight' ||
      (nextStage?.type === 'welcome' && nextStage.welcomeIdx === 0)
    ) {
      setFireworksTriggered(true);
    }

    if (isPreview) {
      setPreviewStageIndex(clamped);
    } else {
      setStageIndex(clamped);
    }
  };

  // 좌측 컨트롤 바의 ◀ ▶ 버튼 (예배 PPT 상태에서는 '다음/이전 챕터'로 이동)
  const handleMainNav = (delta: number, isPreview: boolean) => {
    const currentIdx = isPreview ? previewStageIndex : stageIndex;
    const currentStage = stages[currentIdx];

    if (currentStage?.type === 'worship' && currentStage.worshipIdx !== undefined) {
      if (delta > 0) {
        const nextWIdx = currentStage.worshipIdx + 1;
        if (nextWIdx < worshipItems.length && worshipStartStageIndices[nextWIdx] !== undefined) {
          jumpToStage(worshipStartStageIndices[nextWIdx], isPreview);
        }
      } else {
        const prevWIdx = currentStage.worshipIdx - 1;
        if (prevWIdx >= 0 && worshipStartStageIndices[prevWIdx] !== undefined) {
          jumpToStage(worshipStartStageIndices[prevWIdx], isPreview);
        } else {
          const firstWorshipIdx = worshipStartStageIndices[0] ?? currentIdx;
          jumpToStage(firstWorshipIdx - 1, isPreview);
        }
      }
      return;
    }

    jumpToStage(currentIdx + delta, isPreview);
  };

  // 우측 ◀ [숫자] ▶ 버튼 (한 챕터/제목 안의 슬라이드만 무한 루프)
  const handleChapterSlideLoop = (delta: number, isPreview: boolean) => {
    if (worshipItems.length === 0) return;
    const currentIdx = isPreview ? previewStageIndex : stageIndex;
    const currentStage = stages[currentIdx];

    if (currentStage?.type !== 'worship' || currentStage.worshipIdx === undefined) {
      const firstIdx = worshipStartStageIndices[0];
      if (firstIdx !== undefined) jumpToStage(firstIdx, isPreview);
      return;
    }

    const wIdx = currentStage.worshipIdx;
    const item = worshipItems[wIdx];
    const totalSlides = item.slides.length;

    if (totalSlides <= 1) return;

    const currentSlide = currentStage.slideIdx ?? 0;
    const loopedSlide = (currentSlide + delta + totalSlides) % totalSlides;
    const baseStageIdx = worshipStartStageIndices[wIdx];

    if (baseStageIdx !== undefined) {
      jumpToStage(baseStageIdx + loopedSlide, isPreview);
    }
  };

  // 미리보기 전용 전체 단계 순환 (전/후 모든 상황 순서대로 탐색)
  const handlePreviewStep = (delta: number) => {
    if (stages.length === 0) return;
    const nextIdx = (previewStageIndex + delta + stages.length) % stages.length;
    jumpToStage(nextIdx, true);
  };

  // 날짜 및 시간 포맷팅
  const formatTimeParts = (d: Date) => {
    const yyyy = d.getFullYear();
    const mm = d.getMonth() + 1;
    const dd = d.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');

    const isDec31Night = mm === 12 && dd === 31 && d.getHours() >= 12;
    const displayHour12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;

    const fullTimeStr = isDec31Night
      ? `${String(displayHour12).padStart(2, '0')}:${min}:${ss}`
      : `${hh}:${min}:${ss}`;

    const hourMinStr = isDec31Night
      ? `${String(displayHour12).padStart(2, '0')}:${min}`
      : `${hh}:${min}`;

    const remainingMs = Math.max(0, targetDateTime.getTime() - d.getTime());
    const countdownNum =
      remainingMs <= 0 ? 0 : Math.min(10, Math.ceil(remainingMs / 1000));

    return {
      dateStr: `${yyyy}.${mm}.${dd}`,
      fullTimeStr,
      hourMinStr,
      countdownNum,
    };
  };

  // 송출 화면 및 미리보기 화면 렌더러
  const renderPresentationScreen = (currentIdx: number, isPreview: boolean) => {
    const stage = stages[currentIdx] || stages[0];
    const { dateStr, fullTimeStr, hourMinStr, countdownNum } = formatTimeParts(currentDisplayTime);

    // 기준 시점 전/후 판별: 실제 시간이 목표 시각을 지났거나, 스테이지가 도달/환영/예배 단계인 경우 기준 후로 처리
    const isAfterState =
      currentDisplayTime.getTime() >= targetDateTime.getTime() ||
      stage.type === 'midnight' ||
      stage.type === 'welcome' ||
      stage.type === 'worship';

    // 반전분위기 적용 여부 (기준 시점 이후 + 반전분위기 ON)
    const shouldInvertMood = isAfterState && styles.invertMoodAfter;
    const resolveColor = (hex: string) => (shouldInvertMood ? invertHexColor(hex) : hex);

    const activeDateSizeRem = isAfterState
      ? styles.afterDateSizeRem
      : styles.beforeDateSizeRem;
    const activeTimeSizeRem = isAfterState
      ? styles.afterTimeSizeRem
      : styles.beforeTimeSizeRem;

    const activeDateColor = resolveColor(
      isAfterState ? styles.afterDateColor : styles.beforeDateColor
    );
    const activeTimeColor = resolveColor(
      isAfterState ? styles.afterTimeColor : styles.beforeTimeColor
    );
    const activeWelcomeColor = resolveColor(styles.welcomeColor);
    const activeTitleColor = resolveColor(styles.titleColor);
    const activeContentColor = resolveColor(styles.contentColor);
    const activeBgColor = resolveColor(styles.bgColor);

    // 미리보기에서 기준후(midnight) 단계를 볼 때 목표 일시를 직관적으로 표시
    const displayDateText =
      isPreview && stage.type === 'midnight' ? formatDotDate(targetDateTime) : dateStr;
    const displayClockText =
      isPreview && stage.type === 'midnight'
        ? `${String(targetDateTime.getHours()).padStart(2, '0')}:${String(
            targetDateTime.getMinutes()
          ).padStart(2, '0')}:${String(targetDateTime.getSeconds()).padStart(2, '0')}`
        : fullTimeStr;

    const currentSlideDisplayNum =
      stage.type === 'worship' && stage.slideIdx !== undefined && stage.slideIdx >= 0
        ? stage.slideIdx + 1
        : 1;

    const bgRgba = hexToRgba(activeBgColor, styles.bgOpacity);
    const contentOpacityVal = Math.max(0, Math.min(100, styles.textOpacity)) / 100;

    // 예배 슬라이드 본문이 2줄 미만이면 '인명'으로 인식
    const currentSlideText =
      stage.type === 'worship' &&
      stage.worshipIdx !== undefined &&
      stage.slideIdx !== undefined &&
      stage.slideIdx >= 0
        ? worshipItems[stage.worshipIdx]?.slides[stage.slideIdx] || ''
        : '';

    const lineCount = currentSlideText.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
    const isPersonName = lineCount < 2;
    const bodyFontSizeRem = isPersonName ? styles.personNameSizeRem : styles.contentSizeRem;

    const stageBody = (
      <div
        className={`presentation-container ${isPreview ? 'is-preview' : 'is-fullscreen'} ${
          shouldInvertMood ? 'is-inverted-mood' : ''
        }`}
        style={{ backgroundColor: bgRgba }}
      >
        <FireworksCanvas active={fireworksTriggered} />

        {stage.type === 'worship' && stage.worshipIdx !== undefined ? (
          <div className="worship-flex-layout" style={{ opacity: contentOpacityVal }}>
            <div className="worship-top-header">
              <FitTextBox
                className="worship-header-date"
                style={{
                  fontSize: `${styles.worshipDateSizeRem}rem`,
                  color: activeDateColor,
                }}
                watchKey={displayDateText}
              >
                {displayDateText}
              </FitTextBox>
              <FitTextBox
                className="worship-header-time"
                style={{
                  fontSize: `${styles.worshipTimeSizeRem}rem`,
                  color: activeTimeColor,
                }}
                watchKey={styles.showWorshipSeconds ? fullTimeStr : hourMinStr}
              >
                {styles.showWorshipSeconds ? fullTimeStr : hourMinStr}
              </FitTextBox>
            </div>

            <div className="worship-title-section">
              <FitTextBox
                className="display-worship-title"
                style={{
                  fontSize: `${styles.titleSizeRem}rem`,
                  color: activeTitleColor,
                }}
                watchKey={worshipItems[stage.worshipIdx]?.title}
              >
                {worshipItems[stage.worshipIdx]?.title}
              </FitTextBox>
            </div>

            <div className="worship-body-section">
              {stage.slideIdx !== undefined && stage.slideIdx >= 0 && (
                <FitTextBox
                  className={`display-worship-body ${isPersonName ? 'is-person-name' : ''}`}
                  style={{
                    fontSize: `${bodyFontSizeRem}rem`,
                    color: activeContentColor,
                  }}
                  watchKey={currentSlideText}
                >
                  {currentSlideText}
                </FitTextBox>
              )}
            </div>
          </div>
        ) : (
          <div className="presentation-content" style={{ opacity: contentOpacityVal }}>
            <FitTextBox
              className="display-date"
              style={{
                fontSize: `${activeDateSizeRem}rem`,
                color: activeDateColor,
              }}
              watchKey={displayDateText}
            >
              {displayDateText}
            </FitTextBox>

            {stage.type === 'clock' && (
              <FitTextBox
                className="display-main-clock"
                style={{ fontSize: `${activeTimeSizeRem}rem`, color: activeTimeColor }}
                watchKey={displayClockText}
              >
                {displayClockText}
              </FitTextBox>
            )}

            {stage.type === 'countdown' && (
              <>
                <FitTextBox
                  className="display-sub-clock"
                  style={{
                    fontSize: `${Math.max(1.5, activeTimeSizeRem * 0.45)}rem`,
                    color: activeTimeColor,
                  }}
                  watchKey={displayClockText}
                >
                  {displayClockText}
                </FitTextBox>
                <FitTextBox
                  className="display-countdown-number"
                  style={{
                    fontSize: `${Math.max(4, activeTimeSizeRem * 1.35)}rem`,
                    color: activeTimeColor,
                  }}
                  watchKey={countdownNum}
                >
                  {countdownNum}
                </FitTextBox>
              </>
            )}

            {stage.type === 'midnight' && (
              <FitTextBox
                className="display-midnight-clock"
                style={{
                  fontSize: `${Math.max(2, activeTimeSizeRem * 0.8)}rem`,
                  color: activeTimeColor,
                }}
                watchKey={displayClockText}
              >
                {displayClockText}
              </FitTextBox>
            )}

            {stage.type === 'welcome' && stage.welcomeIdx !== undefined && (
              <>
                <FitTextBox
                  className="display-welcome-clock"
                  style={{
                    fontSize: `${Math.max(1.8, activeTimeSizeRem * 0.6)}rem`,
                    color: activeTimeColor,
                  }}
                  watchKey={displayClockText}
                >
                  {displayClockText}
                </FitTextBox>
                <FitTextBox
                  className="display-welcome-text"
                  style={{
                    fontSize: `${styles.welcomeSizeRem}rem`,
                    color: activeWelcomeColor,
                  }}
                  watchKey={welcomeSlides[stage.welcomeIdx]}
                >
                  {welcomeSlides[stage.welcomeIdx]}
                </FitTextBox>
              </>
            )}
          </div>
        )}

        <div className={`control-bar ${isPreview ? 'preview-controls' : ''}`}>
          <button
            type="button"
            className="ctrl-btn stop-square"
            title="설정창 열기"
            onClick={() => setIsSettingsOpen(true)}
          />

          <button
            type="button"
            className="ctrl-btn triangle-left"
            title={stage.type === 'worship' ? '이전 챕터' : '이전 화면'}
            onClick={() => handleMainNav(-1, isPreview)}
          />

          <button
            type="button"
            className="ctrl-btn triangle-right"
            title={stage.type === 'worship' ? '다음 챕터' : '다음 화면'}
            onClick={() => handleMainNav(1, isPreview)}
          />

          {(stage.type === 'worship' || isPreview) && (
            <div className="worship-order-nav" title="현재 챕터 내 슬라이드 순환">
              <button
                type="button"
                className="ctrl-btn triangle-left"
                onClick={() => handleChapterSlideLoop(-1, isPreview)}
              />
              <span className="order-number">{currentSlideDisplayNum}</span>
              <button
                type="button"
                className="ctrl-btn triangle-right"
                onClick={() => handleChapterSlideLoop(1, isPreview)}
              />
            </div>
          )}
        </div>
      </div>
    );

    if (isPreview) {
      return (
        <div
          className="preview-scaled-canvas"
          style={{
            transform: `translate(-50%, -50%) scale(${previewScale})`,
          }}
        >
          {stageBody}
        </div>
      );
    }

    return stageBody;
  };

  return (
    <div className={`songgu-app ${!isSettingsOpen ? 'is-broadcasting' : ''}`}>
      {!isSettingsOpen && renderPresentationScreen(stageIndex, false)}

      {isSettingsOpen && (
        <div className="settings-page">
          <div className="settings-header">
            <h1>
              설정창 (목표: {formatDotDate(targetDateTime)} {formatDotTime(targetDateTime)})
            </h1>
            <div className="header-actions">
              <button type="button" className="btn-secondary" onClick={handleStartRealCount}>
                실제카운트
              </button>
              <button type="button" className="btn-secondary" onClick={handleStartPracticeCount}>
                연습카운트
              </button>
              <button type="button" className="btn-primary" onClick={handleOpenPracticeFullscreen}>
                연습전체화면
              </button>
            </div>
          </div>

          <div className="settings-grid">
            <div className="settings-col-left">
              <div className="setting-box">
                <div className="setting-label">
                  <strong>카운트다운 시점</strong>
                  <span>날짜(예: 2027.1.1) · 시간(예: 0.0.0)</span>
                </div>
                <div className="target-datetime-row">
                  <div className="style-row">
                    <label>목표날짜:</label>
                    <input
                      type="text"
                      className="text-input-sm"
                      value={targetDateInput}
                      onChange={(e) => setTargetDateInput(e.target.value)}
                      placeholder="2027.1.1"
                    />
                  </div>
                  <div className="style-row">
                    <label>목표시간:</label>
                    <input
                      type="text"
                      className="text-input-sm"
                      value={targetTimeInput}
                      onChange={(e) => setTargetTimeInput(e.target.value)}
                      placeholder="0.0.0"
                    />
                  </div>
                </div>
              </div>

              <div className="setting-box">
                <div className="setting-label">
                  <strong>설정 1</strong> <span>환영멘트 입력 (/ 로 단계 구분)</span>
                </div>
                <textarea
                  className="setting-textarea welcome-textarea"
                  value={welcomeInput}
                  onChange={(e) => setWelcomeInput(e.target.value)}
                  placeholder="Happy New Year/&#10;새해 복 많이 받으세요./"
                />
              </div>

              <div className="setting-box">
                <div className="setting-label">
                  <strong>설정 2</strong>{' '}
                  <span>예배순서 입력 (; 챕터 구분, / 슬라이드 구분, 첫 줄은 제목)</span>
                </div>
                <textarea
                  className="setting-textarea worship-textarea"
                  value={worshipInput}
                  onChange={(e) => setWorshipInput(e.target.value)}
                  placeholder="찬송/&#10;가사 1절/&#10;가사 2절/&#10;;&#10;기도/&#10;홍길동 집사/"
                />
              </div>
            </div>

            <div className="settings-col-right">
              <div className="setting-box style-box">
                <div className="setting-label">
                  <strong>설정 3</strong> <span>글자 크기(rem) · 전/후 색상 · 반전분위기 · 음성</span>
                </div>

                <div className="preset-row">
                  {COLOR_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      className="preset-btn"
                      onClick={() => applyPreset(preset)}
                    >
                      <span
                        className="preset-swatch"
                        style={{
                          backgroundColor: preset.bgColor,
                          color: preset.titleColor,
                        }}
                      >
                        가
                      </span>
                      <span>{preset.name}</span>
                    </button>
                  ))}

                  <button
                    type="button"
                    className={`invert-mood-btn ${styles.invertMoodAfter ? 'is-active' : ''}`}
                    onClick={() =>
                      setStyles((prev) => ({
                        ...prev,
                        invertMoodAfter: !prev.invertMoodAfter,
                      }))
                    }
                    title="기준 시점 이후 배경색과 글자색을 반전하여 분위기를 바꿉니다"
                  >
                    🌓 반전분위기 {styles.invertMoodAfter ? 'ON' : 'OFF'}
                  </button>
                </div>

                <div className="style-grid-two-col">
                  <div className="style-row">
                    <label>환영멘트(rem):</label>
                    <input
                      type="number"
                      step="0.2"
                      value={styles.welcomeSizeRem}
                      onChange={(e) =>
                        setStyles({ ...styles, welcomeSizeRem: Number(e.target.value) })
                      }
                    />
                    <input
                      type="color"
                      value={styles.welcomeColor}
                      onChange={(e) => setStyles({ ...styles, welcomeColor: e.target.value })}
                    />
                  </div>

                  <div className="style-row">
                    <label>제목크기(rem):</label>
                    <input
                      type="number"
                      step="0.2"
                      value={styles.titleSizeRem}
                      onChange={(e) =>
                        setStyles({ ...styles, titleSizeRem: Number(e.target.value) })
                      }
                    />
                    <input
                      type="color"
                      value={styles.titleColor}
                      onChange={(e) => setStyles({ ...styles, titleColor: e.target.value })}
                    />
                  </div>

                  <div className="style-row">
                    <label>내용크기(rem):</label>
                    <input
                      type="number"
                      step="0.2"
                      value={styles.contentSizeRem}
                      onChange={(e) =>
                        setStyles({ ...styles, contentSizeRem: Number(e.target.value) })
                      }
                    />
                    <input
                      type="color"
                      value={styles.contentColor}
                      onChange={(e) => setStyles({ ...styles, contentColor: e.target.value })}
                    />
                  </div>

                  <div className="style-row">
                    <label>인명크기(rem):</label>
                    <input
                      type="number"
                      step="0.2"
                      value={styles.personNameSizeRem}
                      onChange={(e) =>
                        setStyles({ ...styles, personNameSizeRem: Number(e.target.value) })
                      }
                    />
                    <span className="hint-badge">2줄미만</span>
                  </div>

                  <div className="style-row">
                    <label>전날짜크기:</label>
                    <input
                      type="number"
                      step="0.5"
                      value={styles.beforeDateSizeRem}
                      onChange={(e) =>
                        setStyles({ ...styles, beforeDateSizeRem: Number(e.target.value) })
                      }
                    />
                    <input
                      type="color"
                      value={styles.beforeDateColor}
                      onChange={(e) =>
                        setStyles({ ...styles, beforeDateColor: e.target.value })
                      }
                    />
                  </div>

                  <div className="style-row">
                    <label>전시간크기:</label>
                    <input
                      type="number"
                      step="0.5"
                      value={styles.beforeTimeSizeRem}
                      onChange={(e) =>
                        setStyles({ ...styles, beforeTimeSizeRem: Number(e.target.value) })
                      }
                    />
                    <input
                      type="color"
                      value={styles.beforeTimeColor}
                      onChange={(e) =>
                        setStyles({ ...styles, beforeTimeColor: e.target.value })
                      }
                    />
                  </div>

                  <div className="style-row">
                    <label>후날짜크기:</label>
                    <input
                      type="number"
                      step="0.5"
                      value={styles.afterDateSizeRem}
                      onChange={(e) =>
                        setStyles({ ...styles, afterDateSizeRem: Number(e.target.value) })
                      }
                    />
                    <input
                      type="color"
                      value={styles.afterDateColor}
                      onChange={(e) =>
                        setStyles({ ...styles, afterDateColor: e.target.value })
                      }
                    />
                  </div>

                  <div className="style-row">
                    <label>후시간크기:</label>
                    <input
                      type="number"
                      step="0.5"
                      value={styles.afterTimeSizeRem}
                      onChange={(e) =>
                        setStyles({ ...styles, afterTimeSizeRem: Number(e.target.value) })
                      }
                    />
                    <input
                      type="color"
                      value={styles.afterTimeColor}
                      onChange={(e) =>
                        setStyles({ ...styles, afterTimeColor: e.target.value })
                      }
                    />
                  </div>

                  <div className="style-row">
                    <label>배경색상:</label>
                    <input
                      type="color"
                      value={styles.bgColor}
                      onChange={(e) => setStyles({ ...styles, bgColor: e.target.value })}
                    />
                    <span className="color-hex">{styles.bgColor}</span>
                  </div>

                  <div className="style-row">
                    <label>예배날짜(rem):</label>
                    <input
                      type="number"
                      step="0.2"
                      value={styles.worshipDateSizeRem}
                      onChange={(e) =>
                        setStyles({ ...styles, worshipDateSizeRem: Number(e.target.value) })
                      }
                    />
                  </div>

                  <div className="style-row">
                    <label>예배시간(rem):</label>
                    <input
                      type="number"
                      step="0.2"
                      value={styles.worshipTimeSizeRem}
                      onChange={(e) =>
                        setStyles({ ...styles, worshipTimeSizeRem: Number(e.target.value) })
                      }
                    />
                  </div>
                </div>

                <div className="style-row checkbox-row">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={styles.showWorshipSeconds}
                      onChange={(e) =>
                        setStyles({ ...styles, showWorshipSeconds: e.target.checked })
                      }
                    />
                    <span>예배순서 상단 시간에 초 표시</span>
                  </label>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={styles.countdownSound}
                      onChange={(e) =>
                        setStyles({ ...styles, countdownSound: e.target.checked })
                      }
                    />
                    <span>카운트다운 음성 (십~일, 0 제외)</span>
                  </label>
                </div>

                <div className="style-row opacity-row">
                  <label>배경투명도:</label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={styles.bgOpacity}
                    onChange={(e) =>
                      setStyles({ ...styles, bgOpacity: Number(e.target.value) })
                    }
                  />
                  <span className="opacity-val">{styles.bgOpacity}%</span>

                  <label className="opacity-sub-label">글자투명도:</label>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={styles.textOpacity}
                    onChange={(e) =>
                      setStyles({ ...styles, textOpacity: Number(e.target.value) })
                    }
                  />
                  <span className="opacity-val">{styles.textOpacity}%</span>
                </div>
              </div>

              <div className="setting-box preview-box-wrapper">
                <div className="setting-label">
                  <strong>설정 4</strong>{' '}
                  <span>
                    미리보기 ({previewStageIndex + 1}/{stages.length} ·{' '}
                    {stages[previewStageIndex]?.label})
                  </span>
                </div>
                <div className="preview-stage-nav">
                  <button
                    type="button"
                    className="preview-step-btn"
                    onClick={() => handlePreviewStep(-1)}
                    title="이전 상황 미리보기"
                  >
                    ◀ 전
                  </button>
                  <div ref={previewBoxRef} className="preview-viewport">
                    {renderPresentationScreen(previewStageIndex, true)}
                  </div>
                  <button
                    type="button"
                    className="preview-step-btn"
                    onClick={() => handlePreviewStep(1)}
                    title="다음 상황 미리보기"
                  >
                    후 ▶
                  </button>
                </div>
              </div>

              <div className="setting-box action-bar-wrapper">
                <button
                  type="button"
                  className="mode-action-btn"
                  onClick={handleStartRealCount}
                >
                  실제카운트
                </button>
                <button
                  type="button"
                  className="mode-action-btn"
                  onClick={handleStartPracticeCount}
                >
                  연습카운트
                </button>
                <button
                  type="button"
                  className="mode-action-btn primary"
                  onClick={handleOpenPracticeFullscreen}
                >
                  연습전체화면
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}