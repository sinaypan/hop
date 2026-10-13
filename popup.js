const DRAFT_KEY = 'draft';
const text = document.getElementById('text');
const target = document.getElementById('target');
const notesGroup = document.getElementById('notes');
const sendButton = document.getElementById('send');
const status = document.getElementById('status');
const when = document.getElementById('when');
const date = document.getElementById('date');
const time = document.getElementById('time');
const duration = document.getElementById('duration');

let sending = false;

const setStatus = (message, isError = false) => {
  status.textContent = message;
  status.classList.toggle('error', isError);
};

const refresh = () => {
  sendButton.disabled = sending || !text.value.trim();
};

// Le texte en cours survit à la fermeture de la fenêtre, jusqu'à l'envoi.
text.value = localStorage.getItem(DRAFT_KEY) ?? '';
refresh();

text.addEventListener('input', () => {
  localStorage.setItem(DRAFT_KEY, text.value);
  refresh();
});

// La date ne sert qu'aux évènements. Par défaut : dans une heure, à l'heure pleine.
const pad = (value) => String(value).padStart(2, '0');
const nextHour = new Date(Date.now() + 3600000);
date.value = `${nextHour.getFullYear()}-${pad(nextHour.getMonth() + 1)}-${pad(nextHour.getDate())}`;
time.value = `${pad(nextHour.getHours())}:00`;

// Un évènement a une durée ; une tâche a, au choix, une échéance.
const WHEN_CHOICES = {
  event: [['30', '30 min'], ['60', '1 h'], ['120', '2 h'], ['day', 'Journée']],
  task: [['none', 'Sans date'], ['time', 'Avec heure'], ['day', 'Journée']],
};
const WHEN_DEFAULT = { event: '60', task: 'none' };

const showWhen = () => {
  date.disabled = duration.value === 'none';
  time.disabled = duration.value === 'none' || duration.value === 'day';
};

const showTarget = () => {
  const choices = WHEN_CHOICES[target.value];
  when.hidden = !choices;
  if (!choices) return;
  duration.replaceChildren(...choices.map(([value, label]) => new Option(label, value)));
  duration.value = WHEN_DEFAULT[target.value];
  showWhen();
};
target.addEventListener('change', showTarget);
duration.addEventListener('change', showWhen);

// Du texte sélectionné dans la page : il est repris, avec l'adresse de la page.
const useSelection = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => getSelection().toString() });
    const selection = injection?.result?.trim();
    if (!selection) return;
    text.value = /^https?:/.test(tab.url ?? '') ? `${selection}\n\n${tab.url}` : selection;
    text.select();
    refresh();
  } catch {
    // page où Chrome n'autorise pas la lecture (nouvel onglet, chrome://...)
  }
};

const loadNotes = async () => {
  const notes = (await chrome.runtime.sendMessage({ type: 'recent-notes' })) ?? [];
  notesGroup.replaceChildren(...notes.map((note) => new Option(note.title, `append:${note.id}`)));
  notesGroup.hidden = !notes.length;
};

const send = async () => {
  const value = text.value.trim();
  if (!value || sending) return;
  sending = true;
  refresh();
  setStatus('Envoi…');
  const [kind, noteId] = target.value.split(/:(.*)/s);
  const outcome = await chrome.runtime.sendMessage({
    type: 'send',
    target: kind,
    noteId,
    text: value,
    date: date.value,
    time: time.value,
    duration: duration.value,
  });
  sending = false;
  if (outcome?.kind === 'done') {
    localStorage.removeItem(DRAFT_KEY);
    text.value = '';
    setStatus(outcome.text);
  } else {
    setStatus(outcome?.text ?? 'Envoi interrompu.', true);
  }
  refresh();
};

sendButton.addEventListener('click', send);
text.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send();
});

document.getElementById('diagnostic').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'diagnostic' });
  setStatus('Diagnostic en cours, environ 30 s…');
});

// Un envoi qui a échoué après la fermeture de cette fenêtre : on le dit ici.
chrome.runtime.sendMessage({ type: 'last-outcome' }).then((outcome) => {
  if (outcome && !status.textContent) setStatus(outcome.text, true);
});

useSelection();
loadNotes();
