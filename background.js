// Hop envoie du texte vers Apple Notes, Rappels et Calendrier en passant par un onglet
// icloud.com où l'utilisateur est connecté : l'extension ne voit jamais le mot
// de passe Apple. L'onglet est ouvert en arrière-plan au premier envoi, puis
// réutilisé.

import { calendarInPage, inspectPage, notesInPage, remindersInPage } from './page.js';

const APPS = { notes: 'Notes', reminders: 'Rappels', calendar: 'Calendrier' };
// Les tâches et les évènements créés par Hop vont dans une liste et un
// calendrier de ce nom, pour les reconnaître et faire le tri ensuite.
const GROUP = 'Hop';
const MENU_NOTE = 'note-from-selection';
const MENU_TASK = 'task-from-selection';
const READY_TIMEOUT_MS = 12000;
const LIST_TIMEOUT_MS = 6000;
const LAST_OUTCOME_MS = 120000;
const POLL_MS = 500;

const appUrl = (app) => `https://www.icloud.com/${app}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Un envoi à la fois : deux envois simultanés ouvriraient deux onglets iCloud.
let queue = Promise.resolve();
const enqueue = (task) => {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
};

const runInPage = async (tabId, func, args = []) => {
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
    return injection?.result ?? null;
  } catch {
    return null; // page en cours de chargement ou page d'erreur
  }
};

const focusTab = async (tab) => {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
};

// L'onglet iCloud de l'application demandée ; `opened` s'il vient d'être (re)chargé.
const appTab = async (app, { active }) => {
  const [existing] = await chrome.tabs.query({ url: `${appUrl(app)}*` });
  if (!existing) return { tab: await chrome.tabs.create({ url: appUrl(app), active }), opened: true };
  // Onglet mis en veille par Chrome : il faut le recharger avant de s'en servir.
  if (existing.discarded) await chrome.tabs.reload(existing.id);
  return { tab: existing, opened: existing.discarded };
};

const untilReady = async (tabId, func, args, timeout) => {
  const deadline = Date.now() + timeout;
  let last = { waiting: 'app' };
  while (Date.now() < deadline) {
    const result = await runInPage(tabId, func, args);
    if (result && !result.waiting) return result;
    if (result) last = result;
    await sleep(POLL_MS);
  }
  return last;
};

// Exécute une fonction de page.js dans l'application iCloud voulue.
// `reveal` : afficher l'onglet s'il n'est pas prêt, puis réessayer.
// Le résultat porte `revealedTabId` quand l'onglet iCloud a dû être affiché.
const callApp = async (app, func, args, { reveal = true, timeout = READY_TIMEOUT_MS } = {}) => {
  const { tab } = await appTab(app, { active: false });
  let result = await untilReady(tab.id, func, args, timeout);
  if (result.waiting && reveal) {
    // Pas prêt : session iCloud expirée, ou onglet que Chrome n'a jamais affiché.
    await focusTab(tab);
    result = { ...(await untilReady(tab.id, func, args, timeout)), revealedTabId: tab.id };
  }
  return result;
};

// Une tâche a un titre d'une ligne ; le reste du texte va dans ses notes.
const splitTask = (text) => {
  const [title, ...rest] = text.trim().split('\n');
  return [title.trim(), rest.join('\n').trim()];
};

// Un évènement : `date` (AAAA-MM-JJ), `time` (HH:MM) et `duration` en minutes,
// ou 'day' pour la journée entière. Renvoie null si la date est incomplète.
const eventDetails = ({ text, date, time, duration }) => {
  const [title, description] = splitTask(text);
  const [year, month, day] = (date ?? '').split('-').map(Number);
  if (!year || !month || !day) return null;
  const parts = (value) => [value.getFullYear(), value.getMonth() + 1, value.getDate(), value.getHours(), value.getMinutes()];
  if (duration === 'day') {
    // Journée entière : de minuit à minuit le lendemain, comme le fait iCloud.
    return { title, description, allDay: true, start: [year, month, day, 0, 0], end: parts(new Date(year, month - 1, day + 1)) };
  }
  const length = Number(duration);
  if (!/^\d{1,2}:\d{2}$/.test(time ?? '') || !(length > 0)) return null;
  const [hour, minute] = time.split(':').map(Number);
  return { title, description, allDay: false, start: [year, month, day, hour, minute], end: parts(new Date(year, month - 1, day, hour, minute + length)) };
};

// L'échéance d'une tâche : `duration` vaut 'time' (date et heure), 'day' (date
// seule) ou autre chose (pas d'échéance, null). undefined si elle est incomplète.
const taskDue = ({ date, time, duration }) => {
  if (duration !== 'time' && duration !== 'day') return null;
  const [year, month, day] = (date ?? '').split('-').map(Number);
  if (!year || !month || !day) return undefined;
  if (duration === 'day') return { year, month, day, hour: 0, minute: 0, allDay: true };
  if (!/^\d{1,2}:\d{2}$/.test(time ?? '')) return undefined;
  const [hour, minute] = time.split(':').map(Number);
  return { year, month, day, hour, minute, allDay: false };
};

// `run` renvoie la fonction de page.js à exécuter et ses arguments, ou null
// si la demande est incomplète.
const TARGETS = {
  note: { app: 'notes', done: 'Note créée', run: ({ text }) => [notesInPage, ['create', { text }]] },
  append: { app: 'notes', done: 'Ajouté à la note', run: ({ text, noteId }) => [notesInPage, ['append', { text, noteId }]] },
  task: {
    app: 'reminders',
    done: 'Tâche créée',
    run: (request) => {
      const due = taskDue(request);
      return due !== undefined && [remindersInPage, [...splitTask(request.text), due, GROUP]];
    },
  },
  event: {
    app: 'calendar',
    done: 'Évènement créé',
    run: (request) => {
      const details = eventDetails(request);
      return details && [calendarInPage, [{ ...details, calendarName: GROUP }]];
    },
  },
};

const describe = (result, target) => {
  const app = APPS[target.app];
  if (result.ok) return { kind: 'done', text: result.dueWritten === false ? `${target.done}, mais sans sa date.` : target.done };
  if (result.error === 'group') {
    const what = target.app === 'calendar' ? 'un calendrier nommé' : 'une liste nommée';
    return { kind: 'error', text: `Crée ${what} « ${GROUP} » dans ${app}, puis réessaie.` };
  }
  if (result.waiting === 'app') return { kind: 'error', text: `Connecte-toi à iCloud dans l’onglet ${app}, puis réessaie.` };
  if (result.error === 'save') return { kind: 'error', text: `iCloud n’a pas confirmé l’enregistrement (${result.detail}).` };
  if (result.error === 'missing') return { kind: 'error', text: 'Cette note est introuvable. Rouvre Hop pour mettre la liste à jour.' };
  if (result.error === 'locked') return { kind: 'error', text: 'Cette note est verrouillée ou en lecture seule.' };
  return { kind: 'error', text: `${app} iCloud ne répond pas comme prévu (${result.waiting ?? result.detail}). Lance le diagnostic.` };
};

// Petit message en haut de la page d'où part l'envoi.
const showToastInPage = (text, kind) => {
  const ID = 'hop-toast';
  document.getElementById(ID)?.remove();
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647';
  const pill = document.createElement('div');
  pill.textContent = text;
  pill.style.cssText = `font:500 13px/1.3 system-ui,sans-serif;max-width:420px;padding:10px 16px;border-radius:18px;color:#fff;background:${
    kind === 'error' ? '#b3261e' : '#1c1c1e'
  };box-shadow:0 6px 24px rgba(0,0,0,.28)`;
  host.attachShadow({ mode: 'open' }).append(pill);
  document.documentElement.append(host);
  setTimeout(() => host.remove(), kind === 'pending' ? 45000 : kind === 'error' ? 6000 : 2400);
};

const toast = (tabId, text, kind) =>
  chrome.scripting.executeScript({ target: { tabId }, func: showToastInPage, args: [text, kind] }).catch(() => {});

const flashBadge = async (ok) => {
  await chrome.action.setBadgeBackgroundColor({ color: ok ? '#1a7f37' : '#b3261e' });
  await chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
};

let lastOutcome = null;

// request : { target: 'note' | 'append' | 'task' | 'event', text, noteId?, date?, time?, duration? }
const send = async (request, sourceTabId) => {
  const target = TARGETS[request.target];
  if (!target || !request.text?.trim()) return { kind: 'error', text: 'Rien à envoyer.' };
  const call = target.run(request);
  if (!call) return { kind: 'error', text: 'Choisis une date et une heure.' };
  if (sourceTabId !== undefined) toast(sourceTabId, `Envoi vers ${APPS[target.app]}…`, 'pending');
  const [func, args] = call;
  const result = await enqueue(() => callApp(target.app, func, args)).catch((error) => ({ error: 'save', detail: String(error?.message ?? error) }));
  const outcome = describe(result, target);
  // Afficher l'onglet iCloud a fermé la fenêtre de Hop : le message s'affiche
  // dans cet onglet, et Hop le redonne à sa prochaine ouverture.
  for (const tabId of new Set([sourceTabId, result.revealedTabId])) {
    if (tabId !== undefined) toast(tabId, outcome.text, outcome.kind);
  }
  lastOutcome = { ...outcome, at: Date.now() };
  flashBadge(outcome.kind === 'done');
  return outcome;
};

// Les notes récentes, pour le choix « Ajouter à ». Ouvre l'onglet Notes en
// arrière-plan s'il n'existe pas, ce qui prépare aussi le prochain envoi.
const recentNotes = async () => {
  const result = await enqueue(() => callApp('notes', notesInPage, ['list'], { reveal: false, timeout: LIST_TIMEOUT_MS })).catch(() => null);
  return result?.notes ?? [];
};

const downloadJson = (name, data) =>
  chrome.downloads.download({
    url: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(data, null, 1))}`,
    filename: name,
    conflictAction: 'overwrite',
  });

// Passe sur les trois applications iCloud, relève la forme de leurs objets et
// enregistre le tout dans Téléchargements/hop-diagnostic.json.
const runDiagnostic = async () => {
  const report = { version: chrome.runtime.getManifest().version, date: new Date().toISOString(), apps: {} };
  for (const app of Object.keys(APPS)) {
    const { tab, opened } = await appTab(app, { active: true });
    await focusTab(tab);
    await sleep(opened ? 12000 : 3000);
    report.apps[app] = (await runInPage(tab.id, inspectPage)) ?? { error: 'page inaccessible' };
  }
  await downloadJson('hop-diagnostic.json', report);
  flashBadge(true);
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_NOTE, title: 'Nouvelle note Apple avec la sélection', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU_TASK, title: 'Nouvelle tâche Apple avec la sélection', contexts: ['selection'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const selection = info.selectionText?.trim();
  if (!selection) return;
  // La note ou la tâche garde l'adresse de la page d'où vient le texte.
  const source = /^https?:/.test(info.pageUrl ?? '') ? info.pageUrl : '';
  if (info.menuItemId === MENU_NOTE) {
    send({ target: 'note', text: source ? `${selection}\n\n${source}` : selection }, tab?.id);
  } else if (info.menuItemId === MENU_TASK) {
    send({ target: 'task', text: `${selection.replace(/\s+/g, ' ')}\n${source}` }, tab?.id);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'send') {
    send(message).then(sendResponse);
    return true; // réponse asynchrone
  }
  if (message?.type === 'recent-notes') {
    recentNotes().then(sendResponse);
    return true;
  }
  if (message?.type === 'last-outcome') {
    // Seulement un échec récent : un succès a déjà été vu ou n'a plus d'intérêt.
    const recent = lastOutcome?.kind === 'error' && Date.now() - lastOutcome.at < LAST_OUTCOME_MS;
    sendResponse(recent ? lastOutcome : null);
    lastOutcome = null;
  }
  if (message?.type === 'diagnostic') enqueue(runDiagnostic);
});
