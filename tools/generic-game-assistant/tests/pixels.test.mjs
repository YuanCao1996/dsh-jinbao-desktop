import test from 'node:test';
import assert from 'node:assert/strict';
import { locateGomokuBoard, recognizeGomokuPixels } from '../adapters/gomoku/pixels.mjs';
import { boardImage } from './pixel-fixture.mjs';

const pieces = [{ col: 0, row: 0, color: 'black' }, { col: 7, row: 7, color: 'black' },
  { col: 8, row: 7, color: 'white' }, { col: 14, row: 14, color: 'white' }];
for (const options of [{}, { width: 960, height: 540, left: 240, top: 50, extent: 420 },
  { width: 1080, height: 800, left: 180, top: 80, extent: 640 },
  { width: 480, height: 720, left: 50, top: 140, extent: 380 },
  { background: [90, 110, 120], line: [215, 215, 215] }, { noise: 2 }]) {
  test(`recognizes actual RGB cells: ${JSON.stringify(options)}`, () => {
    const image = boardImage({ ...options, pieces });
    const result = recognizeGomokuPixels(image);
    assert.equal(result.status, 'observed');
    assert.equal(result.unknown_cells, 0);
    for (let row = 0; row < 15; row++) for (let col = 0; col < 15; col++) {
      const expected = pieces.find(piece => piece.row === row && piece.col === col)?.color ?? 'empty';
      assert.equal(result.state.cells[row * 15 + col], expected, `cell ${row},${col}`);
    }
    assert.equal(result.state.turn, 'unknown');
    assert.equal(result.state.rules, 'unknown');
    assert.equal(result.state.player_color, 'unknown');
    assert.equal(result.rules_validation, 'not_performed');
  });
}

test('partial stone/animation becomes unknown rather than being committed as black', () => {
  const image = boardImage({ pieces: [{ row: 7, col: 7, color: 'black', half: true }] });
  const result = recognizeGomokuPixels(image);
  assert.equal(result.status, 'observed');
  assert.equal(result.state.cells[112], 'unknown');
});

test('blank, incomplete edge grid and wrong board size produce no fake board', () => {
  const blank = { width: 640, height: 640, rgb: new Uint8Array(640 * 640 * 3).fill(170) };
  assert.equal(locateGomokuBoard(blank).reason, 'board_not_found');
  assert.equal(locateGomokuBoard(boardImage({ left: 0, top: 0 })).status, 'unknown');
  assert.equal(locateGomokuBoard(boardImage(), 19).status, 'unknown');
  assert.throws(() => locateGomokuBoard(blank, 13), /unsupported_board_size/);
});

test('very pale skin is not treated as a confidently empty board', () => {
  const result = recognizeGomokuPixels(boardImage({ background: [240, 240, 240] }));
  assert.equal(result.status, 'observed');
  assert.equal(result.unknown_cells, 225);
});

test('19-line board can be recognized when that board size is explicitly provided', () => {
  const result = recognizeGomokuPixels(boardImage({ size: 19 }), { boardSize: 19 });
  assert.equal(result.status, 'observed');
  assert.equal(result.state.cells.length, 361);
});
