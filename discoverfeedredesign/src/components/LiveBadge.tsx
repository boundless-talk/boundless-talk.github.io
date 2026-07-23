import { useTheme } from '../theme/ThemeContext';

export function LiveBadge({ delay = 0 }: { delay?: number }) {
  const { tokens } = useTheme();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: tokens.accent,
          animation: 'pulseDot 1.4s ease-in-out infinite',
          animationDelay: delay ? `${delay}s` : undefined,
        }}
      />
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: tokens.accent }}>LIVE</span>
    </div>
  );
}
