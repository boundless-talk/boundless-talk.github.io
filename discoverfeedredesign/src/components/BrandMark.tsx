import { useTheme } from '../theme/ThemeContext';

export function BrandMark({ size = 22 }: { size?: number }) {
  const { tokens } = useTheme();
  const dotSize = Math.round(size * (6 / 22));
  return (
    <div
      style={{
        width: size,
        height: size,
        border: `2px solid ${tokens.accent}`,
        borderRadius: '50%',
        position: 'relative',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          margin: 'auto',
          width: dotSize,
          height: dotSize,
          background: tokens.accent,
          borderRadius: '50%',
        }}
      />
    </div>
  );
}
