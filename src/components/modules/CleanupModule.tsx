import { motion } from "framer-motion";
import { AlertTriangle, Check, CheckCircle2, Folder, Loader2, RefreshCw, Shield, ShieldCheck } from "lucide-react";
import { PageHeader, formatBytes, type CleanupCategory } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";
import reaperIcon from "../../assets/reaper.png";

type SafetyProfile = {
  sensitive: boolean;
  badge: string;
  badgeClass: string;
  description: string;
  shield?: boolean;
};

function cleanupSafety(id: string, isElevatedAdmin: boolean): SafetyProfile {
  if (id === "recycle_bin") {
    return {
      sensitive: true,
      badge: "Необратимое удаление",
      badgeClass: "border-amber-500/35 bg-amber-500/12 text-amber-300",
      description: "Содержимое Корзины Windows будет удалено без возможности восстановления.",
    };
  }
  if (id === "shader_cache") {
    return {
      sensitive: true,
      badge: "Перекомпиляция в играх",
      badgeClass: "border-amber-500/35 bg-amber-500/12 text-amber-300",
      description: "Кэш скомпилированных шейдеров DirectX/Vulkan. Игры пересоберут его при первом запуске.",
    };
  }
  if (id === "windows_update" && !isElevatedAdmin) {
    return {
      sensitive: true,
      badge: "Нужны права Администратора",
      badgeClass: "border-amber-500/35 bg-amber-500/12 text-amber-300",
      description: "Пакеты применённых обновлений Windows (SoftwareDistribution\\Download).",
      shield: true,
    };
  }
  if (id === "browser_cache") {
    return {
      sensitive: false,
      badge: "Безопасно",
      badgeClass: "border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8]",
      description: "Кэш изображений и скриптов браузеров. Пароли, вкладки и авторизация не затрагиваются.",
    };
  }
  if (id === "discord_cache") {
    return {
      sensitive: false,
      badge: "Безопасно",
      badgeClass: "border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8]",
      description: "Кэшированные медиафайлы и миниатюры клиента Discord.",
    };
  }
  if (id === "crash_dumps") {
    return {
      sensitive: false,
      badge: "Диагностика",
      badgeClass: "border-[#36AFC0]/30 bg-[#36AFC0]/10 text-[#36AFC0]",
      description: "Архивные дампы памяти и отчёты об ошибках приложений Windows (WER).",
    };
  }
  return {
    sensitive: false,
    badge: "Безопасно",
    badgeClass: "border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8]",
    description:
      id === "windows_update"
        ? "Установочные пакеты уже применённых обновлений операционной системы."
        : "Временные рабочие файлы системы и приложений. Личные данные не затрагиваются.",
  };
}

function formatSelectedGb(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
}

function CategoryCard({
  cat,
  checked,
  safety,
  totalJunkBytes,
  onToggle,
}: {
  cat: CleanupCategory;
  checked: boolean;
  safety: SafetyProfile;
  totalJunkBytes: number;
  onToggle: () => void;
}) {
  const ratio =
    totalJunkBytes > 0 ? Math.min(100, Math.max(0, (cat.size_bytes / totalJunkBytes) * 100)) : 0;

  return (
    <div
      onClick={onToggle}
      role="checkbox"
      aria-checked={checked}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onToggle();
        }
      }}
      className={`tactical-card tactical-brackets flex cursor-pointer flex-col justify-between gap-3 rounded-xl p-4 transition-all ${
        checked
          ? safety.sensitive
            ? "border-amber-500/45 bg-[#151C26]/90"
            : "border-[#00D5E8]/45 bg-[#151C26]/90"
          : "hover:border-[#202B38]"
      }`}
    >
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                checked
                  ? safety.sensitive
                    ? "border-amber-400 bg-amber-500/20 text-amber-300"
                    : "border-[#00D5E8] bg-[#00D5E8]/20 text-[#00D5E8]"
                  : "border-[#202B38] bg-[#0B0E14] text-transparent"
              }`}
            >
              <Check size={12} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-[#E5EDF5]">{cat.name}</span>
                <span
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium ${safety.badgeClass}`}
                >
                  {safety.shield && <Shield size={10} />}
                  {safety.badge}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-[#8292A3]">
                {safety.description || cat.description}
              </p>
            </div>
          </div>

          <div className="shrink-0 text-right">
            <div className="font-mono text-base font-bold text-[#E5EDF5]">
              {formatBytes(cat.size_bytes)}
            </div>
            <div className="font-mono text-[11px] text-[#526170]">
              {cat.files_count.toLocaleString("ru-RU")} файл.
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 text-[11px] text-[#526170]">
          <span className="inline-flex items-center gap-1 truncate font-mono" title={cat.paths_hint}>
            <Folder size={11} className="shrink-0" />
            <span className="truncate">{cat.paths_hint}</span>
          </span>
          <span className="shrink-0 font-mono">{ratio.toFixed(0)}% объёма</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[#0B0E14]">
          <div
            className={`h-full transition-all duration-300 ${
              safety.sensitive
                ? "bg-amber-400"
                : "bg-gradient-to-r from-[#00D5E8] to-[#36AFC0]"
            }`}
            style={{ width: `${ratio}%` }}
          />
        </div>
      </div>
    </div>
  );
}

export function CleanupModule({ c }: { c: NexusController }) {
  const {
    cleanupCategories,
    selectedCleanupIds,
    setSelectedCleanupIds,
    isScanningCleanup,
    isCleaning,
    confirmCleanupOpen,
    setConfirmCleanupOpen,
    cleanupReport,
    cleanupError,
    handleScanCleanup,
    handleToggleCleanupCategory,
    handleExecuteCleanup,
    selectedCleanupBytes,
    isElevatedAdmin,
  } = c;

  const totalJunkBytes = cleanupCategories.reduce((sum, cat) => sum + cat.size_bytes, 0);
  const totalFilesCount = cleanupCategories.reduce((sum, cat) => sum + cat.files_count, 0);
  const isZeroJunkFound = cleanupCategories.length > 0 && totalJunkBytes === 0;
  const showResultBanner = cleanupReport !== null || isZeroJunkFound;
  const freedGbText = cleanupReport
    ? (cleanupReport.freed_bytes / (1024 * 1024 * 1024)).toFixed(2)
    : "0.00";

  const safeCategories = cleanupCategories.filter(
    (cat) => !cleanupSafety(cat.id, isElevatedAdmin).sensitive
  );
  const sensitiveCategories = cleanupCategories.filter(
    (cat) => cleanupSafety(cat.id, isElevatedAdmin).sensitive
  );

  return (
    <motion.div
      key="cleanup"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="w-full space-y-4 pb-24"
    >
      <PageHeader
        title="Центр очистки"
        description="Интеллектуальный анализ и удаление временного кэша, дампов и остаточных файлов Windows"
        actions={
          <button
            type="button"
            disabled={isScanningCleanup || isCleaning}
            onClick={() => void handleScanCleanup()}
            className="cyber-btn inline-flex cursor-pointer items-center gap-2 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-[#00D5E8] disabled:opacity-60"
          >
            <RefreshCw size={14} className={isScanningCleanup ? "animate-spin" : ""} />
            {isScanningCleanup ? "Анализ накопителей…" : "Проверить систему"}
          </button>
        }
      />

      {cleanupError && (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/12 px-4 py-2.5 text-sm text-rose-300">
          {cleanupError}
        </div>
      )}

      {/* Сводный блок результатов сканирования / очистки */}
      {cleanupCategories.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="tactical-card rounded-xl p-4">
            <div className="text-xs font-medium text-[#8292A3]">Обнаружено временных данных</div>
            <div className="mt-1 font-mono text-2xl font-bold text-[#E5EDF5]">
              {formatBytes(totalJunkBytes)}
            </div>
            <div className="mt-0.5 text-xs text-[#526170]">
              Файлов в индексе: {totalFilesCount.toLocaleString("ru-RU")}
            </div>
          </div>

          <div className="tactical-card rounded-xl p-4">
            <div className="text-xs font-medium text-[#8292A3]">Выбрано к удалению</div>
            <div className="mt-1 font-mono text-2xl font-bold text-[#00D5E8]">
              {formatBytes(selectedCleanupBytes)}
            </div>
            <div className="mt-0.5 text-xs text-[#526170]">
              Отмечено категорий: {selectedCleanupIds.length} из {cleanupCategories.length}
            </div>
          </div>

          <div className="tactical-card rounded-xl p-4">
            <div className="text-xs font-medium text-[#8292A3]">Статус очистки</div>
            <div className="mt-1 font-mono text-lg font-semibold text-[#E5EDF5]">
              {cleanupReport
                ? `Освобождено ${freedGbText} ГБ`
                : isZeroJunkFound
                ? "Система чиста"
                : "Готов к очистке"}
            </div>
            <div className="mt-0.5 text-xs text-[#526170]">
              {cleanupReport
                ? `Удалено файлов: ${cleanupReport.deleted_files_count}`
                : "Безопасные категории выбраны автоматически"}
            </div>
          </div>
        </div>
      )}

      {showResultBanner && (
        <div className="tactical-card tactical-brackets flex flex-col items-start gap-4 rounded-xl border-[#00D5E8]/35 p-5 sm:flex-row sm:items-center">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[#00D5E8]/40 bg-[#07080B]">
            <img src={reaperIcon} alt="NEXUS" className="h-full w-full object-cover" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded border border-[#00D5E8]/35 bg-[#00D5E8]/12 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-[#00D5E8]">
                <CheckCircle2 size={11} /> ОПЕРАЦИЯ ЗАВЕРШЕНА
              </span>
              <span className="text-xs text-[#8292A3]">Целостность системных файлов сохранена</span>
            </div>
            <div className="mt-1.5 font-mono text-xl font-bold tracking-tight text-[#E5EDF5]">
              {cleanupReport
                ? `Освобождено ${freedGbText} ГБ дискового пространства`
                : "Временный файловый мусор не обнаружен"}
            </div>
            {cleanupReport ? (
              <p className="mt-1 font-mono text-xs text-[#8292A3]">
                Удалено файлов: <span className="text-[#00D5E8]">{cleanupReport.deleted_files_count}</span>
                {" · "}Занято активными процессами (пропущено): {cleanupReport.skipped_files_count}
                {" · "}Точный объём: {formatBytes(cleanupReport.freed_bytes)}
              </p>
            ) : (
              <p className="mt-1 text-xs text-[#8292A3]">
                Все проверенные директории кэша и временных файлов находятся в оптимальном состоянии.
              </p>
            )}
          </div>
        </div>
      )}

      {cleanupCategories.length === 0 ? (
        <div className="tactical-card flex flex-col items-center rounded-xl px-6 py-14 text-center">
          <ShieldCheck size={28} className="mb-3 text-[#00D5E8]" />
          <div className="text-base font-semibold text-[#E5EDF5]">
            Анализ временных файлов ещё не выполнен
          </div>
          <p className="mt-1 max-w-md text-xs text-[#8292A3]">
            Нажмите «Проверить систему» в правом верхнем углу для подсчёта объёма кэша браузеров, временных папок и диагностических отчётов.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Блок 1: Безопасные категории */}
          {safeCategories.length > 0 && (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 px-1">
                <ShieldCheck size={15} className="text-[#00D5E8]" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#E5EDF5]">
                  Безопасная очистка (Рекомендуется)
                </h3>
                <span className="text-xs text-[#8292A3]">
                  · Не затрагивает пользовательские документы и настройки
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {safeCategories.map((cat) => (
                  <CategoryCard
                    key={cat.id}
                    cat={cat}
                    checked={selectedCleanupIds.includes(cat.id)}
                    safety={cleanupSafety(cat.id, isElevatedAdmin)}
                    totalJunkBytes={totalJunkBytes}
                    onToggle={() => handleToggleCleanupCategory(cat.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Блок 2: Чувствительные операции */}
          {sensitiveCategories.length > 0 && (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 px-1">
                <AlertTriangle size={15} className="text-amber-400" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-300">
                  Операции, требующие внимания
                </h3>
                <span className="text-xs text-[#8292A3]">
                  · Безвозвратное удаление из Корзины или пересборка игрового кэша
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {sensitiveCategories.map((cat) => (
                  <CategoryCard
                    key={cat.id}
                    cat={cat}
                    checked={selectedCleanupIds.includes(cat.id)}
                    safety={cleanupSafety(cat.id, isElevatedAdmin)}
                    totalJunkBytes={totalJunkBytes}
                    onToggle={() => handleToggleCleanupCategory(cat.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Нижняя панель действий */}
      <div className="tactical-card sticky bottom-3 z-20 flex flex-col gap-3 rounded-xl border-[#202B38] bg-[#0B0E14]/95 p-4 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="text-xs text-[#8292A3]">
            Итого к освобождению:{" "}
            <span className="font-mono text-base font-bold text-[#00D5E8]">
              {formatSelectedGb(selectedCleanupBytes)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setConfirmCleanupOpen(false);
              setSelectedCleanupIds(
                cleanupCategories
                  .filter((cat) => !cleanupSafety(cat.id, isElevatedAdmin).sensitive)
                  .map((cat) => cat.id)
              );
            }}
            className="cursor-pointer rounded-lg border border-[#202B38] bg-[#10151D] px-3.5 py-2 text-xs font-medium text-[#8292A3] transition-colors hover:border-[#00D5E8]/40 hover:text-[#E5EDF5]"
          >
            Выбрать только безопасные
          </button>
          {!confirmCleanupOpen ? (
            <button
              type="button"
              disabled={selectedCleanupIds.length === 0 || isCleaning}
              onClick={() => setConfirmCleanupOpen(true)}
              className="cyber-btn-danger cursor-pointer px-5 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-rose-200 disabled:opacity-40"
            >
              Очистить выбранное
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={isCleaning}
                onClick={() => void handleExecuteCleanup()}
                className="cyber-btn-danger inline-flex cursor-pointer items-center gap-2 px-5 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-rose-200"
              >
                {isCleaning && <Loader2 size={13} className="animate-spin" />}
                Подтвердить удаление
              </button>
              <button
                type="button"
                onClick={() => setConfirmCleanupOpen(false)}
                className="cursor-pointer rounded-lg border border-[#202B38] bg-[#10151D] px-3.5 py-2 text-xs font-medium text-[#8292A3] hover:text-[#E5EDF5]"
              >
                Отмена
              </button>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}
