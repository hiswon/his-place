import React, { useState, useEffect, useRef, useMemo } from 'react';
import './Page15.css';

interface StyleConfig {
  welcomeSize: number;
  welcomeColor: string;
  titleSize: number;
  titleColor: string;
  contentSize: number;
  contentColor: string;
  dateSize: number;
  dateColor: string;
  timeSize: number;
  timeColor: string;
  worshipDateSize: number;
  worshipTimeSize: number;
  showWorshipSeconds: boolean;
  textOpacity: number;
  bgColor: string;
  bgOpacity: number;
}

interface ColorPreset {
  name: string;
  bgColor: string;
  welcomeColor: string;
  titleColor: string;
  contentColor: string;
  dateColor: string;
  timeColor: string;
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

const COLOR_PRESETS: ColorPreset[] = [
  {
    name: '1. 화이트/검정',
    bgColor: '#ffffff',
    welcomeColor: '#000000',
    titleColor: '#000000',
    contentColor: '#000000',
    dateColor: '#000000',
    timeColor: '#000000',
  },
  {
    name: '2. 검정/흰색',
    bgColor: '#000000',
    welcomeColor: '#ffffff',
    titleColor: '#ffffff',
    contentColor: '#ffffff',
    dateColor: '#ffffff',
    timeColor: '#ffffff',
  },
  {
    name: '3. 네이비 골드',
    bgColor: '#0b1d3a',
    welcomeColor: '#ffd166',
    titleColor: '#ffd166',
    contentColor: '#f8fafc',
    dateColor: '#e2e8f0',
    timeColor: '#ffd166',
  },
  {
    name: '4. 포레스트 크림',
    bgColor: '#122b22',
    welcomeColor: '#f4f1ea',
    titleColor: '#a7f3d0',
    contentColor: '#f4f1ea',
    dateColor: '#d1fae5',
    timeColor: '#f4f1ea',
  },
  {
    name: '5. 버건디 아이보리',
    bgColor: '#3b0d1b',
    welcomeColor: '#fff8ee',
    titleColor: '#fde68a',
    contentColor: '#fff8ee',
    dateColor: '#f3d5de',
    timeColor: '#fde68a',
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

// HEX 색상을 RGBA 문자열로 변환
const hexToRgba = (hex: string, opacityPercent: number): string => {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  const num = parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  const a = Math.max(0, Math.min(100, opacityPercent)) / 100;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
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

  const [styles, setStyles] = useState<StyleConfig>({
    welcomeSize: 115,
    welcomeColor: '#ffffff',
    titleSize: 58,
    titleColor: '#ffffff',
    contentSize: 114,
    contentColor: '#ffffff',
    dateSize: 196,
    dateColor: '#ffffff',
    timeSize: 239,
    timeColor: '#ffffff',
    worshipDateSize: 52,
    worshipTimeSize: 44,
    showWorshipSeconds: false,
    textOpacity: 100,
    bgColor: '#000000',
    bgOpacity: 100,
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

  // 현재 실제 연도 기준 (올해 -> 내년)
  const baseYear = useMemo(() => new Date().getFullYear(), []);

  // 화면 단계 인덱스 및 미리보기 상태
  const [stageIndex, setStageIndex] = useState<number>(0);
  const [previewStageIndex, setPreviewStageIndex] = useState<number>(0);
  const [fireworksTriggered, setFireworksTriggered] = useState<boolean>(false);

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
    const list: StageInfo[] = [
      { type: 'clock', label: `${baseYear}.12.31 시계 화면` },
      { type: 'countdown', label: `카운트다운` },
      { type: 'midnight', label: `${baseYear + 1}.1.1 00:00:00 자정` },
    ];

    welcomeSlides.forEach((_, idx) => {
      list.push({
        type: 'welcome',
        welcomeIdx: idx,
        label: `환영멘트 ${idx + 1}`,
      });
    });

    worshipItems.forEach((item, wIdx) => {
      if (item.slides.length === 0) {
        list.push({
          type: 'worship',
          worshipIdx: wIdx,
          slideIdx: -1,
          label: `${item.title} (제목)`,
        });
      } else {
        item.slides.forEach((_, sIdx) => {
          list.push({
            type: 'worship',
            worshipIdx: wIdx,
            slideIdx: sIdx,
            label: `${item.title} (${sIdx + 1}/${item.slides.length})`,
          });
        });
      }
    });

    return list;
  }, [baseYear, welcomeSlides, worshipItems]);

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

  // 100ms 단위 타이머 루프 & 자동 전환 로직
  useEffect(() => {
    const timer = setInterval(() => {
      const realNow = new Date();
      setNow(realNow);

      const activeTime =
        simOffsetMs !== null
          ? new Date(simOffsetMs + (realNow.getTime() - simStartRealMs))
          : realNow;

      const year = activeTime.getFullYear();
      const month = activeTime.getMonth() + 1;
      const date = activeTime.getDate();
      const hours = activeTime.getHours();
      const minutes = activeTime.getMinutes();
      const seconds = activeTime.getSeconds();

      // 올해 12월 31일 23:59:50 ~ 23:59:59 -> 자동으로 카운트다운 진입
      if (
        year === baseYear &&
        month === 12 &&
        date === 31 &&
        hours === 23 &&
        minutes === 59 &&
        seconds >= 50
      ) {
        setStageIndex((prev) => (prev < 1 ? 1 : prev));
        setPreviewStageIndex((prev) => (prev < 1 ? 1 : prev));
      }

      // 내년 1월 1일 00:00:00 정각 -> 자동으로 자정 화면 및 폭죽 실행
      if (
        year === baseYear + 1 &&
        month === 1 &&
        date === 1 &&
        hours === 0 &&
        minutes === 0 &&
        seconds === 0
      ) {
        setStageIndex((prev) => (prev < 2 ? 2 : prev));
        setPreviewStageIndex((prev) => (prev < 2 ? 2 : prev));
        setFireworksTriggered(true);
      }
    }, 100);

    return () => clearInterval(timer);
  }, [baseYear, simOffsetMs, simStartRealMs]);

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
      dateColor: preset.dateColor,
      timeColor: preset.timeColor,
    }));
  };

  // a. 실제카운트 버튼
  const handleStartRealCount = () => {
    const realNow = new Date();
    setNow(realNow);
    setSimOffsetMs(null);
    setStageIndex(0);
    setPreviewStageIndex(0);
    setFireworksTriggered(false);
    setIsSettingsOpen(false);
  };

  // b. 연습카운트 버튼 (올해 12/31 23:59:40부터 시작)
  const handleStartPracticeCount = () => {
    const target = new Date(baseYear, 11, 31, 23, 59, 40, 0);
    setSimOffsetMs(target.getTime());
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

    const countdownNum = d.getSeconds() === 0 ? 0 : 60 - d.getSeconds();

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

    // 수정 2: 현재 제목(챕터) 안에서 내용이 바뀌는 슬라이드 순번(1부터 시작)
    const currentSlideDisplayNum =
      stage.type === 'worship' && stage.slideIdx !== undefined && stage.slideIdx >= 0
        ? stage.slideIdx + 1
        : 1;

    const bgRgba = hexToRgba(styles.bgColor, styles.bgOpacity);
    const contentOpacityVal = Math.max(0, Math.min(100, styles.textOpacity)) / 100;

    const stageBody = (
      <div
        className={`presentation-container ${isPreview ? 'is-preview' : 'is-fullscreen'}`}
        style={{ backgroundColor: bgRgba }}
      >
        {!isPreview && <FireworksCanvas active={fireworksTriggered} />}

        {stage.type === 'worship' && stage.worshipIdx !== undefined ? (
          <div className="worship-flex-layout" style={{ opacity: contentOpacityVal }}>
            <div className="worship-top-header">
              <span
                className="worship-header-date"
                style={{
                  fontSize: `${styles.worshipDateSize}px`,
                  color: styles.dateColor,
                }}
              >
                {currentDisplayTime.getFullYear() > baseYear
                  ? dateStr
                  : `${baseYear + 1}.1.1`}
              </span>
              <span
                className="worship-header-time"
                style={{
                  fontSize: `${styles.worshipTimeSize}px`,
                  color: styles.timeColor,
                }}
              >
                {styles.showWorshipSeconds ? fullTimeStr : hourMinStr}
              </span>
            </div>

            <div className="worship-title-section">
              <div
                className="display-worship-title"
                style={{
                  fontSize: `${styles.titleSize}px`,
                  color: styles.titleColor,
                }}
              >
                {worshipItems[stage.worshipIdx]?.title}
              </div>
            </div>

            <div className="worship-body-section">
              {stage.slideIdx !== undefined && stage.slideIdx >= 0 && (
                <div
                  className="display-worship-body"
                  style={{
                    fontSize: `${styles.contentSize}px`,
                    color: styles.contentColor,
                  }}
                >
                  {worshipItems[stage.worshipIdx]?.slides[stage.slideIdx]}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="presentation-content" style={{ opacity: contentOpacityVal }}>
            <div
              className="display-date"
              style={{
                fontSize: `${
                  stage.type === 'midnight' ? styles.dateSize * 1.35 : styles.dateSize
                }px`,
                color: styles.dateColor,
              }}
            >
              {simOffsetMs === null && stage.type === 'clock'
                ? dateStr
                : stage.type === 'clock' || stage.type === 'countdown'
                ? `${baseYear}.12.31`
                : stage.type === 'midnight' || stage.type === 'welcome'
                ? `${baseYear + 1}.1.1`
                : dateStr}
            </div>

            {stage.type === 'clock' && (
              <div
                className="display-main-clock"
                style={{ fontSize: `${styles.timeSize * 1.35}px`, color: styles.timeColor }}
              >
                {fullTimeStr}
              </div>
            )}

            {stage.type === 'countdown' && (
              <>
                <div
                  className="display-sub-clock"
                  style={{ fontSize: `${styles.timeSize * 0.55}px`, color: styles.timeColor }}
                >
                  {fullTimeStr}
                </div>
                <div
                  className="display-countdown-number"
                  style={{ fontSize: `${styles.timeSize * 2.4}px`, color: styles.timeColor }}
                >
                  {countdownNum}
                </div>
              </>
            )}

            {stage.type === 'midnight' && (
              <div
                className="display-midnight-clock"
                style={{ fontSize: `${styles.timeSize * 0.85}px`, color: styles.timeColor }}
              >
                {fullTimeStr}
              </div>
            )}

            {stage.type === 'welcome' && stage.welcomeIdx !== undefined && (
              <>
                <div
                  className="display-welcome-clock"
                  style={{
                    fontSize: `${styles.timeSize * 0.65}px`,
                    color: styles.timeColor,
                  }}
                >
                  {fullTimeStr}
                </div>
                <div
                  className="display-welcome-text"
                  style={{
                    fontSize: `${styles.welcomeSize}px`,
                    color: styles.welcomeColor,
                  }}
                >
                  {welcomeSlides[stage.welcomeIdx]}
                </div>
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
              설정창 ({baseYear} → {baseYear + 1})
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
                  placeholder="찬송/&#10;가사 1절/&#10;가사 2절/&#10;;&#10;기도&#10;홍길동 집사/"
                />
              </div>
            </div>

            <div className="settings-col-right">
              <div className="setting-box style-box">
                <div className="setting-label">
                  <strong>설정 3</strong> <span>글자 크기 · 색상 · 투명도 설정</span>
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
                </div>

                <div className="style-grid-two-col">
                  <div className="style-row">
                    <label>환영멘트크기:</label>
                    <input
                      type="number"
                      value={styles.welcomeSize}
                      onChange={(e) =>
                        setStyles({ ...styles, welcomeSize: Number(e.target.value) })
                      }
                    />
                    <input
                      type="color"
                      value={styles.welcomeColor}
                      onChange={(e) => setStyles({ ...styles, welcomeColor: e.target.value })}
                    />
                  </div>

                  <div className="style-row">
                    <label>제목크기:</label>
                    <input
                      type="number"
                      value={styles.titleSize}
                      onChange={(e) =>
                        setStyles({ ...styles, titleSize: Number(e.target.value) })
                      }
                    />
                    <input
                      type="color"
                      value={styles.titleColor}
                      onChange={(e) => setStyles({ ...styles, titleColor: e.target.value })}
                    />
                  </div>

                  <div className="style-row">
                    <label>내용크기:</label>
                    <input
                      type="number"
                      value={styles.contentSize}
                      onChange={(e) =>
                        setStyles({ ...styles, contentSize: Number(e.target.value) })
                      }
                    />
                    <input
                      type="color"
                      value={styles.contentColor}
                      onChange={(e) => setStyles({ ...styles, contentColor: e.target.value })}
                    />
                  </div>

                  <div className="style-row">
                    <label>날짜크기:</label>
                    <input
                      type="number"
                      value={styles.dateSize}
                      onChange={(e) =>
                        setStyles({ ...styles, dateSize: Number(e.target.value) })
                      }
                    />
                    <input
                      type="color"
                      value={styles.dateColor}
                      onChange={(e) => setStyles({ ...styles, dateColor: e.target.value })}
                    />
                  </div>

                  <div className="style-row">
                    <label>시간크기:</label>
                    <input
                      type="number"
                      value={styles.timeSize}
                      onChange={(e) =>
                        setStyles({ ...styles, timeSize: Number(e.target.value) })
                      }
                    />
                    <input
                      type="color"
                      value={styles.timeColor}
                      onChange={(e) => setStyles({ ...styles, timeColor: e.target.value })}
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
                    <label>예배날짜크기:</label>
                    <input
                      type="number"
                      value={styles.worshipDateSize}
                      onChange={(e) =>
                        setStyles({ ...styles, worshipDateSize: Number(e.target.value) })
                      }
                    />
                  </div>

                  <div className="style-row">
                    <label>예배시간크기:</label>
                    <input
                      type="number"
                      value={styles.worshipTimeSize}
                      onChange={(e) =>
                        setStyles({ ...styles, worshipTimeSize: Number(e.target.value) })
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
                    <span>예배순서 상단 시간에 초 표시 (시:분:초)</span>
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

                  <label style={{ marginLeft: '10px' }}>글자투명도:</label>
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
                  <span>미리보기창 ({stages[previewStageIndex]?.label})</span>
                </div>
                <div ref={previewBoxRef} className="preview-viewport">
                  {renderPresentationScreen(previewStageIndex, true)}
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