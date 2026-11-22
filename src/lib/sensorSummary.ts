export type SensorState = "normal" | "warning" | "unavailable" | "stale";

interface SensorCheck {
  name: string;
  value: number | null | undefined;
  limit: number;
  direction: "minimum" | "maximum";
  unit: string;
  stale: boolean;
  reason?: string;
}

export function cpuPackageUnavailableReason({
  sample, online, driverBlocked, hvciConfigured, elevated,
}: {
  sample: boolean;
  online: boolean;
  driverBlocked: boolean;
  hvciConfigured: boolean;
  elevated: boolean;
}) {
  if (driverBlocked) return "Windows заблокировала драйвер датчиков";
  if (!sample) return "Ожидание аппаратной телеметрии";
  if (!online) return "Служба датчиков недоступна";
  if (hvciConfigured) return "Датчик пакета недоступен. Целостность памяти (HVCI) включена в настройках Windows";
  if (!elevated) return "Нет показания датчика пакета в текущем сеансе Windows";
  return "Датчик пакета не вернул достоверное показание";
}

export function summarizeSensors(checks: readonly SensorCheck[]) {
  const counts: Record<SensorState, number> = { normal: 0, warning: 0, unavailable: 0, stale: 0 };
  const readings = checks.map(check => {
    const { value, limit, direction, stale } = check;
    let state: SensorState;
    if (value == null || !Number.isFinite(value) || !Number.isFinite(limit)) state = "unavailable";
    else if (stale) state = "stale";
    else state = (direction === "minimum" ? value < limit : value >= limit) ? "warning" : "normal";
    counts[state]++;
    return { ...check, state };
  });
  return { counts, readings, evaluated: counts.normal + counts.warning };
}
