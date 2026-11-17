#!/bin/zsh
# Captures the ChatGPT card and the popup (as it shows on pixiv.net) in one UI
# language, into shots/. Usage: capture-ui.sh <lang> <AppleLanguages code> <Target language>
# macOS ignores --lang; -AppleLanguages is what switches chrome.i18n.
set -e
cd "$(dirname "$0")"
lang=$1 apple=$2 target=$3
E=chrome-extension://khbiipgidcclbakblacconmmpnacljae
export AGENT_BROWSER_SESSION=capture-$lang
agent-browser close >/dev/null 2>&1 || true
sleep 1
AGENT_BROWSER_COLOR_SCHEME=light agent-browser --extension "$PWD/../extension" \
  --args "-AppleLanguages,($apple)" open $E/options.html >/dev/null
agent-browser set viewport 760 1400 2 >/dev/null
agent-browser eval "chrome.storage.local.set({provider:'chatgpt'}).then(()=>chrome.storage.sync.set({target:'$target',source:'Auto'})).then(()=>location.reload()).then(()=>'ok')" >/dev/null
sleep 1.2
agent-browser eval "document.querySelector('input[value=chatgpt]').closest('label').id='gpt'; chrome.i18n.getUILanguage()"
agent-browser screenshot "#gpt" "$PWD/shots/ui-chatgpt-$lang.png" >/dev/null
agent-browser set viewport 268 400 2 >/dev/null
agent-browser open $E/popup.html >/dev/null
sleep 0.6
# The popup asks which tab it was opened over; point that at pixiv, then render it again.
agent-browser eval "chrome.tabs.query = async () => [{ url: 'https://www.pixiv.net/artworks/1' }]; const o = document.getElementById('app'); const f = document.createElement('div'); f.id = 'app'; o.replaceWith(f); const s = document.createElement('script'); s.src = 'dist/popup.js?again'; document.body.append(s); 'ok'" >/dev/null
sleep 1
H=$(agent-browser eval "document.querySelector('#app input[type=checkbox]').click(); String(Math.ceil(document.getElementById('app').getBoundingClientRect().bottom + 14))" | tr -d '"')
agent-browser set viewport 268 "$H" 2 >/dev/null
sleep 0.3
agent-browser screenshot "$PWD/shots/ui-popup-site-$lang.png" >/dev/null
agent-browser close >/dev/null
