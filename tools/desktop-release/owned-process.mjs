// Shutdown is requested over IPC on Windows, where child.kill() is not a graceful signal.
// The collector terminates only the logcat process it created, never the shared ADB server.
export function bindOwnedChild(child, flush, parent = process) {
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    flush();
    child.kill();
  }
  function finished() {
    flush();
    if (parent.connected) parent.disconnect();
  }
  parent.once('SIGINT', stop);
  parent.once('SIGTERM', stop);
  parent.on('message', message => { if (message?.action === 'stop') stop(); });
  if (parent.connected) parent.once('disconnect', stop);
  child.once('exit', finished);
  child.once('error', finished);
  return stop;
}
