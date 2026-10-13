// Fonctions exécutées DANS la page icloud.com (monde principal), via
// chrome.scripting. Apple ne fournit pas d'API : on passe par les objets de ses
// propres applications web, qui écrivent alors les données au bon format.
// Chaque fonction est autonome : elle est copiée telle quelle dans la page.
// Elles renvoient { waiting } tant que l'application n'est pas prête, puis
// { ok: true, ... } ou { error, detail }.

// Notes. action : 'list' (notes récentes), 'create' (payload.text) ou
// 'append' (payload.noteId, payload.text).
export async function notesInPage(action, payload = {}) {
  // L'application tourne dans un cadre de la page, pas dans la page elle-même.
  let app = null;
  const stack = [window];
  while (stack.length && !app) {
    const frame = stack.pop();
    try {
      if (frame.NotesApp?.dataManager) app = frame.NotesApp;
      for (let i = 0; i < frame.frames.length; i++) stack.push(frame.frames[i]);
    } catch {
      // cadre d'un autre site (connexion Apple) : inaccessible
    }
  }
  if (!app) return { waiting: 'app' };

  const { dataManager } = app;
  const folders = dataManager.allFolders;
  const notes = dataManager.allNotes;
  if (!Array.isArray(folders) || !folders.length) return { waiting: 'folders' };
  if (!Array.isArray(notes) || !notes.length) return { waiting: 'notes' };

  const saved = (note) =>
    Promise.race([
      Promise.resolve(note.save(true)).then(() => ({ ok: true })),
      new Promise((resolve) => setTimeout(() => resolve({ error: 'save', detail: 'timeout' }), 15000)),
    ]);
  const editable = (note) => note && !note.Deleted && !note.isInTrashOrDeleted && !note.isLocked && !note.isReadOnly;

  try {
    if (action === 'list') {
      const recent = notes
        .filter(editable)
        .sort((a, b) => Number(new Date(b.ModificationDate)) - Number(new Date(a.ModificationDate)))
        .slice(0, 12);
      return { ok: true, notes: recent.map((note) => ({ id: String(note.id), title: String(note.Title || 'Sans titre') })) };
    }

    if (action === 'create') {
      // La classe des notes n'est pas exposée : on la reprend d'une note existante.
      const sample = app.mainViewModel?.selectedNote ?? notes[0];
      const Note = sample.constructor;
      if (typeof Note.createNoteWithTitleText !== 'function') return { error: 'model', detail: 'createNoteWithTitleText' };
      const folder =
        folders.find((item) => String(item.recordName) === 'DefaultFolder-CloudKit') ??
        folders.find((item) => String(item.Title) === 'Notes') ??
        sample.getFolder?.();
      if (!folder) return { error: 'model', detail: 'folder' };
      const note = Note.createNoteWithTitleText(payload.text, folder);
      dataManager.userDidCreateNote(note);
      return await saved(note);
    }

    if (action === 'append') {
      const note = notes.find((item) => String(item.id) === payload.noteId);
      if (!note) return { error: 'missing' };
      if (!editable(note)) return { error: 'locked' };
      // Le texte d'une note est un objet qui garde mise en forme, cases et
      // pièces jointes. On y insère à la fin, comme le fait l'éditeur d'Apple,
      // au lieu de réécrire la note.
      const manager = dataManager.topoTextManager;
      manager.retain(note.id);
      try {
        const body = await note.getTopoText();
        if (typeof body?.insertString !== 'function' || typeof body.atEnd !== 'function') return { error: 'model', detail: 'topoText' };
        const end = body.atEnd();
        const endsWithNewline = body.toString().endsWith('\n');
        body.insertString(end, endsWithNewline ? `${payload.text}\n` : `\n${payload.text}`, end.affinity);
        const result = await saved(note);
        dataManager.userDidModifyNote?.(note);
        return result;
      } finally {
        manager.release(note.id);
      }
    }
  } catch (error) {
    return { error: 'save', detail: String(error?.message ?? error) };
  }
  return { error: 'model', detail: action };
}

// Rappels : crée une tâche dans la liste nommée `listName`.
// due : null, ou { year, month, day, hour, minute, allDay } pour l'échéance.
// L'application ne s'expose pas en variable globale ; on retrouve son objet de
// données dans l'arbre de composants de la page.
export async function remindersInPage(title, notes, due, listName) {
  const isData = (value) =>
    typeof value?.createNewReminder === 'function' && typeof value.commitReminder === 'function' && typeof value.getTopoTextString === 'function';
  const isList = (value) => value && typeof value === 'object' && typeof value.pk === 'string' && value.pk.includes('List/') && 'Name' in value;
  let data = null;
  // Les listes de rappels, relevées dans ce que la page affiche (barre latérale).
  const lists = new Map();

  const stack = [window];
  while (stack.length && !data) {
    const frame = stack.pop();
    try {
      for (let i = 0; i < frame.frames.length; i++) stack.push(frame.frames[i]);
      // La page est faite de plusieurs arbres indépendants : on remonte de
      // chaque élément jusqu'à la racine du sien pour les trouver tous.
      const roots = new Set();
      let fiberKey;
      for (const element of frame.document.querySelectorAll('body *')) {
        fiberKey ??= Object.keys(element).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
        let fiber = fiberKey && element[fiberKey];
        if (!fiber) continue;
        while (fiber.return) fiber = fiber.return;
        roots.add(fiber);
      }
      const pending = [...roots];
      for (let visited = 0; pending.length && visited < 200000; visited++) {
        const node = pending.pop();
        const props = node.memoizedProps;
        if (props && typeof props === 'object') {
          if (isData(props.value)) data = props.value;
          for (const value of Object.values(props)) {
            if (isList(value)) lists.set(value.pk, value);
            else if (Array.isArray(value)) for (const item of value) if (isList(item)) lists.set(item.pk, item);
          }
        }
        if (node.sibling) pending.push(node.sibling);
        if (node.child) pending.push(node.child);
      }
    } catch {
      // cadre d'un autre site : inaccessible
    }
  }
  if (!data) return { waiting: 'app' };
  if (!lists.size) return { waiting: 'lists' };
  const wanted = listName.trim().toLowerCase();
  const list = [...lists.values()].find((item) => !item.IsGroup && !item.Deleted && String(item.Name ?? '').trim().toLowerCase() === wanted)?.pk;
  if (!list) return { error: 'group' };

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const write = (reminderKey, documentId, text) => {
    const body = data.getTopoTextString(reminderKey, documentId);
    const end = body.atEnd();
    body.insertString(end, text, end.affinity);
  };

  try {
    const key = await data.createNewReminder(list);
    const reminder = data.getReminder(key);
    write(key, reminder.TitleDocument, title);
    data.titleTextChange(reminder);
    let notesWritten = !notes;
    if (notes) {
      try {
        write(key, reminder.NotesDocument, notes);
        data.notesTextChange(reminder);
        notesWritten = true;
      } catch {
        // pas de champ de notes sur ce rappel : le titre suffit
      }
    }
    // Les changements de texte sont enregistrés au tour suivant ; on valide ensuite le rappel.
    await pause(300);
    data.commitReminder(key);
    await pause(1200);

    // L'échéance s'ajoute comme dans le panneau de détails d'un rappel existant.
    // Si elle échoue, la tâche existe déjà : on le signale sans tout annuler.
    let dueWritten = !due;
    if (due && typeof data.writeReminderFields === 'function') try {
      const saved = data.getReminder(key);
      await data.writeReminderFields(key, {
        AlarmTriggerDateObject: {
          dateComponentData: {
            year: due.year,
            month: due.month,
            day: due.day,
            hour: due.allDay ? 0 : due.hour,
            minute: due.allDay ? 0 : due.minute,
            second: 0,
            timeZone: { identifier: Intl.DateTimeFormat().resolvedOptions().timeZone },
          },
          allDay: due.allDay,
          deleted: false,
          type: 'Date',
        },
        TitleDocument: saved.TitleDocument,
        NotesDocument: saved.NotesDocument,
      });
      await pause(800);
      dueWritten = true;
    } catch {
      // échéance refusée : dueWritten reste faux
    }
    return { ok: true, notesWritten, dueWritten };
  } catch (error) {
    return { error: 'save', detail: String(error?.message ?? error) };
  }
}

// Calendrier : crée un évènement dans le calendrier nommé details.calendarName.
// details : { title, description, allDay, start, end, calendarName }, les dates sous la forme
// [année, mois, jour, heure, minute] dans le fuseau du compte iCloud.
// L'application garde son état dans un « store » ; on lui envoie les mêmes
// actions que lorsqu'on crée un évènement à la souris puis qu'on le valide.
export async function calendarInPage(details) {
  let store = null;
  const stack = [window];
  while (stack.length && !store) {
    const frame = stack.pop();
    try {
      for (let i = 0; i < frame.frames.length; i++) stack.push(frame.frames[i]);
      const roots = new Set();
      let fiberKey;
      for (const element of frame.document.querySelectorAll('body *')) {
        fiberKey ??= Object.keys(element).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
        let fiber = fiberKey && element[fiberKey];
        if (!fiber) continue;
        while (fiber.return) fiber = fiber.return;
        roots.add(fiber);
      }
      const pending = [...roots];
      for (let visited = 0; pending.length && visited < 200000 && !store; visited++) {
        const node = pending.pop();
        const props = node.memoizedProps;
        const candidate = props?.store ?? props?.value?.store;
        if (typeof candidate?.dispatch === 'function' && typeof candidate.getState === 'function' && candidate.getState()?.events?.value?.event) {
          store = candidate;
        }
        if (node.sibling) pending.push(node.sibling);
        if (node.child) pending.push(node.child);
      }
    } catch {
      // cadre d'un autre site : inaccessible
    }
  }
  if (!store) return { waiting: 'app' };

  const state = store.getState();
  if (state.events.value.event.list?.status !== 'ready') return { waiting: 'events' };
  const timeZone = state.environment?.value?.timeZone;
  const collections = state.collection?.value;
  if (!timeZone || !collections?.collectionRecords || !collections.list?.items?.length) return { waiting: 'calendars' };

  // Le calendrier du bon nom, parmi ceux où l'on peut écrire.
  const statuses = new Map(collections.list.items.map((item) => [item.id, item.status]));
  const wanted = details.calendarName.trim().toLowerCase();
  const calendar = [...statuses.keys()].find((id) => {
    const record = collections.collectionRecords[id]?.payload;
    const usable = record && !record.readOnly && !record.delegator && !['removed', 'failedToAdd'].includes(statuses.get(id));
    return usable && String(record.title ?? '').trim().toLowerCase() === wanted;
  });
  if (!calendar) return { error: 'group' };

  // Format de date d'iCloud : [AAAAMMJJ, année, mois, jour, heure, minute, minutes depuis minuit].
  const tuple = ([year, month, day, hour, minute]) => [year * 10000 + month * 100 + day, year, month, day, hour, minute, hour * 60 + minute];
  const minutes = ([year, month, day, hour, minute]) => Date.UTC(year, month - 1, day, hour, minute) / 60000;
  const today = new Date();
  const now = tuple([today.getFullYear(), today.getMonth() + 1, today.getDate(), today.getHours(), today.getMinutes()]);
  const start = tuple(details.start);
  const end = tuple(details.end);
  const guid = crypto.randomUUID();
  const event = {
    guid,
    etag: '',
    title: details.title,
    allDay: details.allDay,
    startDate: start,
    endDate: end,
    localStartDate: start,
    localEndDate: end,
    duration: minutes(details.end) - minutes(details.start),
    pGuid: calendar,
    tz: timeZone,
    extendedDetailsAreIncluded: true,
    icon: 0,
    readOnly: false,
    birthdayIsYearlessBday: false,
    birthdayShowAsCompany: false,
    shouldShowJunkUIWhenAppropriate: false,
    recurrenceException: false,
    recurrenceMaster: false,
    hasAttachments: false,
    attachments: [],
    alarms: [],
    createdDate: now,
    lastModifiedDate: now,
    transparent: false,
  };
  if (details.description) event.description = details.description;

  const isSaving = () => Boolean(store.getState().events.value.event.isSavingEventDetails?.[guid]);
  // L'envoi au serveur démarre juste après la validation. On suit son début et
  // sa fin par les changements du store, pas par une attente répétée : Chrome
  // ralentit fortement les minuteries d'une page qui n'est pas affichée.
  let started = false;
  let unsubscribe = () => {};
  const timers = [];
  const outcome = new Promise((resolve) => {
    unsubscribe = store.subscribe(() => {
      if (isSaving()) started = true;
      else if (started) {
        const status = store.getState().events.value.event.list.items.find((item) => item.id === guid)?.status;
        resolve(status === 'failedToAdd' ? { error: 'save', detail: 'refusé par iCloud' } : { ok: true });
      }
    });
    timers.push(setTimeout(() => !started && resolve({ error: 'save', detail: 'envoi non démarré' }), 5000));
    timers.push(setTimeout(() => resolve({ error: 'save', detail: 'timeout' }), 15000));
  });
  try {
    store.dispatch({ type: 'events/newEventCreatedWithDetails', payload: { guid, overrides: event, displayVariant: 'FindAndOpen', ignoreSyncer: true } });
    store.dispatch({ type: 'events/eventDetailsLoaded', payload: { Event: [event] } });
    store.dispatch({ type: 'events/eventDetailsSaved', payload: { eventGuid: guid, localEventDetails: event } });
    // Referme le panneau de détails que la création a ouvert.
    store.dispatch({ type: 'events/eventUninspected' });
    return await outcome;
  } catch (error) {
    return { error: 'save', detail: String(error?.message ?? error) };
  } finally {
    unsubscribe();
    timers.forEach(clearTimeout);
  }
}

// Diagnostic : décrit la FORME des objets de l'application (noms de classes,
// de méthodes et de propriétés), jamais leur contenu. Sert à savoir comment
// piloter Notes, Rappels et Calendrier quand Apple change quelque chose.
export async function inspectPage() {
  const MAX_NODES = 500;
  const MAX_KEYS = 80;
  const MAX_CHILDREN = 40;
  const EXPLORED = new Set(['Object', 'Function', 'Array', 'Map', 'Set', 'Module']);
  const PRIORITY = /app|note|remind|calend|cloud|^ck|model|store|manager/i;

  const tag = (value) => Object.prototype.toString.call(value).slice(8, -1);
  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  // Une clé qui ressemble à un identifiant ou à du texte libre n'est pas recopiée.
  const clean = (key) => (key.length > 60 || /^[0-9a-f-]{20,}$/i.test(key) || /[@\s]/.test(key) ? '<id>' : key);
  const names = (object) => [...new Set(Object.getOwnPropertyNames(object).map(clean))].slice(0, MAX_KEYS);

  // Les variables globales que la page a ajoutées à un navigateur vierge.
  let baseline = new Set();
  try {
    const blank = document.createElement('iframe');
    blank.style.display = 'none';
    document.documentElement.append(blank);
    baseline = new Set(Object.getOwnPropertyNames(blank.contentWindow));
    blank.remove();
  } catch {
    // création de cadre refusée : toutes les globales seront listées
  }

  const describeWindow = async (frame) => {
    const classes = [];
    const classIds = new Map();
    const nodes = [];
    const seen = new Set();

    const isBuiltin = (proto) =>
      Object.getPrototypeOf(proto) === null ||
      (hasOwn(proto, 'bind') && hasOwn(proto, 'apply')) ||
      (hasOwn(proto, 'splice') && hasOwn(proto, 'push')) ||
      ['Map', 'Set'].includes(tag(proto));

    const classOf = (proto) => {
      if (!proto || isBuiltin(proto)) return null;
      if (classIds.has(proto)) return classIds.get(proto);
      const id = classes.length;
      classIds.set(proto, id);
      const entry = { name: '', methods: [], getters: [] };
      classes.push(entry);
      for (const key of Object.getOwnPropertyNames(proto).slice(0, 400)) {
        if (key === 'constructor') continue;
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (descriptor.get) entry.getters.push(key);
        else if (typeof descriptor.value === 'function') entry.methods.push(key);
      }
      const constructor = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value;
      if (typeof constructor === 'function') {
        entry.name = constructor.name;
        const statics = names(constructor).filter((key) => !['length', 'name', 'prototype', 'arguments', 'caller'].includes(key));
        if (statics.length) entry.statics = statics;
      }
      const parent = classOf(Object.getPrototypeOf(proto));
      if (parent !== null) entry.parent = parent;
      return id;
    };

    const gettersOf = (classId) => {
      const found = [];
      for (let id = classId; id !== null && id !== undefined; id = classes[id].parent) found.push(...classes[id].getters);
      return found;
    };

    const globals = Object.getOwnPropertyNames(frame).filter((key) => !baseline.has(key) && !/^\d+$/.test(key));
    const queue = [];
    for (const key of globals.slice().sort((a, b) => PRIORITY.test(b) - PRIORITY.test(a))) {
      try {
        queue.push({ path: key, value: frame[key], depth: 0, maxDepth: PRIORITY.test(key) ? 5 : 2 });
      } catch {
        // globale illisible
      }
    }

    while (queue.length && nodes.length < MAX_NODES) {
      const { path, value, depth, maxDepth } = queue.shift();
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) continue;
      let kind;
      try {
        kind = tag(value);
        if (!EXPLORED.has(kind) || typeof value.nodeType === 'number' || seen.has(value)) continue;
      } catch {
        continue;
      }
      seen.add(value);
      const node = { path };
      nodes.push(node);
      const deeper = depth < maxDepth;
      const child = (suffix, read) => {
        if (!deeper) return;
        try {
          queue.push({ path: path + suffix, value: read(), depth: depth + 1, maxDepth });
        } catch {
          // propriété qui refuse la lecture
        }
      };

      if (kind === 'Array') {
        node.length = value.length;
        if (value.length) child('[0]', () => value[0]);
      } else if (kind === 'Map' || kind === 'Set') {
        node.size = value.size;
        if (value.size) child('<valeur>', () => value.values().next().value);
      } else {
        const own = Object.getOwnPropertyNames(value);
        node.keys = names(value);
        let getters = [];
        if (typeof value === 'function') {
          node.function = value.name;
          // Une simple fonction a un prototype vide : seules les classes sont décrites.
          if (value.prototype && Object.getOwnPropertyNames(value.prototype).length > 1) node.prototype = classOf(value.prototype);
        } else {
          node.class = classOf(Object.getPrototypeOf(value));
          getters = gettersOf(node.class);
        }
        for (const key of [...own.filter((name) => clean(name) === name).slice(0, MAX_CHILDREN), ...getters]) {
          if (['arguments', 'caller', 'prototype'].includes(key)) continue;
          child(`.${key}`, () => value[key]);
        }
      }
    }

    // Pour Notes : la classe du texte d'une note, nécessaire pour y ajouter du texte proprement.
    const extra = {};
    try {
      const note = frame.NotesApp?.dataManager?.allNotes?.[0];
      if (note) {
        extra.noteClass = classOf(Object.getPrototypeOf(note));
        const topoText = await note.getTopoText();
        extra.topoTextType = typeof topoText;
        if (topoText && typeof topoText === 'object') extra.topoTextClass = classOf(Object.getPrototypeOf(topoText));
      }
    } catch (error) {
      extra.error = String(error?.message ?? error);
    }

    // Pour les applications sans variable globale (Rappels) : ce que leurs
    // arbres de composants mettent à disposition, toujours en noms seulement.
    try {
      const roots = new Set();
      let fiberKey;
      for (const element of frame.document.querySelectorAll('body *')) {
        fiberKey ??= Object.keys(element).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
        let fiber = fiberKey && element[fiberKey];
        if (!fiber) continue;
        while (fiber.return) fiber = fiber.return;
        roots.add(fiber);
      }
      if (roots.size) {
        const providers = [];
        const propNames = new Set();
        const values = new Set();
        const pending = [...roots];
        let visited = 0;
        for (; pending.length && visited < 200000; visited++) {
          const fiber = pending.pop();
          const props = fiber.memoizedProps;
          if (props && typeof props === 'object' && !Array.isArray(props)) {
            if (propNames.size < 400) for (const name of names(props)) propNames.add(name);
            const value = props.value;
            if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.nodeType !== 'number' && !values.has(value) && providers.length < 80) {
              values.add(value);
              const proto = Object.getPrototypeOf(value);
              providers.push({ keys: names(value), methods: proto && !isBuiltin(proto) ? names(proto) : [] });
            }
          }
          if (fiber.sibling) pending.push(fiber.sibling);
          if (fiber.child) pending.push(fiber.child);
        }
        extra.react = { key: fiberKey.split('$')[0], roots: roots.size, fibers: visited, providers, propNames: [...propNames] };
      }
    } catch (error) {
      extra.reactError = String(error?.message ?? error);
    }

    return { path: frame.location.pathname.split('/').slice(0, 3).join('/'), globals: globals.slice(0, 200), nodes, classes, extra };
  };

  const frames = [];
  const stack = [window];
  while (stack.length) {
    const frame = stack.pop();
    try {
      frame.location.href; // lève une erreur pour un cadre d'un autre site
      frames.push(await describeWindow(frame));
      for (let i = 0; i < frame.frames.length; i++) stack.push(frame.frames[i]);
    } catch (error) {
      frames.push({ error: String(error?.message ?? error) });
    }
  }
  return { title: document.title, frames };
}
