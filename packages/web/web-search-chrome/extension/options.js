// The extension's three settings: where the chat app listens, the Chrome
// profile label this instance polls under, and whether this profile may be
// driven for actions — not just reading.

const DEFAULT_ORIGIN = 'http://127.0.0.1:3095'
const input = document.getElementById('origin')
const client = document.getElementById('client')
const actuation = document.getElementById('actuation')
const status = document.getElementById('status')

chrome.storage.local.get({ appOrigin: DEFAULT_ORIGIN, clientLabel: '', actuationAllowed: false }, (stored) => {
  input.value = stored.appOrigin
  client.value = stored.clientLabel
  actuation.checked = stored.actuationAllowed === true
})

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
  const label = client.value.trim().slice(0, 32)
  chrome.storage.local.set({ appOrigin: origin, clientLabel: label, actuationAllowed: actuation.checked }, () => {
    status.textContent = 'Saved — the background picks it up immediately.'
    status.style.color = '#1a7f37'
  })
})
