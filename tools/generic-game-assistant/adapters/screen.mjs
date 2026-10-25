import { createHash } from 'node:crypto';

const kinds = ['unknown', 'board', 'cards', 'menu', 'results', 'other'];
const text = (value, max) => typeof value === 'string' && value.length <= max;

// A shared visual fact schema, not a parser for any particular game.
export const screen = {
  id: 'generic',
  name: '通用画面',
  normalize(value) {
    if (!value || !kinds.includes(value.screen_kind) || !Array.isArray(value.texts)
        || !Array.isArray(value.entities) || value.texts.length > 64 || value.entities.length > 128
        || !['unread', 'partial', 'read'].includes(value.visual_status)) throw new Error('invalid_screen_state');
    if (value.game_name != null && !text(value.game_name, 80)) throw new Error('invalid_screen_state');
    const identity = {};
    for (const key of ['game_name', 'game_mode', 'game_version', 'game_phase']) {
      const item = value.identity?.[key];
      if (item == null) continue;
      if (!text(item.value,80) || !item.value.trim() || !['low','medium','high'].includes(item.confidence)
          || !Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 4
          || !item.evidence.every(e => text(e,256) && e.trim())) throw new Error('invalid_game_identity');
      identity[key] = {value:item.value.trim(),confidence:item.confidence,evidence:[...item.evidence]};
    }
    if (value.visual_status === 'unread' && Object.keys(identity).length) throw new Error('unread_screen_has_semantics');
    if (!value.texts.every(item => text(item, 256)) || value.texts.join('').length > 6000)
      throw new Error('invalid_screen_text');
    const entities = value.entities.map(item => {
      if (!item || !text(item.type, 40) || !text(item.label, 128)
          || !['local', 'cloud', 'user'].includes(item.source)) throw new Error('invalid_screen_entity');
      const entity = { type: item.type, label: item.label, source: item.source };
      if (item.box != null) {
        const { x, y, width, height } = item.box;
        if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0
            || x + width > 1 || y + height > 1) throw new Error('invalid_screen_entity_box');
        entity.box = { x, y, width, height };
      }
      return entity;
    });
    if (value.visual_status === 'unread' && (entities.length || value.texts.length || value.screen_kind !== 'unknown'))
      throw new Error('unread_screen_has_semantics');
    const facts = { screen_kind: value.screen_kind, game_name: value.game_name ?? null,
      visual_status: value.visual_status, texts: [...value.texts], entities,
      ...(Object.keys(identity).length ? {identity} : {}) };
    return { ...facts, coordinate_space: 'captured_image_normalized', complete: value.visual_status === 'read',
      position_hash: createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
      rules_validation: 'not_performed', engine_status: 'not_connected' };
  },
};

export function inspectScreen(image) {
  if (!image || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
      || image.width < 1 || image.height < 1 || image.width * image.height > 2048 ** 2
      || !(image.rgb instanceof Uint8Array) || image.rgb.length !== image.width * image.height * 3)
    throw new Error('invalid_screen_image');
  return { status: 'unknown', reason: 'visual_reader_not_connected',
    state: { screen_kind: 'unknown', game_name: null, visual_status: 'unread', texts: [], entities: [] } };
}
