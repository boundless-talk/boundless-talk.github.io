import { useTheme } from '../theme/ThemeContext';

interface WaveformBarSpec {
  animation: 1 | 2 | 3 | 4;
  delay?: number;
}

interface WaveformProps {
  bars: WaveformBarSpec[];
  barWidth?: number;
}

export function Waveform({ bars, barWidth = 2 }: WaveformProps) {
  const { tokens } = useTheme();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {bars.map((bar, i) => (
        <div
          key={i}
          style={{
            width: barWidth,
            background: tokens.accent,
            animation: `wave${bar.animation} 1s ease-in-out infinite`,
            animationDelay: bar.delay ? `${bar.delay}s` : undefined,
          }}
        />
      ))}
    </div>
  );
}
