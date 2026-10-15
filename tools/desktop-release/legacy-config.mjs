// The old settings plugin owns an overlay/collector and synchronizes its own
// adapters into coach-server. Keep its entry for rollback, but disable it when
// installing the released Jinbao pipeline so it cannot overwrite that pipeline.
export function disableLegacyPlugin(doc, entries) {
  for (const node of entries) {
    if (node?.get?.('id') === 'jinbao-probe' || node?.get?.('name') === 'dsh-plugin-jinbao-probe') {
      node.set('disabled', true);
      const config = node.get('config')?.toJSON?.() ?? {};
      node.set('config', doc.createNode({ ...config, autoStart: false }));
    }
  }
}
