import { useTheme } from '../theme/ThemeContext';
import type { Room } from '../data/rooms';
import { RingMotif } from './RingMotif';
import { Waveform } from './Waveform';
import { LiveBadge } from './LiveBadge';
import { OverflowMenu } from './OverflowMenu';

function statusLabel(room: Room) {
  if (room.status === 'full') return `${room.occupancy}/${room.capacity} · full`;
  if (room.status === 'ends-in') return `${room.occupancy}/${room.capacity} · ends in ${room.endsInMinutes}m`;
  return `${room.occupancy}/${room.capacity}`;
}

export function RoomCard({ room }: { room: Room }) {
  const { tokens } = useTheme();

  return (
    <div
      style={{
        background: tokens.surface,
        border: `1px solid ${tokens.surfaceBorder}`,
        borderRadius: tokens.cardRadius,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        boxShadow: tokens.cardShadow,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '.1em',
            textTransform: 'uppercase',
            color: tokens.textTertiary,
          }}
        >
          {room.category}
        </span>
        <LiveBadge delay={room.liveDotDelay} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <RingMotif occupancy={room.occupancy} />
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, lineHeight: 1.3, color: tokens.text }}>{room.topic}</h3>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 'auto',
          paddingTop: 8,
          borderTop: `1px solid ${tokens.surfaceBorder}`,
        }}
      >
        <span style={{ fontSize: 12, color: tokens.textSecondary }}>{statusLabel(room)}</span>
        {room.footer.kind === 'waveform' ? <Waveform bars={room.footer.bars} /> : <OverflowMenu />}
      </div>
    </div>
  );
}
