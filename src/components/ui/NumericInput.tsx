import { useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";

export interface NumericInputProps {
  value: number | string;
  onChange: (raw: string, numericValue: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  allowDecimal?: boolean;
  unit?: string;
  placeholder?: string;
  disabled?: boolean;
  showSteppers?: boolean;
  className?: string;
  inputClassName?: string;
  ariaLabel?: string;
}

function clampValue(val: number, min?: number, max?: number): number {
  let next = val;
  if (min !== undefined && next < min) next = min;
  if (max !== undefined && next > max) next = max;
  return next;
}

export function NumericInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  allowDecimal = false,
  unit,
  placeholder,
  disabled = false,
  showSteppers = true,
  className = "",
  inputClassName = "",
  ariaLabel,
}: NumericInputProps) {
  const [draftText, setDraftText] = useState(() =>
    value === "" || value === null || value === undefined ? "" : String(value)
  );
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setDraftText(
        value === "" || value === null || value === undefined ? "" : String(value)
      );
    }
  }, [value, focused]);

  const parsedCurrent = (() => {
    const n = Number(draftText.replace(",", "."));
    return draftText.trim() !== "" && Number.isFinite(n) ? n : null;
  })();

  const handleTextChange = (rawInput: string) => {
    const cleaned = rawInput.replace(",", ".");
    const pattern = allowDecimal ? /^\d*\.?\d*$/ : /^\d*$/;
    if (!pattern.test(cleaned)) {
      return;
    }
    setDraftText(cleaned);
    if (cleaned === "" || cleaned === ".") {
      onChange(cleaned, null);
      return;
    }
    const parsed = Number(cleaned);
    onChange(cleaned, Number.isFinite(parsed) ? parsed : null);
  };

  const commitValue = (target: number) => {
    const clamped = clampValue(target, min, max);
    const rounded = allowDecimal ? Math.round(clamped * 100) / 100 : Math.round(clamped);
    const text = String(rounded);
    setDraftText(text);
    onChange(text, rounded);
  };

  const handleBlur = () => {
    setFocused(false);
    if (draftText.trim() === "" || draftText === ".") {
      if (typeof value === "number" && Number.isFinite(value)) {
        const clamped = clampValue(value, min, max);
        setDraftText(String(clamped));
      } else {
        setDraftText("");
        onChange("", null);
      }
      return;
    }
    const parsed = Number(draftText);
    if (Number.isFinite(parsed)) {
      commitValue(parsed);
    }
  };

  const handleStep = (delta: number) => {
    if (disabled) return;
    const base =
      parsedCurrent !== null
        ? parsedCurrent
        : min !== undefined
          ? min
          : 0;
    commitValue(base + delta);
  };

  const atMin = min !== undefined && parsedCurrent !== null && parsedCurrent <= min;
  const atMax = max !== undefined && parsedCurrent !== null && parsedCurrent >= max;

  return (
    <div
      className={`nexus-numeric group/num inline-flex w-full items-center overflow-hidden rounded-lg border border-[#202B38] bg-[#0B0E14] transition-colors focus-within:border-[#00D5E8]/60 focus-within:shadow-[0_0_0_1px_rgba(0,213,232,0.18)] ${
        disabled ? "cursor-not-allowed opacity-55" : ""
      } ${className}`}
    >
      <input
        type="text"
        inputMode={allowDecimal ? "decimal" : "numeric"}
        aria-label={ariaLabel}
        value={draftText}
        disabled={disabled}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        onChange={(e) => handleTextChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            e.preventDefault();
            handleStep(step);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            handleStep(-step);
          }
        }}
        className={`nexus-numeric-input min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-sm text-[#E5EDF5] outline-none placeholder:text-[#526170] ${inputClassName}`}
      />
      {unit && (
        <span className="select-none pr-2 font-mono text-[11px] font-medium text-[#526170]">
          {unit}
        </span>
      )}
      {showSteppers && (
        <div className="flex shrink-0 items-center border-l border-[#202B38] bg-[#10151D]">
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled || atMin}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleStep(-step)}
            title="Уменьшить"
            aria-label="Уменьшить значение"
            className="flex h-9 w-7 cursor-pointer items-center justify-center text-[#8292A3] transition-colors hover:bg-[#151C26] hover:text-[#00D5E8] disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Minus size={12} />
          </button>
          <div className="h-4 w-px bg-[#202B38]" />
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled || atMax}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleStep(step)}
            title="Увеличить"
            aria-label="Увеличить значение"
            className="flex h-9 w-7 cursor-pointer items-center justify-center text-[#8292A3] transition-colors hover:bg-[#151C26] hover:text-[#00D5E8] disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Plus size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
