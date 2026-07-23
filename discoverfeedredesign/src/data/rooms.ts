export type RoomStatus = 'full' | 'ends-in' | 'live';

export interface Room {
  id: string;
  category: string;
  topic: string;
  occupancy: number;
  capacity: 4;
  status: RoomStatus;
  endsInMinutes?: number;
  liveDotDelay: number;
  footer:
    | { kind: 'waveform'; bars: { animation: 1 | 2 | 3 | 4; delay?: number }[] }
    | { kind: 'overflow' };
}

export const categories = ['All', 'Debate', 'Tech', 'Late Night', 'Music', 'Life', 'Gaming'];

export const trendingTags: { label: string; variant: 'accent' | 'secondary' }[] = [
  { label: '#f1', variant: 'accent' },
  { label: '#existential', variant: 'secondary' },
  { label: '#buildinpublic', variant: 'accent' },
  { label: '#latenight', variant: 'secondary' },
  { label: '#aiethics', variant: 'accent' },
];

export const rooms: Room[] = [
  {
    id: 'remote-work',
    category: 'Debate',
    topic: 'Is remote work already over?',
    occupancy: 4,
    capacity: 4,
    status: 'full',
    liveDotDelay: 0,
    footer: {
      kind: 'waveform',
      bars: [
        { animation: 1 },
        { animation: 3, delay: 0.1 },
        { animation: 2, delay: 0.2 },
        { animation: 4, delay: 0.3 },
      ],
    },
  },
  {
    id: '3am-confessions',
    category: 'Late Night',
    topic: '3am confessions',
    occupancy: 3,
    capacity: 4,
    status: 'ends-in',
    endsInMinutes: 12,
    liveDotDelay: 0.2,
    footer: {
      kind: 'waveform',
      bars: [{ animation: 2 }, { animation: 4, delay: 0.1 }, { animation: 1, delay: 0.2 }],
    },
  },
  {
    id: 'prompt-engineering',
    category: 'Tech',
    topic: "Prompt engineering isn't a real skill. Fight me.",
    occupancy: 4,
    capacity: 4,
    status: 'full',
    liveDotDelay: 0.4,
    footer: { kind: 'overflow' },
  },
  {
    id: 'aux-cord-roulette',
    category: 'Music',
    topic: 'Aux cord roulette',
    occupancy: 2,
    capacity: 4,
    status: 'live',
    liveDotDelay: 0.1,
    footer: { kind: 'waveform', bars: [{ animation: 4 }, { animation: 2, delay: 0.15 }] },
  },
  {
    id: 'dating-profile',
    category: 'Life',
    topic: 'Roast my dating profile',
    occupancy: 3,
    capacity: 4,
    status: 'ends-in',
    endsInMinutes: 38,
    liveDotDelay: 0.3,
    footer: { kind: 'overflow' },
  },
  {
    id: 'free-will',
    category: 'Debate',
    topic: 'Does free will exist? (again)',
    occupancy: 4,
    capacity: 4,
    status: 'full',
    liveDotDelay: 0.25,
    footer: { kind: 'waveform', bars: [{ animation: 3 }, { animation: 1, delay: 0.2 }] },
  },
];
