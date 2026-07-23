import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';

export function OverflowMenu() {
  const { tokens, mode } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label="Circle options"
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tokens.textSecondary,
          fontSize: 14,
          border: `1px solid ${mode === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.08)'}`,
          background: 'transparent',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 24,
            right: 0,
            zIndex: 10,
            background: tokens.surface,
            border: `1px solid ${tokens.surfaceBorder}`,
            borderRadius: 8,
            padding: 4,
            minWidth: 140,
            boxShadow: '0 12px 30px rgba(0,0,0,.35)',
          }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '8px 10px',
              fontSize: 12,
              fontWeight: 600,
              color: tokens.accent,
              background: 'transparent',
              border: 'none',
              borderRadius: 5,
              cursor: 'pointer',
            }}
          >
            Report circle
          </button>
        </div>
      )}
    </div>
  );
}
