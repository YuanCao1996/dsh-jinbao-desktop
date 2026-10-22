export function assertReleaseRuntime(version) {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parts || Number(parts[1]) !== 24 || Number(parts[2]) < 22 || (Number(parts[2]) === 22 && Number(parts[3]) < 1)) {
    throw Error('Release builds require Node 24 LTS >=24.22.1; update the verified official runtime before packaging');
  }
}
