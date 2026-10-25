import { createHash } from 'node:crypto';

export const gomoku = {
  id: 'gomoku',
  name: '五子棋',
  normalize(value) {
    if (!value || ![15, 19].includes(value.board_size) || !Array.isArray(value.cells)
        || value.cells.length !== value.board_size ** 2
        || !value.cells.every(cell => ['empty', 'black', 'white', 'unknown'].includes(cell))) {
      throw new Error('invalid_gomoku_board');
    }
    if (!['black', 'white', 'unknown'].includes(value.turn)
        || !['black', 'white', 'unknown'].includes(value.player_color)
        || !['freestyle', 'renju', 'unknown'].includes(value.rules)) throw new Error('invalid_gomoku_rules');
    const facts = { board_size: value.board_size, cells: [...value.cells], turn: value.turn,
      player_color: value.player_color, rules: value.rules };
    const complete = !facts.cells.includes('unknown') && facts.turn !== 'unknown'
      && facts.player_color !== 'unknown' && facts.rules !== 'unknown';
    return { ...facts, complete,
      position_hash: createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
      rules_validation: 'not_performed', engine_status: 'not_connected' };
  },
};

// This is a structural observation adapter, not a move generator or rule engine.
export function resolveAdapter(id) {
  if (id !== gomoku.id) throw new Error('unsupported_generic_game');
  return gomoku;
}
