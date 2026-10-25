export function suggestOverlayQuestion(state) {
  if (!state || state.ended) return '';
  const game = state.game;
  if(game==='generic')return '看一下当前窗口，识别游戏和模式，并给一条针对性建议。';
  const hero = String(state.me?.champion ?? '').trim();
  if (game === 'lol') {
    if (state.phase === 'ChampSelect') return '当前可选英雄里，哪个更适合海克斯大乱斗？';
    if (Array.isArray(state.offers) && state.offers.length) return `这轮海克斯怎么选${hero ? `，最适合${hero}的是哪个` : ''}？`;
    if (hero && Array.isArray(state.enemies) && state.enemies.some(enemy => enemy?.items?.length)) return `根据敌方装备，${hero}下一件该出什么？`;
    if (hero) return `${hero}这局下一步最该注意什么？`;
  }
  if (game === 'wzry') {
    if (hero) return `${hero}这局下一步该怎么打？`;
    if (state.phase === 'ChampSelect') return '目前阵容缺什么位置？';
  }
  return '';
}
