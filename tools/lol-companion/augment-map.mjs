// Maps a card slot read from the panel pixels to the augment name the offer OCR captured.
//
// The two sources disagree more often than it looks: a real match had the panel read as
// [屹立不倒, 尖端发明家, 质变：棱彩阶] while the offer only captured slots 1 and 2 (the first
// card's title OCR failed). The watcher correctly reported slot 0, but a positional fallback
// then took options[0] and recorded 尖端发明家 as the pick — a card the player never chose.
//
// So: a slot that the offer does not know is a gap to report, never a guess.
export function mapPickedSlot(options, picked) {
  const list = Array.isArray(options) ? options : [];
  if (!Number.isInteger(picked) || picked < 0) return null;
  // Nothing captured at all is the same gap as a missing slot, not a positional list.
  if (!list.length) return { name: null, missing: true };
  const slotty = list.some((row) => row && typeof row === 'object' && Number.isInteger(Number(row.slot)));
  const named = (row) => {
    const name = typeof row === 'string' ? row : row?.name;
    return typeof name === 'string' && name ? name : null;
  };
  if (slotty) {
    const found = list.find((row) => row && typeof row === 'object' && Number(row.slot) === picked);
    const name = found ? named(found) : null;
    return name ? { name } : { name: null, missing: true };
  }
  // Legacy offers carry a plain name list with no slot numbers; position is all there is.
  const name = named(list[picked]);
  return name ? { name } : null;
}
