import { useMemo, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { BrandMark } from '../components/BrandMark';
import { ThemeToggle } from '../components/ThemeToggle';
import { RoomCard } from '../components/RoomCard';
import { categories, rooms, trendingTags } from '../data/rooms';

export function Discover() {
  const { mode, tokens } = useTheme();
  const [activeCategory, setActiveCategory] = useState('All');

  const filteredRooms = useMemo(
    () => (activeCategory === 'All' ? rooms : rooms.filter((r) => r.category === activeCategory)),
    [activeCategory],
  );

  const startBtnRadius = mode === 'dark' ? 4 : 24;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: tokens.bg, color: tokens.text }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 40px',
          height: 76,
          borderBottom: `1px solid ${tokens.navBorder}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 40 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <BrandMark />
            <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: '-0.02em' }}>boundless talk</span>
          </div>
          <nav style={{ display: 'flex', gap: 28, fontSize: 13, fontWeight: 500, color: tokens.textSecondary }}>
            <a href="#" style={{ color: tokens.text }}>Discover</a>
            <a href="#" style={{ color: tokens.textSecondary }}>Trending</a>
            <a href="#" style={{ color: tokens.textSecondary }}>My Circles</a>
          </nav>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <ThemeToggle />
          <div
            style={{
              background: tokens.accent,
              color: '#fff',
              fontSize: 13,
              fontWeight: 700,
              padding: '10px 18px',
              borderRadius: startBtnRadius,
            }}
          >
            Start a circle
          </div>
        </div>
      </header>

      <div style={{ padding: '36px 40px 0' }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '.14em',
            textTransform: 'uppercase',
            color: tokens.accent,
            marginBottom: 8,
          }}
        >
          Live now
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h1 style={{ margin: 0, fontSize: 34, fontWeight: 800, letterSpacing: '-0.02em' }}>Discover</h1>
          <span style={{ fontSize: 13, color: tokens.textTertiary }}>612 circles live · max 4 voices each</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, padding: '22px 40px 0', flexWrap: 'wrap' }}>
        {categories.map((cat) => {
          const active = cat === activeCategory;
          return (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              style={{
                background: active ? tokens.accent : tokens.chipBg,
                color: active ? '#fff' : tokens.chipText,
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                padding: '8px 16px',
                borderRadius: 20,
                border: active ? 'none' : `1px solid ${tokens.chipBorder}`,
                cursor: 'pointer',
              }}
            >
              {cat}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 10, padding: '18px 40px 0', overflow: 'hidden', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: tokens.textTertiary, alignSelf: 'center', marginRight: 4 }}>Trending</span>
        {trendingTags.map((tag) => (
          <span
            key={tag.label}
            style={{
              fontSize: 12,
              color: tokens.tagText(tag.variant),
              background: tokens.tagBg(tag.variant),
              padding: '5px 12px',
              borderRadius: 14,
              border: mode === 'dark' ? `1px solid ${tokens.accent}4d` : 'none',
            }}
          >
            {tag.label}
          </span>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 18, padding: '28px 40px 40px' }}>
        {filteredRooms.map((room) => (
          <RoomCard key={room.id} room={room} />
        ))}
      </div>
    </div>
  );
}
