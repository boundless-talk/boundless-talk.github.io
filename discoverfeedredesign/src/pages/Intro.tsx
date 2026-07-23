import { Link } from 'react-router-dom';
import { useTheme } from '../theme/ThemeContext';
import { ThemeToggle } from '../components/ThemeToggle';

export function Intro() {
  const { mode, tokens } = useTheme();
  const isDark = mode === 'dark';

  const glow = isDark ? 'rgba(228,54,42,.18)' : 'rgba(255,111,156,.14)';
  const logoDropShadow = isDark
    ? 'drop-shadow(0 0 40px rgba(228,54,42,.2))'
    : 'drop-shadow(0 10px 30px rgba(255,111,156,.25))';
  const subtitle = isDark
    ? 'No names. No faces. Just voices — up to 4 at a time.'
    : 'Anonymous voice circles, 4 people at a time.';
  const buttonRadius = isDark ? 4 : 24;
  const secondaryBtnBg = isDark ? 'rgba(255,255,255,.06)' : '#fff';
  const secondaryBtnText = isDark ? 'rgba(255,255,255,.7)' : 'rgba(43,31,36,.65)';
  const secondaryBtnBorder = isDark ? '1px solid rgba(255,255,255,.1)' : '1px solid rgba(0,0,0,.08)';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: tokens.bg,
        color: tokens.text,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'absolute', top: 36, right: 44 }}>
        <ThemeToggle />
      </div>

      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%,-50%)',
          width: 600,
          height: 600,
          background: `radial-gradient(circle, ${glow}, transparent 70%)`,
        }}
      />

      <img
        src="/assets/logo-transparent.png"
        alt="boundless talk logo"
        style={{ width: 160, height: 160, objectFit: 'contain', position: 'relative', filter: logoDropShadow }}
      />

      <h1 style={{ margin: '28px 0 0', fontSize: 32, fontWeight: 800, letterSpacing: '-0.02em', position: 'relative' }}>
        boundless talk
      </h1>
      <p style={{ margin: '12px 0 0', fontSize: 14, color: tokens.textSecondary, position: 'relative' }}>{subtitle}</p>

      <div style={{ display: 'flex', gap: 14, marginTop: 40, position: 'relative' }}>
        <Link
          to="/discover"
          style={{
            background: tokens.accent,
            color: '#fff',
            fontSize: 14,
            fontWeight: 700,
            padding: '14px 32px',
            borderRadius: buttonRadius,
            textDecoration: 'none',
          }}
        >
          Start listening
        </Link>
        <div
          style={{
            background: secondaryBtnBg,
            color: secondaryBtnText,
            fontSize: 14,
            fontWeight: 600,
            padding: '14px 28px',
            borderRadius: buttonRadius,
            border: secondaryBtnBorder,
            cursor: 'default',
          }}
        >
          How it works
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 56, position: 'relative' }}>
        {[0, 0.15, 0.3].map((delay) => (
          <div
            key={delay}
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: tokens.accent,
              animation: 'pulseDot 1.3s ease-in-out infinite',
              animationDelay: `${delay}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
