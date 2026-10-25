import { gomoku } from './gomoku/index.mjs';
import { screen } from './screen.mjs';

export function resolveAdapter(id) {
  if (id === 'generic') return screen;
  if (id === 'gomoku') return gomoku;
  throw new Error('unsupported_generic_game');
}
