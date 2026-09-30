import type { AudioMode } from 'expo-audio';

/*
 * Stand-in for expo-audio (its player is a native object that cannot run under Jest). Every
 * player the app creates is recorded with jest.fn methods, so tests assert exactly which playback
 * calls happened (play / pause / seekTo / remove) and how the player was configured.
 *
 * Registered for every test file in jest.setup.ts.
 */

export class FakeAudioPlayer {
  loop = false;
  /** Deliberately not the real default (1.0), so a test proves the app sets the volume. */
  volume = 0.5;
  playing = false;
  removed = false;

  readonly play = jest.fn(() => {
    this.playing = true;
  });

  readonly pause = jest.fn(() => {
    this.playing = false;
  });

  readonly seekTo = jest.fn((_seconds: number) => Promise.resolve());

  readonly remove = jest.fn(() => {
    this.playing = false;
    this.removed = true;
  });

  constructor(readonly source: unknown) {}
}

export const mockAudio: { players: FakeAudioPlayer[]; modes: Partial<AudioMode>[] } = {
  players: [],
  modes: [],
};

export const createAudioPlayer = jest.fn((source: unknown) => {
  const player = new FakeAudioPlayer(source);
  mockAudio.players.push(player);
  return player;
});

export const setAudioModeAsync = jest.fn((mode: Partial<AudioMode>) => {
  mockAudio.modes.push(mode);
  return Promise.resolve();
});

/** The one player a screen created (fails the test if there is not exactly one). */
export function onlyPlayer(): FakeAudioPlayer {
  const [player, ...others] = mockAudio.players;
  if (player === undefined || others.length > 0) {
    throw new Error(`Expected exactly one audio player, found ${String(mockAudio.players.length)}`);
  }
  return player;
}

export function resetMockAudio(): void {
  mockAudio.players = [];
  mockAudio.modes = [];
  createAudioPlayer.mockClear();
  setAudioModeAsync.mockClear();
}
