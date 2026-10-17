try {
  const status = await chrome.runtime.sendMessage({ type: 'status' });
  document.getElementById('message').textContent = status?.message ?? 'No status available. Reload the extension.';
  const o = status?.observed;
  document.getElementById('details').textContent = 'API requests observed: ' + (status?.requests ?? 0)
    + (o ? '\nFrom Plaud page: ' + (o.fromPlaud ? 'yes' : 'no')
      + '\nFile API: ' + (o.fileApi ? 'yes' : 'no')
      + '\n' + Object.entries(o.headers).map(([name, yes]) => name + ': ' + (yes ? 'present' : 'missing')).join('\n') : '')
    + (status?.savedAt ? '\nLast saved: ' + status.savedAt : '');
} catch {
  document.getElementById('message').textContent = 'Cannot reach the extension worker. Reload the extension at chrome://extensions.';
}
