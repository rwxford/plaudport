import { captureCredentials, createSync, inspectRequest, describeNativeFailure } from './capture.mjs';

let status = { state: 'waiting', message: 'Waiting for Plaud. Reload your signed-in Personal workspace.', requests: 0 };
function show(state, message) {
  status = { ...status, state, message };
  void chrome.action.setBadgeText({ text: state === 'saved' ? 'OK' : state === 'failed' ? '!' : '…' });
  void chrome.action.setBadgeBackgroundColor({ color: state === 'saved' ? '#237A45' : state === 'failed' ? '#AD3800' : '#596579' });
  void chrome.action.setTitle({ title: 'PlaudPort: ' + message });
}
const sync = createSync(
  async credentials => {
    try {
      const reply = await chrome.runtime.sendNativeMessage('com.plaudport.chrome_auth', credentials);
      if (reply?.ok !== true) {
        show('failed', 'The local helper rejected the credentials or could not write the local credential store. Sign back in to Plaud, then reload.');
      }
      return reply;
    } catch (error) {
      show('failed', describeNativeFailure(error));
      throw new Error('Native helper failed');
    }
  },
  ok => {
    if (ok) {
      status = { ...status, savedAt: new Date().toLocaleString() };
      show('saved', 'Credentials saved locally. Last sync: ' + status.savedAt);
    }
  },
);

// Listen to the allowed API host for diagnosis; credential capture remains
// restricted to /file/ and requests from the Plaud web origin.
chrome.webRequest.onSendHeaders.addListener(details => {
  const observed = inspectRequest(details);
  if (!observed) return;
  status = { ...status, requests: status.requests + 1, observed };
  const credentials = captureCredentials(details);
  if (credentials) {
    void sync(credentials);
  } else if (status.state !== 'saved' && status.state !== 'failed') {
    show('waiting', !observed.fromPlaud ? 'Request observed, but it was not initiated by the Plaud web page.'
      : !observed.fileApi ? 'Plaud API traffic observed. Waiting for a file API request.'
      : 'File API request observed. Missing: ' + Object.entries(observed.headers).filter(([,yes]) => !yes).map(([key]) => key).join(', '));
  }
}, { urls: ['https://api.plaud.ai/*'] }, ['requestHeaders', 'extraHeaders']);

// Popup receives safe booleans and status text, never captured header values.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id === chrome.runtime.id && message?.type === 'status') reply(status);
});
