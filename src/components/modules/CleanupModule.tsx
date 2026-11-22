import { ModuleHeader } from "../ui/ModuleHeader";
import { AlertTriangle, CheckCircle2, Folder, Loader2, RefreshCw, Shield, Trash2 } from "lucide-react";
import { formatBytes, type CleanupCategory } from "../../lib/studio";
import { canSelectCleanup, recommendedCleanupIds, requiresCleanupReview } from "../../lib/cleanupSelection";
import type { NexusController } from "../../hooks/useNexusController";
import { UtilityConfirmDialog } from "../ui/UtilityConfirmDialog";

const cleanupConsequences: Record<string, string> = {
  recycle_bin: "Файлы из Корзины будут удалены без возможности восстановления из неё.",
  shader_cache: "Игры пересоберут кэш при запуске. Первые запуски могут занять больше времени.",
  crash_dumps: "Сохранённые отчёты и дампы больше нельзя будет использовать для диагностики этих сбоев.",
  windows_update: "Windows сможет повторно загрузить пакеты обновлений, если они понадобятся.",
  thumbnails: "Проводник пересоздаст миниатюры при просмотре папок.",
};

function CategoryRow({
  category, checked, disabled, onToggle,
}: {
  category: CleanupCategory;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="avs-category grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 hover:bg-[#e5edf5]/4 has-disabled:cursor-default">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        className="mt-1 size-4 accent-[#00cadd]"
      />
      <div className="min-w-0">
        <p className="text-sm font-medium text-[#E5EDF5]">{category.name}</p>
        <p className="mt-1 text-xs leading-relaxed text-[#a0adbb]">{category.description}</p>
        {cleanupConsequences[category.id] && (
          <p className="mt-1 text-xs leading-relaxed text-[#b7c3d0]">{cleanupConsequences[category.id]}</p>
        )}
        <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-[#a0adbb]">
          <Folder size={12} className="shrink-0" />
          <span className="truncate font-mono" title={category.paths_hint}>{category.paths_hint}</span>
        </p>
        {category.requires_admin && (
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-200">
            <Shield size={12} /> Требуются права администратора
          </p>
        )}
      </div>
      <div className="text-right">
        <p className="font-mono text-sm tabular-nums text-[#E5EDF5]">{formatBytes(category.size_bytes)}</p>
        <p className="mt-1 text-xs tabular-nums text-[#a0adbb]">{category.files_count.toLocaleString("ru-RU")} файл.</p>
      </div>
    </label>
  );
}

export function CleanupModule({ c }: { c: NexusController }) {
  const {
    cleanupCategories, selectedCleanupIds, setSelectedCleanupIds, isScanningCleanup, isCleaning,
    confirmCleanupOpen, setConfirmCleanupOpen, cleanupReport, cleanupError,
    handleScanCleanup, handleToggleCleanupCategory, handleExecuteCleanup, isElevatedAdmin,
  } = c;
  const busy = isScanningCleanup || isCleaning;
  const selected = cleanupCategories.filter((category) =>
    selectedCleanupIds.includes(category.id) && canSelectCleanup(category, isElevatedAdmin)
  );
  const selectedBytes = selected.reduce((sum, category) => sum + category.size_bytes, 0);
  const total = cleanupCategories.reduce((sum, category) => sum + category.size_bytes, 0);
  const nonEmpty = cleanupCategories.some((category) => category.size_bytes > 0 || category.files_count > 0);

  return (
    <div className="avs-module avs-cleanup w-full space-y-4">
      <ModuleHeader module="cleanup"
        title="Центр очистки"
        description="Проверьте временные файлы и выберите категории для удаления"
        actions={
          <button type="button" disabled={busy} onClick={() => void handleScanCleanup()} className="nexus-button">
            <RefreshCw size={15} className={isScanningCleanup ? "animate-spin" : undefined} />
            {isScanningCleanup ? "Проверка…" : "Проверить систему"}
          </button>
        }
      />

      {cleanupError && (
        <p role="alert" className="rounded-lg border border-rose-400/35 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">{cleanupError}</p>
      )}
      {cleanupReport && (
        <div role="status" className="nexus-panel flex items-start gap-3 p-4 text-sm">
          {cleanupReport.skipped_files_count > 0 ? (
            <AlertTriangle size={18} className="shrink-0 text-amber-300" />
          ) : (
            <CheckCircle2 size={18} className="shrink-0 text-emerald-300" />
          )}
          <div>
            <p className="font-medium text-[#E5EDF5]">
              {cleanupReport.skipped_files_count > 0 ? "Очистка завершилась с пропусками" : "Очистка завершена"}
            </p>
            <p className="mt-1 text-[#a0adbb]">
              Освобождено {formatBytes(cleanupReport.freed_bytes)} · удалено {cleanupReport.deleted_files_count.toLocaleString("ru-RU")} · пропущено {cleanupReport.skipped_files_count.toLocaleString("ru-RU")}
            </p>
          </div>
        </div>
      )}

      {cleanupCategories.length === 0 ? (
        <div className="avs-cleanup-welcome" role={busy ? "status" : undefined}>
          {busy ? <Loader2 size={20} className="shrink-0 animate-spin text-[#00D5E8]" /> : <Folder size={20} className="shrink-0 text-[#00D5E8]" />}
          <div>
            <h3 className="font-semibold text-[#E5EDF5]">{isScanningCleanup ? "Проверяем временные файлы" : cleanupError ? "Проверка недоступна" : "Данные для очистки ещё не проверены"}</h3>
            <p className="mt-1 text-sm text-[#a0adbb]">Проверка подсчитывает файлы и оценивает занимаемое место.</p>
          </div>
        </div>
      ) : (
        <div className="avs-cleanup-workspace">
        <section className="nexus-panel divide-y divide-[#202B38]" aria-busy={busy}>
          <div className="avs-cleanup-total">
            <h3 className="text-sm font-semibold text-[#E5EDF5]">Результат проверки</h3>
            <span role="status" className="text-sm tabular-nums text-[#a0adbb]">
              {!nonEmpty ? "Файлы в проверенных категориях не обнаружены" : <>Обнаружено <strong>{formatBytes(total)}</strong></>}
            </span>
          </div>
          {([false, true] as const).map((review) => {
            const categories = cleanupCategories.filter((category) => requiresCleanupReview(category.id) === review);
            if (categories.length === 0) return null;
            return (
              <section key={String(review)} className="divide-y divide-[#202B38]/65">
                <h4 className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-[#a0adbb]">
                  {review && <AlertTriangle size={13} className="text-amber-300" />}
                  {review ? "Выбор вручную" : "Временные файлы и кэш"}
                </h4>
                {categories.map((category) => (
                  <CategoryRow
                    key={category.id}
                    category={category}
                    checked={selectedCleanupIds.includes(category.id)}
                    disabled={busy || !canSelectCleanup(category, isElevatedAdmin)}
                    onToggle={() => handleToggleCleanupCategory(category.id)}
                  />
                ))}
              </section>
            );
          })}
        </section>
        <aside className="nexus-panel avs-cleanup-review" aria-label="Оценка выбранных файлов">
            <h3>К удалению</h3>
            <strong>{formatBytes(selectedBytes)}</strong>
            <p role="status">{selected.length} из {cleanupCategories.length} категорий</p>
            <div className="grid gap-2">
              <button
                type="button"
                disabled={busy || !nonEmpty}
                className="nexus-button"
                onClick={() => setSelectedCleanupIds(recommendedCleanupIds(cleanupCategories, isElevatedAdmin))}
              >
                Выбрать рекомендуемое
              </button>
              <button
                type="button"
                disabled={busy || selected.length === 0}
                className="nexus-button nexus-button--danger"
                onClick={() => setConfirmCleanupOpen(true)}
              >
                {isCleaning ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {isCleaning ? "Очистка…" : "Очистить выбранное"}
              </button>
            </div>
        </aside>
        </div>
      )}

      {confirmCleanupOpen && selected.length > 0 && (
        <UtilityConfirmDialog
          title="Удалить выбранные файлы?"
          confirmLabel="Подтвердить удаление"
          onCancel={() => setConfirmCleanupOpen(false)}
          onConfirm={() => void handleExecuteCleanup()}
        >
          <p>Оценка освобождаемого места — {formatBytes(selectedBytes)}. Фактический объём может отличаться.</p>
          <ul className="space-y-1">
            {selected.map((category) => (
              <li key={category.id}>
                <span className="text-[#E5EDF5]">{category.name}</span>
                {requiresCleanupReview(category.id) && <p className="text-xs text-amber-200">{cleanupConsequences[category.id]}</p>}
              </li>
            ))}
          </ul>
        </UtilityConfirmDialog>
      )}
    </div>
  );
}
