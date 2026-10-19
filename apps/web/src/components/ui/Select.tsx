import { ChevronDown } from 'lucide-react';
import type { Ref, SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { fieldClasses } from './Input';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> {
  options: readonly SelectOption<V>[];
  value: V | '';
  onValueChange: (value: V) => void;
  /** Shown as a first, empty option. */
  placeholder?: string;
  invalid?: boolean;
  selectSize?: 'sm' | 'md';
  ref?: Ref<HTMLSelectElement>;
}

/** Native <select> (best keyboard + screen reader support), styled to match. */
export function Select<V extends string = string>({
  options, value, onValueChange, placeholder, invalid, selectSize = 'md', className, ...rest
}: SelectProps<V>) {
  return (
    <div className={cn('relative', className)}>
      <select
        value={value}
        onChange={(e) => onValueChange(e.target.value as V)}
        aria-invalid={invalid || undefined}
        className={fieldClasses(invalid, cn('appearance-none pr-8', selectSize === 'sm' ? 'h-8 pl-3' : 'h-10 pl-3.5'))}
        {...rest}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
    </div>
  );
}
