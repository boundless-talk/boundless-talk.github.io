export type ThemeMode = 'dark' | 'light';

export interface ThemeTokens {
  bg: string;
  surface: string;
  surfaceBorder: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  accentSecondary: string;
  cardRadius: number;
  toggleTrackBg: string;
  navBorder: string;
  headerBorder: string;
  chipBg: string;
  chipBorder: string;
  chipText: string;
  tagBg: (variant: 'accent' | 'secondary') => string;
  tagText: (variant: 'accent' | 'secondary') => string;
  cardShadow: string;
}

export const themeTokens: Record<ThemeMode, ThemeTokens> = {
  dark: {
    bg: '#0b0b0c',
    surface: '#141416',
    surfaceBorder: 'rgba(255,255,255,.08)',
    text: '#f5f4f2',
    textSecondary: 'rgba(255,255,255,.55)',
    textTertiary: 'rgba(255,255,255,.4)',
    accent: '#e4362a',
    accentSecondary: '#e4362a',
    cardRadius: 8,
    toggleTrackBg: 'rgba(255,255,255,.06)',
    navBorder: 'rgba(255,255,255,.08)',
    headerBorder: 'rgba(255,255,255,.08)',
    chipBg: 'rgba(255,255,255,.06)',
    chipBorder: 'rgba(255,255,255,.08)',
    chipText: 'rgba(255,255,255,.7)',
    tagBg: () => 'transparent',
    tagText: () => '#e4362a',
    cardShadow: 'none',
  },
  light: {
    bg: '#fff8f4',
    surface: '#ffffff',
    surfaceBorder: 'rgba(0,0,0,.06)',
    text: '#2b1f24',
    textSecondary: 'rgba(43,31,36,.55)',
    textTertiary: 'rgba(43,31,36,.4)',
    accent: '#ff6f9c',
    accentSecondary: '#8b7bff',
    cardRadius: 16,
    toggleTrackBg: 'rgba(0,0,0,.04)',
    navBorder: 'rgba(0,0,0,.06)',
    headerBorder: 'rgba(0,0,0,.06)',
    chipBg: '#ffffff',
    chipBorder: 'rgba(0,0,0,.08)',
    chipText: 'rgba(43,31,36,.65)',
    tagBg: (variant) => (variant === 'accent' ? '#ffe6ee' : '#ece7ff'),
    tagText: (variant) => (variant === 'accent' ? '#ff6f9c' : '#8b7bff'),
    cardShadow: '0 6px 18px rgba(255,111,156,.08)',
  },
};
