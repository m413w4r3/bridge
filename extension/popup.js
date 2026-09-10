const dot = document.getElementById("dot");
const state = document.getElementById("state");
const detail = document.getElementById("detail");
const url = document.getElementById("url");
const token = document.getElementById("token");
const ui = document.getElementById("ui");

/**
 * Ce que le bridge annoncera dans /v1/bridge/capabilities, lu par le content
 * script. Affiché ici pour qu'un humain puisse le confronter à ce qu'il voit
 * réellement dans l'onglet — c'est tout l'intérêt d'un contrôle vérifiable.
 */
function describe(state) {
  if (!state) return "état de l'interface illisible";
  const modele = state.model.verified ? state.model.selected : `? (${state.model.reason})`;
  const recherche =
    state.web_search.verified
      ? state.web_search.enabled
        ? "activée"
        : "désactivée"
      : `? (${state.web_search.reason})`;
  return `Modèle : ${modele} — recherche web : ${recherche}`;
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "status" });
  dot.classList.toggle("on", Boolean(status?.connected));
  state.textContent = status?.connected ? "Connecté au serveur" : "Déconnecté";
  detail.textContent = status?.connected ? status.url : status?.lastError || "serveur local arrêté ?";

  const tabs = await chrome.tabs.query({
    url: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  });
  if (tabs.length === 0) {
    detail.textContent += " — aucun onglet chatgpt.com ouvert";
    ui.textContent = "";
    return;
  }

  const tab = tabs.find((t) => t.active) || tabs[tabs.length - 1];
  try {
    const answer = await chrome.tabs.sendMessage(tab.id, { type: "ui_state" });
    ui.textContent = describe(answer && answer.state);
  } catch {
    ui.textContent = "content script absent de l'onglet (recharge la page)";
  }
}

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ serverUrl: url.value.trim(), wsToken: token.value });
  await chrome.runtime.sendMessage({ type: "reconnect" });
  setTimeout(refresh, 600);
});

chrome.storage.local.get(["serverUrl", "wsToken"]).then(({ serverUrl, wsToken }) => {
  url.value = serverUrl || "ws://127.0.0.1:8001/ws";
  token.value = wsToken || "";
});
refresh();
setInterval(refresh, 1500);
