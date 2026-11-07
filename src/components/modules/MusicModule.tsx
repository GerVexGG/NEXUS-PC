import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Crosshair,
  Disc3,
  FileText,
  Loader2,
  Music,
  Music2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Sparkles,
} from "lucide-react";
import { useMediaSession } from "../../hooks/useMediaSession";
import { useLyrics } from "../../hooks/useLyrics";

function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function formatSourceLabel(rawAppId: string): string {
  const trimmed = (rawAppId || "").trim();
  if (!trimmed) return "YouTube Music Desktop";
  const lower = trimmed.toLowerCase();
  if (lower.includes("youtube") || lower.includes("ytmd") || lower.includes("th-ch")) {
    return "YouTube Music Desktop";
  }
  if (lower.includes("spotify")) return "Spotify";
  if (lower.includes("yandex")) return "Яндекс Музыка";
  if (lower.includes("apple") || lower.includes("itunes")) return "Apple Music";
  if (lower.includes("aimp")) return "AIMP";
  if (lower.includes("foobar")) return "foobar2000";
  if (lower.includes("vlc")) return "VLC Media Player";
  const cleaned = trimmed.replace(/\.exe$/i, "");
  const parts = cleaned.split(/[\\/!]/);
  return parts[parts.length - 1] || trimmed;
}

export function MusicModule() {
  const {
    track,
    isPlaying,
    position,
    duration,
    togglePlay,
    nextTrack,
    prevTrack,
    seekTo,
  } = useMediaSession(true);

  const {
    lyrics,
    currentLineIndex,
    loading: lyricsLoading,
    offsetSecs,
    setOffsetSecs,
  } = useLyrics(
    track?.artist ?? "",
    track?.title ?? "",
    duration,
    position
  );

  const [subView, setSubView] = useState<"now-playing" | "lyrics">("now-playing");
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);

  const lyricsContainerRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const pauseTimeoutRef = useRef<number | null>(null);

  const triggerManualScrollPause = () => {
    setAutoScrollPaused(true);
    if (pauseTimeoutRef.current !== null) {
      window.clearTimeout(pauseTimeoutRef.current);
    }
    pauseTimeoutRef.current = window.setTimeout(() => {
      setAutoScrollPaused(false);
      pauseTimeoutRef.current = null;
    }, 5000);
  };

  useEffect(() => {
    return () => {
      if (pauseTimeoutRef.current !== null) {
        window.clearTimeout(pauseTimeoutRef.current);
      }
    };
  }, []);

  const scrollToActiveLine = (behavior: ScrollBehavior = "smooth") => {
    if (currentLineIndex < 0) return;
    const lineEl = lineRefs.current.get(currentLineIndex);
    if (lineEl) {
      lineEl.scrollIntoView({
        behavior,
        block: "center",
      });
    }
  };

  // Плавное удержание активной строки ближе к вертикальному центру контейнера
  useEffect(() => {
    if (subView !== "lyrics" || autoScrollPaused || currentLineIndex < 0) {
      return;
    }
    scrollToActiveLine("smooth");
  }, [currentLineIndex, subView, autoScrollPaused]);

  const handleResumeAutoScroll = () => {
    if (pauseTimeoutRef.current !== null) {
      window.clearTimeout(pauseTimeoutRef.current);
      pauseTimeoutRef.current = null;
    }
    setAutoScrollPaused(false);
    scrollToActiveLine("smooth");
  };

  const progressPct =
    duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;

  const formattedOffset =
    offsetSecs === 0
      ? "0.0s"
      : `${offsetSecs > 0 ? "+" : ""}${offsetSecs.toFixed(1)}s`;

  return (
    <motion.div
      key="music-module"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="relative w-full max-w-6xl overflow-hidden rounded-2xl border border-[#222b38] bg-[#0d121b] p-5 sm:p-6"
    >
      {/* Фоновый амбиент (Ambient Backdrop) из обложки трека */}
      {track?.cover_base64 && (
        <div
          className="absolute inset-0 bg-cover bg-center filter blur-[60px] opacity-15 pointer-events-none scale-110 transition-all duration-700"
          style={{ backgroundImage: `url(${track.cover_base64})` }}
        />
      )}

      <div className="relative z-10 space-y-5">
        {/* Шапка модуля */}
        <div className="flex flex-col justify-between gap-4 border-b border-[#222b38] pb-4 lg:flex-row lg:items-center">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-100">
                NEXUS Music
              </h2>
              {track && (
                <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                  {formatSourceLabel(track.source_app_id)}
                </span>
              )}
            </div>
            <p className="mt-1 truncate text-sm text-slate-400">
              {track
                ? `${track.title || "Без названия"} — ${track.artist || "Неизвестный исполнитель"}`
                : "Управление Windows Media (GSMTC) и синхронизированная лирика LRCLIB"}
            </p>
          </div>

          {/* Табы-чипы переключения представления */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setSubView("now-playing")}
              className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-medium transition-colors cursor-pointer ${
                subView === "now-playing"
                  ? "border-cyan-500/35 bg-cyan-500/15 text-cyan-300"
                  : "border-[#222b38] bg-[#111722] text-slate-400 hover:text-slate-200"
              }`}
            >
              <Disc3 size={14} className={isPlaying ? "animate-spin" : ""} />
              <span>Сейчас играет</span>
            </button>
            <button
              type="button"
              onClick={() => setSubView("lyrics")}
              className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-medium transition-colors cursor-pointer ${
                subView === "lyrics"
                  ? "border-indigo-500/35 bg-indigo-500/15 text-indigo-300"
                  : "border-[#222b38] bg-[#111722] text-slate-400 hover:text-slate-200"
              }`}
            >
              <Sparkles size={14} />
              <span>Текст песни (Lyrics)</span>
              {lyrics?.isSynced && (
                <span className="rounded-md border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
                  SYNC
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Режим ожидания (Empty State), если активной сессии нет */}
        {!track ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-[#222b38] bg-[#111722] px-6 py-20 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-[#222b38] bg-[#151c27] text-cyan-400">
              <Disc3 size={34} className="animate-pulse" />
            </div>
            <h3 className="text-lg font-semibold text-slate-100">
              Медиасессия не обнаружена
            </h3>
            <p className="mt-2 max-w-md text-sm text-slate-400">
              Запустите YouTube Music Desktop или любой плеер с поддержкой Windows Media, чтобы активировать управление и синхронизацию текста
            </p>
          </div>
        ) : subView === "now-playing" ? (
          /* Представление «Сейчас играет» (Now Playing View) */
          <div className="flex flex-col items-center rounded-xl border border-[#222b38] bg-[#111722]/90 px-6 py-8 sm:px-10 sm:py-10">
            {/* Крупная обложка альбома */}
            <div className="relative flex w-full max-w-[320px] items-center justify-center">
              {track.cover_base64 ? (
                <img
                  src={track.cover_base64}
                  alt={track.title || "Album Art"}
                  className="w-full max-w-[320px] aspect-square rounded-2xl border border-white/10 object-cover shadow-2xl"
                />
              ) : (
                <div className="flex w-full max-w-[320px] aspect-square flex-col items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-[#151c27] to-[#0e131c] shadow-2xl">
                  <Disc3
                    size={76}
                    className={`text-cyan-400/70 ${isPlaying ? "animate-spin" : ""}`}
                  />
                  <span className="mt-3 font-mono text-xs uppercase tracking-widest text-slate-500">
                    NEXUS AUDIO
                  </span>
                </div>
              )}
            </div>

            {/* Метаданные трека */}
            <div className="mt-6 max-w-xl text-center">
              <h3 className="text-2xl font-bold text-slate-100">
                {track.title || "Без названия"}
              </h3>
              <p className="mt-1.5 text-lg font-medium text-cyan-400">
                {track.artist || "Неизвестный исполнитель"}
              </p>
              {track.album && (
                <p className="mt-1 text-sm text-slate-400">{track.album}</p>
              )}
            </div>

            {/* Интерактивный таймлайн */}
            <div className="mt-7 w-full max-w-xl space-y-2">
              <div className="relative flex items-center">
                <div className="relative h-2 w-full overflow-hidden rounded-full bg-[#182130]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-cyan-400 to-emerald-400 transition-all duration-300"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={duration > 0 ? duration : 100}
                  step={0.5}
                  value={duration > 0 ? Math.min(duration, position) : 0}
                  disabled={duration <= 0}
                  onChange={(e) => {
                    const target = parseFloat(e.target.value);
                    if (!Number.isNaN(target)) {
                      void seekTo(target);
                    }
                  }}
                  aria-label="Позиция воспроизведения"
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
                />
              </div>
              <div className="flex items-center justify-between font-mono text-xs tabular-nums text-slate-400">
                <span>{formatMediaTime(position)}</span>
                <span>{formatMediaTime(duration)}</span>
              </div>
            </div>

            {/* Панель управления воспроизведением */}
            <div className="mt-6 flex items-center justify-center gap-5">
              <button
                type="button"
                onClick={() => void prevTrack()}
                title="Предыдущий трек"
                className="flex h-11 w-11 items-center justify-center rounded-full border border-[#222b38] bg-[#151c27] text-slate-200 transition-colors hover:border-cyan-500/40 hover:bg-cyan-500/10 hover:text-cyan-300 cursor-pointer"
              >
                <SkipBack size={18} />
              </button>

              <button
                type="button"
                onClick={() => void togglePlay()}
                title={isPlaying ? "Пауза" : "Воспроизвести"}
                className="flex h-14 w-14 items-center justify-center rounded-full border border-cyan-400/40 bg-gradient-to-br from-indigo-500/30 via-cyan-500/25 to-emerald-500/25 text-white shadow-[0_0_24px_rgba(34,211,238,0.25)] transition-transform active:scale-95 hover:border-cyan-300/70 cursor-pointer"
              >
                {isPlaying ? <Pause size={24} /> : <Play size={24} className="ml-0.5" />}
              </button>

              <button
                type="button"
                onClick={() => void nextTrack()}
                title="Следующий трек"
                className="flex h-11 w-11 items-center justify-center rounded-full border border-[#222b38] bg-[#151c27] text-slate-200 transition-colors hover:border-cyan-500/40 hover:bg-cyan-500/10 hover:text-cyan-300 cursor-pointer"
              >
                <SkipForward size={18} />
              </button>
            </div>
          </div>
        ) : (
          /* Представление «Текст песни» (Synced Lyrics View) */
          <div className="space-y-4">
            <div className="relative overflow-hidden rounded-xl border border-[#222b38] bg-[#111722]/90">
              {lyricsLoading ? (
                <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
                  <Loader2 size={28} className="animate-spin text-cyan-400" />
                  <p className="mt-3 text-sm text-slate-300">
                    Поиск синхронизированного текста в LRCLIB...
                  </p>
                </div>
              ) : lyrics?.isInstrumental ? (
                <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-500/10 text-indigo-300">
                    <Music2 size={24} />
                  </div>
                  <h3 className="text-base font-semibold text-slate-100">
                    Инструментальная композиция — текст отсутствует
                  </h3>
                  <p className="mt-1 text-xs text-slate-400">
                    В базе LRCLIB этот трек отмечен как инструментальный
                  </p>
                </div>
              ) : lyrics?.isSynced && lyrics.lines.length > 0 ? (
                <div
                  ref={lyricsContainerRef}
                  onWheel={triggerManualScrollPause}
                  onTouchMove={triggerManualScrollPause}
                  className="scrollbar-none relative h-[420px] overflow-y-auto px-6 py-12 sm:px-10"
                >
                  <div className="space-y-5">
                    {lyrics.lines.map((line, index) => {
                      const active = index === currentLineIndex;
                      return (
                        <button
                          key={`${index}-${line.time}`}
                          ref={(node) => {
                            if (node) lineRefs.current.set(index, node);
                            else lineRefs.current.delete(index);
                          }}
                          type="button"
                          onClick={() => {
                            handleResumeAutoScroll();
                            void seekTo(Math.max(0, line.time - offsetSecs));
                          }}
                          className={`block w-full text-left ${
                            active
                              ? "text-2xl sm:text-3xl font-bold text-white transition-all duration-300 transform scale-105 origin-left drop-shadow-[0_0_16px_rgba(56,189,248,0.3)]"
                              : "text-lg font-medium text-slate-500/60 hover:text-slate-300 transition-colors cursor-pointer"
                          }`}
                        >
                          {line.text || "♪"}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : lyrics?.plainText ? (
                <div className="scrollbar-none h-[420px] overflow-y-auto px-6 py-6 sm:px-10">
                  <div className="mb-4 inline-flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-300">
                    <FileText size={13} />
                    <span>Доступен только обычный текст (без временных меток)</span>
                  </div>
                  <div className="whitespace-pre-line text-base leading-relaxed text-slate-200">
                    {lyrics.plainText}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-[#222b38] bg-[#151c27] text-slate-400">
                    <Music size={24} />
                  </div>
                  <h3 className="text-base font-semibold text-slate-100">
                    Текст для этой композиции пока не добавлен в LRCLIB
                  </h3>
                  <p className="mt-1 text-xs text-slate-400">
                    {track.artist} — {track.title}
                  </p>
                </div>
              )}

              {/* Плавающая кнопка возврата к текущей строке при ручном скролле */}
              <AnimatePresence>
                {autoScrollPaused && lyrics?.isSynced && currentLineIndex >= 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 12 }}
                    className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center"
                  >
                    <button
                      type="button"
                      onClick={handleResumeAutoScroll}
                      className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-cyan-500/40 bg-[#0e131c]/95 px-4 py-2 text-xs font-medium text-cyan-300 shadow-lg backdrop-blur-md transition-colors hover:bg-cyan-500/20 cursor-pointer"
                    >
                      <Crosshair size={14} />
                      <span>Вернуться к текущей строке</span>
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Панель настройки синхронизации (Sync Offset) */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#222b38] bg-[#111722] px-4 py-3">
              <div className="flex items-center gap-2.5">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium ${
                    lyrics?.isSynced
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      : "border-[#222b38] bg-[#151c27] text-slate-400"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      lyrics?.isSynced ? "bg-emerald-400" : "bg-slate-500"
                    }`}
                  />
                  LRCLIB Synced
                </span>
                <span className="font-mono text-xs text-slate-400">
                  Сдвиг синхронизации:{" "}
                  <span className="text-slate-200">{formattedOffset}</span>
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOffsetSecs((prev) => prev - 0.5)}
                  className="rounded-lg border border-[#222b38] bg-[#151c27] px-2.5 py-1 font-mono text-xs text-slate-300 transition-colors hover:border-cyan-500/30 hover:text-cyan-300 cursor-pointer"
                >
                  -0.5s
                </button>
                <button
                  type="button"
                  onClick={() => setOffsetSecs(0)}
                  className="rounded-lg border border-[#222b38] bg-[#151c27] px-2.5 py-1 text-xs text-slate-300 transition-colors hover:border-indigo-500/30 hover:text-indigo-300 cursor-pointer"
                >
                  Сброс
                </button>
                <button
                  type="button"
                  onClick={() => setOffsetSecs((prev) => prev + 0.5)}
                  className="rounded-lg border border-[#222b38] bg-[#151c27] px-2.5 py-1 font-mono text-xs text-slate-300 transition-colors hover:border-cyan-500/30 hover:text-cyan-300 cursor-pointer"
                >
                  +0.5s
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
