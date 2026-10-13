const DRAFT_KEY = 'draft';
const MODE_KEY = 'mode';
const byId = (id) => document.getElementById(id);

const text = byId('text');
const sendButton = byId('send');
const status = byId('status');
const notesList = byId('notes');
const notesHint = byId('notes-hint');
const picker = byId('picker');

// Ce que chaque onglet affiche et envoie.
const MODES = {
  note: { placeholder: 'Titre de la note, puis le texte.' },
  task: { placeholder: 'La tâche. Les lignes suivantes vont dans ses notes.' },
  event: { placeholder: 'Titre de l’évènement, puis la description.' },
};

// Un jour est { year, month, day }, le mois de 1 à 12.
const toDay = (date) => ({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() });
const toDate = (day) => new Date(day.year, day.month - 1, day.day);
const sameDay = (a, b) => a.year === b.year && a.month === b.month && a.day === b.day;
const pad = (value) => String(value).padStart(2, '0');

// Par défaut : dans une heure, à l'heure pleine.
const nextHour = new Date(Date.now() + 3600000);

const state = {
  mode: MODES[localStorage.getItem(MODE_KEY)] ? localStorage.getItem(MODE_KEY) : 'note',
  noteMode: 'new', // 'new' ou 'append'
  noteId: null,
  notes: null, // null tant que la liste n'est pas arrivée
  taskWhen: 'none', // 'none', 'day' ou 'time'
  eventLength: '60', // minutes, ou 'day'
  date: toDay(nextHour),
  time: { hour: nextHour.getHours(), minute: 0 },
  picker: null, // 'date' ou 'time' : le sélecteur ouvert
  view: { year: nextHour.getFullYear(), month: nextHour.getMonth() + 1 }, // mois affiché par le calendrier
  sending: false,
};

const setStatus = (message, isError = false) => {
  status.textContent = message;
  status.classList.toggle('error', isError);
};

const element = (tag, properties = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
};

const sendLabel = () => {
  if (state.mode === 'task') return 'Créer la tâche';
  if (state.mode === 'event') return 'Créer l’évènement';
  return state.noteMode === 'append' ? 'Ajouter' : 'Créer la note';
};

const DAY_FORMAT = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const MONTH_FORMAT = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });

const dayLabel = (day) => {
  const today = toDay(new Date());
  if (sameDay(day, today)) return 'Aujourd’hui';
  if (sameDay(day, toDay(new Date(today.year, today.month - 1, today.day + 1)))) return 'Demain';
  return DAY_FORMAT.format(toDate(day));
};

const pressChips = (id, value) => {
  for (const button of byId(id).children) button.setAttribute('aria-pressed', String(button.dataset.value === value));
};

const renderNotes = () => {
  const appending = state.noteMode === 'append';
  notesList.hidden = !appending || !state.notes?.length;
  notesHint.hidden = !appending || Boolean(state.notes?.length);
  notesHint.textContent = state.notes ? 'Aucune note trouvée. Ouvre icloud.com/notes et connecte-toi.' : 'Chargement des notes…';
  notesList.replaceChildren(
    ...(state.notes ?? []).map((note) => {
      const item = element('li', { title: note.title }, element('span', { textContent: note.title }));
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(note.id === state.noteId));
      item.dataset.id = note.id;
      return item;
    }),
  );
};

// Un mois, du lundi au dimanche.
const calendar = () => {
  const { year, month } = state.view;
  const first = new Date(year, month - 1, 1);
  const today = toDay(new Date());
  const title = MONTH_FORMAT.format(first);
  const arrow = (label, shift, path) => {
    const button = element('button', { type: 'button', className: 'arrow', ariaLabel: label });
    button.dataset.shift = shift;
    button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}" /></svg>`;
    return button;
  };
  const header = element(
    'div',
    { className: 'month' },
    arrow('Mois précédent', -1, 'M9.8 3.6L5.4 8l4.4 4.4'),
    element('strong', { textContent: title[0].toUpperCase() + title.slice(1) }),
    arrow('Mois suivant', 1, 'M6.2 3.6L10.6 8l-4.4 4.4'),
  );
  const grid = element('div', { className: 'days' }, ...['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((name) => element('span', { textContent: name })));
  // Cases vides avant le 1er : getDay() compte à partir du dimanche.
  for (let blank = (first.getDay() + 6) % 7; blank > 0; blank--) grid.append(element('i'));
  const count = new Date(year, month, 0).getDate();
  for (let day = 1; day <= count; day++) {
    const button = element('button', { type: 'button', textContent: day });
    button.dataset.day = day;
    if (sameDay({ year, month, day }, today)) button.classList.add('today');
    button.setAttribute('aria-pressed', String(sameDay({ year, month, day }, state.date)));
    grid.append(button);
  }
  return [header, grid];
};

// Heures de 0 à 23, minutes de 5 en 5.
const clock = () => {
  const choices = (name, values, current) =>
    element(
      'div',
      { className: 'slots' },
      ...values.map((value) => {
        const button = element('button', { type: 'button', textContent: pad(value) });
        button.dataset[name] = value;
        button.setAttribute('aria-pressed', String(value === current));
        return button;
      }),
    );
  return [
    element('p', { className: 'caption', textContent: 'Heure' }),
    choices('hour', Array.from({ length: 24 }, (_, hour) => hour), state.time.hour),
    element('p', { className: 'caption', textContent: 'Minutes' }),
    choices('minute', Array.from({ length: 12 }, (_, step) => step * 5), state.time.minute),
  ];
};

// Les notes récentes ne sont demandées que pour « Ajouter à une note » : la
// demande charge l'onglet Notes d'iCloud, inutile pour une tâche ou un évènement.
let notesRequested = false;
const loadNotes = async () => {
  if (notesRequested || state.mode !== 'note' || state.noteMode !== 'append') return;
  notesRequested = true;
  state.notes = (await chrome.runtime.sendMessage({ type: 'recent-notes' })) ?? [];
  render();
};

const render = () => {
  const { mode } = state;
  document.body.dataset.mode = mode;
  for (const tab of byId('modes').children) tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
  text.placeholder = MODES[mode].placeholder;

  byId('note-options').hidden = mode !== 'note';
  byId('task-when').hidden = mode !== 'task';
  byId('event-length').hidden = mode !== 'event';
  pressChips('note-mode', state.noteMode);
  pressChips('task-when', state.taskWhen);
  pressChips('event-length', state.eventLength);
  renderNotes();

  // Seuls les champs utiles sont affichés.
  const withDate = mode === 'event' || (mode === 'task' && state.taskWhen !== 'none');
  const withTime = (mode === 'event' && state.eventLength !== 'day') || (mode === 'task' && state.taskWhen === 'time');
  if ((state.picker === 'date' && !withDate) || (state.picker === 'time' && !withTime)) state.picker = null;
  byId('when').hidden = !withDate;
  byId('time-button').hidden = !withTime;
  byId('date-button').lastElementChild.textContent = dayLabel(state.date);
  byId('time-button').lastElementChild.textContent = `${pad(state.time.hour)}:${pad(state.time.minute)}`;
  byId('date-button').setAttribute('aria-expanded', String(state.picker === 'date'));
  byId('time-button').setAttribute('aria-expanded', String(state.picker === 'time'));

  picker.hidden = !state.picker;
  picker.className = state.picker ?? '';
  picker.replaceChildren(...(state.picker === 'date' ? calendar() : state.picker === 'time' ? clock() : []));
  document.body.classList.toggle('picking', Boolean(state.picker));

  const missingNote = mode === 'note' && state.noteMode === 'append' && !state.noteId;
  sendButton.textContent = sendLabel();
  sendButton.disabled = state.sending || !text.value.trim() || missingNote;
  loadNotes();
};

// Le texte en cours survit à la fermeture de la fenêtre, jusqu'à l'envoi.
text.value = localStorage.getItem(DRAFT_KEY) ?? '';
text.addEventListener('input', () => {
  localStorage.setItem(DRAFT_KEY, text.value);
  render();
});

byId('modes').addEventListener('click', (event) => {
  const tab = event.target.closest('button[data-mode]');
  if (!tab) return;
  state.mode = tab.dataset.mode;
  state.picker = null;
  localStorage.setItem(MODE_KEY, state.mode);
  render();
  text.focus();
});

const bindChips = (id, key) => {
  byId(id).addEventListener('click', (event) => {
    const chip = event.target.closest('button[data-value]');
    if (!chip) return;
    state[key] = chip.dataset.value;
    render();
  });
};
bindChips('note-mode', 'noteMode');
bindChips('task-when', 'taskWhen');
bindChips('event-length', 'eventLength');

notesList.addEventListener('click', (event) => {
  const item = event.target.closest('li[data-id]');
  if (!item) return;
  state.noteId = item.dataset.id;
  render();
});

byId('date-button').addEventListener('click', () => {
  state.picker = state.picker === 'date' ? null : 'date';
  state.view = { year: state.date.year, month: state.date.month };
  render();
});

byId('time-button').addEventListener('click', () => {
  state.picker = state.picker === 'time' ? null : 'time';
  render();
});

picker.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const { shift, day, hour, minute } = button.dataset;
  if (shift) {
    state.view = toDay(new Date(state.view.year, state.view.month - 1 + Number(shift), 1));
  } else if (day) {
    state.date = { year: state.view.year, month: state.view.month, day: Number(day) };
    state.picker = null;
  } else if (hour) {
    state.time.hour = Number(hour);
  } else if (minute) {
    // Les minutes se choisissent en dernier : le sélecteur se referme.
    state.time.minute = Number(minute);
    state.picker = null;
  }
  render();
});

// Du texte sélectionné dans la page : il est repris, avec l'adresse de la page.
const useSelection = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => getSelection().toString() });
    const selection = injection?.result?.trim();
    if (!selection) return;
    text.value = /^https?:/.test(tab.url ?? '') ? `${selection}\n\n${tab.url}` : selection;
    text.select();
    render();
  } catch {
    // page où Chrome n'autorise pas la lecture (nouvel onglet, chrome://...)
  }
};

const request = () => {
  const date = `${state.date.year}-${pad(state.date.month)}-${pad(state.date.day)}`;
  const time = `${pad(state.time.hour)}:${pad(state.time.minute)}`;
  if (state.mode === 'task') return { target: 'task', date, time, duration: state.taskWhen };
  if (state.mode === 'event') return { target: 'event', date, time, duration: state.eventLength };
  return state.noteMode === 'append' ? { target: 'append', noteId: state.noteId } : { target: 'note' };
};

const send = async () => {
  if (sendButton.disabled) return;
  state.sending = true;
  state.picker = null;
  render();
  setStatus('Envoi…');
  const outcome = await chrome.runtime.sendMessage({ type: 'send', text: text.value.trim(), ...request() });
  state.sending = false;
  if (outcome?.kind === 'done') {
    localStorage.removeItem(DRAFT_KEY);
    text.value = '';
    setStatus(outcome.text);
  } else {
    setStatus(outcome?.text ?? 'Envoi interrompu.', true);
  }
  render();
};

sendButton.addEventListener('click', send);
text.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send();
});

byId('diagnostic').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'diagnostic' });
  setStatus('Diagnostic en cours, environ 30 s…');
});

// Un envoi qui a échoué après la fermeture de cette fenêtre : on le dit ici.
chrome.runtime.sendMessage({ type: 'last-outcome' }).then((outcome) => {
  if (outcome && !status.textContent) setStatus(outcome.text, true);
});

render();
useSelection();
