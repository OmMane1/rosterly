import { LoaderCircle } from 'lucide-react';
import { cn } from './cn';

export const Spinner = ({ className }: { className?: string }) => <LoaderCircle aria-hidden className={cn('size-4 animate-spin', className)} />;
