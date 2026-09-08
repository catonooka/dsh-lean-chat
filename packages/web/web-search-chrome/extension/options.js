// The one setting this extension has: where the chat app listens.

const DEFAULT_ORIGIN = 'http://127.0.0.1:3095'
const input = document.getElementById('origin')
const status = document.getElementById('status')

chrome.storage.local.get({ appOrigin: DEFAULT_ORIGIN }, (stored) => { input.value = stored.appOrigin })

document.getElementById('save').addEventListener('click', () => {
  const origin = input.value.trim().replace(/\/+$/, '')
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
  } catch (error) {
    status.textContent = 'Enter the origin as http://127.0.0.1:3095'
    status.style.color = '#bc2c36'
    return
  }
  chrome.storage.local.set({ appOrigin: origin }, () => {
    status.textContent = 'Saved — the background picks it up immediately.'
    status.style.color = '#1a7f37'
  })
})
