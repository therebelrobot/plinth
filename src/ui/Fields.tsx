import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * Number input with large − / + buttons: typing works on desktop, the buttons
 * are the comfortable path on iPad (no keyboard popping up over the canvas).
 */
export function NumberField(props: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step: number;
  min?: number;
  max?: number;
  suffix?: string;
  hint?: string;
}) {
  const { label, value, onChange, step, min = -Infinity, max = Infinity, suffix, hint } = props;
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next / step) * step));
  const commit = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) onChange(clamp(parsed));
    else setDraft(String(value));
  };
  const fixed = (next: number) => Number(next.toFixed(4));
  return (
    <label className="field">
      <span className="field-label">{label}{hint && <small>{hint}</small>}</span>
      <span className="stepper">
        <button type="button" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => onChange(fixed(clamp(value - step)))}>
          <Icon name="minus" size={16} />
        </button>
        <input
          inputMode="decimal"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }}
        />
        {suffix && <span className="stepper-suffix">{suffix}</span>}
        <button type="button" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => onChange(fixed(clamp(value + step)))}>
          <Icon name="plus" size={16} />
        </button>
      </span>
    </label>
  );
}

export function Segmented<T extends string | number>(props: {
  label?: string;
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="field">
      {props.label && <span className="field-label">{props.label}</span>}
      <div className="segmented" role="radiogroup" aria-label={props.label}>
        {props.options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={option.value === props.value}
            className={option.value === props.value ? 'is-active' : ''}
            title={option.title}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Toggle(props: { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string }) {
  return (
    <label className="toggle">
      <span className="field-label">{props.label}{props.hint && <small>{props.hint}</small>}</span>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span className="toggle-track" aria-hidden="true"><span /></span>
    </label>
  );
}
