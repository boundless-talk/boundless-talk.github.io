import { useTheme } from '../theme/ThemeContext';

export function ThemeToggle() {
  const { mode, tokens, toggleMode } = useTheme();
  const isDark = mode === 'dark';

  const segmentStyle = (active: boolean): React.CSSProperties => ({
    padding: '7px 13px',
    borderRadius: 16,
    fontSize: 11,
    fontWeight: 700,
    background: active ? tokens.accent : 'transparent',
    color: active ? '#fff' : tokens.textTertiary,
  });

  return (
    <div
      onClick={toggleMode}
      role="button"
      aria-label="Toggle Dark / Cute theme"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        background: tokens.toggleTrackBg,
        borderRadius: 20,
        padding: 3,
        cursor: 'pointer',
      }}
    >
      <div style={segmentStyle(isDark)}>Dark</div>
      <div style={segmentStyle(!isDark)}>Cute</div>
    </div>
  );
}
