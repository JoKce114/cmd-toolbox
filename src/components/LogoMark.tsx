import { cn } from '../lib';

export function LogoMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn('logo-mark', className)}
      aria-hidden="true"
    >
      <rect x="0.5" y="0.5" width="23" height="23" rx="6.2" fill="#17181C" />
      <rect
        x="0.5"
        y="0.5"
        width="23"
        height="23"
        rx="6.2"
        stroke="white"
        strokeOpacity="0.08"
      />
      <path
        d="M7.2 8.6 11 12l-3.8 3.4"
        stroke="white"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M13.2 15.4h3.8" stroke="#93A1FF" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
