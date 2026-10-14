import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn's class helper: later classes win over earlier ones, so callers can override a primitive. */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
