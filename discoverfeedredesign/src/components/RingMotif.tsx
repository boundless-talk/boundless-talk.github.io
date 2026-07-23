import { useTheme } from '../theme/ThemeContext';

interface RingMotifProps {
  occupancy: number;
  size?: number;
  dotSize?: number;
}

const FILL_ORDER = ['top', 'right', 'bottom', 'left'] as const;

export function RingMotif({ occupancy, size = 56, dotSize = 7 }: RingMotifProps) {
  const { tokens, mode } = useTheme();
  const offset = (size - dotSize) / 2;
  const ringBorder = mode === 'dark' ? 'rgba(255,255,255,.15)' : 'rgba(0,0,0,.1)';
  const emptyBorder = mode === 'dark' ? 'rgba(255,255,255,.25)' : 'rgba(0,0,0,.15)';

  const positionStyle = (node: (typeof FILL_ORDER)[number]): React.CSSProperties => {
    switch (node) {
      case 'top':
        return { top: 0, left: offset };
      case 'right':
        return { top: offset, right: 0 };
      case 'bottom':
        return { bottom: 0, left: offset };
      case 'left':
        return { top: offset, left: 0 };
    }
  };

  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <div style={{ position: 'absolute', inset: 0, border: `1px solid ${ringBorder}`, borderRadius: '50%' }} />
      {FILL_ORDER.map((node, i) => {
        const filled = i < occupancy;
        return (
          <div
            key={node}
            style={{
              position: 'absolute',
              width: dotSize,
              height: dotSize,
              borderRadius: '50%',
              background: filled ? tokens.accent : 'transparent',
              border: filled ? 'none' : `1px solid ${emptyBorder}`,
              ...positionStyle(node),
            }}
          />
        );
      })}
    </div>
  );
}
