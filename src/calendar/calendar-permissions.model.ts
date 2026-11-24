/**
 * @fileoverview What one person may do with one calendar, answered per kind of content.
 *
 * A calendar holds four different things and a single CRUD flag cannot describe them: entries this
 * person wrote, entries somebody else wrote, dates projected from tickets, and copies pulled in from
 * an outside calendar. Each is granted separately, so "can edit" never silently means "can edit
 * everyone's" or "can change the ticket behind that date".
 *
 * Two rules hold everywhere:
 * - a share is additive, never subtractive: the strongest matching rule wins and nothing takes away;
 * - the space's own Calendar permissions are a ceiling, so sharing can never hand out more than the
 *   space allows. A calendar outside a space has no ceiling.
 */

/** Every flag, flat, so a route can name exactly the one it needs. */
export interface CalendarPermissions {
  /** Entries kept on the calendar itself. */
  events: {
    create: boolean;
    own_read: boolean;
    own_update: boolean;
    own_delete: boolean;
    others_read: boolean;
    others_update: boolean;
    others_delete: boolean;
  };

  /**
   * Dates projected from tickets. `update` writes back to the ticket and is additionally refused
   * unless the person may edit tickets in that ticket's own space; `delete` removes the source from
   * the calendar and never touches a ticket.
   */
  task_events: {
    read: boolean;
    update: boolean;
    delete: boolean;

    /** Show this calendar in the Linked tickets list. */
    list: boolean;

    /** Offer this calendar in the Link form, so tickets can be linked to it. */
    form: boolean;
  };

  /**
   * Copies brought in from a connected calendar. These act on the copy held here — no provider in
   * this codebase accepts writes, so nothing here reaches Google or Microsoft.
   */
  sync: {
    read: boolean;
    create: boolean;
    update: boolean;
    delete: boolean;

    /** Linking, running and unlinking the connection. */
    manage: boolean;
  };

  /**
   * The calendar object itself, apart from managing it.
   *
   * Split out so a share can hand over renaming or removing a calendar without also handing over its
   * settings, its share list and its ticket sources. `manage` still carries both.
   */
  calendar: {
    /** Name, colour, description and visibility. */
    edit: boolean;

    /** Removing the calendar. */
    delete: boolean;
  };

  /**
   * Which of the module's four tabs this person may reach.
   *
   * Shares are per calendar but the tab strip is one per module, so the strip shows a tab when any
   * reachable calendar grants it. Nothing here grants data — a tab is a doorway, not a permission.
   */
  tabs: {
    calendar: boolean;
    integrations: boolean;
    sharing: boolean;
    tickets: boolean;
  };

  /** The Link ticket tab: the form, its Link button and the list of linked tickets. */
  tickets: {
    form: boolean;
    link: boolean;
    list: boolean;
    delete: boolean;
    delete_many: boolean;
  };

  /**
   * This calendar's own connection to an outside calendar.
   *
   * Split out of `sync.manage` so a share can hand over linking or re-syncing without also handing
   * over the synced entries; `sync.manage` still carries all four. Connecting a person's own Google
   * or Microsoft account is theirs alone and is not decided here.
   */
  integrations: {
    /** See the connection and the outside calendars it can offer. */
    view: boolean;

    /** Link this calendar to an outside one. */
    create: boolean;

    /** Run a sync now. */
    update: boolean;

    /** Unlink it. */
    delete: boolean;

    /** Open the provider's accounts: add, reconnect or remove them. */
    manage: boolean;

    /** See the list of entries brought in from outside calendars. */
    records: boolean;

    /** See the sync section on the Integrations tab. */
    sync_section: boolean;

    /** See the list of active integrations. */
    active_list: boolean;

    /** Stop this calendar syncing with the outside one. */
    stop_sync: boolean;
  };

  /** Reading the access list: who else this calendar is shared with, and what they may do. */
  sharing: {
    view: boolean;

    /** Add people to the list, and change or remove the rules already on it. */
    add: boolean;
    manage: boolean;
  };

  /** Settings, sharing and deleting the calendar. */
  manage: boolean;
}

/** The shape a share row may carry. Every flag is optional; absent means not granted. */
export interface CalendarSharePermissions {
  events?: {
    create?: boolean;
    own?: { read?: boolean; update?: boolean; delete?: boolean };
    others?: { read?: boolean; update?: boolean; delete?: boolean };
  };
  task_events?: {
    read?: boolean;
    update?: boolean;
    delete?: boolean;
    list?: boolean;
    form?: boolean;
  };
  sync?: {
    read?: boolean;
    create?: boolean;
    update?: boolean;
    delete?: boolean;
    manage?: boolean;
  };
  calendar?: {
    edit?: boolean;
    delete?: boolean;

    /** Creating calendars at all; absent means allowed, only an explicit false withholds it. */
    create?: boolean;
  };

  /** Absent means every tab stays shown, so a share saved before tabs existed loses none. */
  tabs?: {
    calendar?: boolean;
    integrations?: boolean;
    sharing?: boolean;
    settings?: boolean;
    tickets?: boolean;
  };

  /** The Link ticket tab's boxes. Absent means not granted. */
  tickets?: {
    form?: boolean;
    link?: boolean;
    list?: boolean;
    delete?: boolean;
    delete_many?: boolean;
  };

  /** The connection itself. Absent means not granted — these are powers, not doorways. */
  integrations?: {
    view?: boolean;
    create?: boolean;
    update?: boolean;
    delete?: boolean;
    manage?: boolean;
    records?: boolean;
    sync_section?: boolean;
    active_list?: boolean;
    stop_sync?: boolean;
  };
  sharing?: { view?: boolean; add?: boolean; manage?: boolean };
  manage?: boolean;
}

/** All four tabs shown — what every legacy level, both ceilings and an untouched share mean. */
function openTabs(): CalendarPermissions['tabs'] {
  return {
    calendar: true,
    integrations: true,
    sharing: true,
    // settings: true,  (Settings tab removed)
    tickets: true,
  };
}

/** Nothing at all — also what someone with no matching rule gets. */
export function noPermissions(): CalendarPermissions {
  return {
    events: {
      create: false,
      own_read: false,
      own_update: false,
      own_delete: false,
      others_read: false,
      others_update: false,
      others_delete: false,
    },
    task_events: {
      read: false,
      update: false,
      delete: false,
      list: false,
      form: false,
    },
    sync: {
      read: false,
      create: false,
      update: false,
      delete: false,
      manage: false,
    },
    calendar: { edit: false, delete: false },
    tabs: {
      calendar: false,
      integrations: false,
      sharing: false,
      // settings: false,  (Settings tab removed)
      tickets: false,
    },
    tickets: {
      form: false,
      link: false,
      list: false,
      delete: false,
      delete_many: false,
    },
    integrations: {
      view: false,
      create: false,
      update: false,
      delete: false,
      manage: false,
      records: false,
      sync_section: false,
      active_list: false,
      stop_sync: false,
    },
    sharing: { view: false, add: false, manage: false },
    manage: false,
  };
}

/** Everything — the owner, an organization admin and a space owner or admin. */
export function allPermissions(): CalendarPermissions {
  return {
    events: {
      create: true,
      own_read: true,
      own_update: true,
      own_delete: true,
      others_read: true,
      others_update: true,
      others_delete: true,
    },
    task_events: {
      read: true,
      update: true,
      delete: true,
      list: true,
      form: true,
    },
    sync: {
      read: true,
      create: true,
      update: true,
      delete: true,
      manage: true,
    },
    calendar: { edit: true, delete: true },
    tabs: openTabs(),
    tickets: {
      form: true,
      link: true,
      list: true,
      delete: true,
      delete_many: true,
    },
    integrations: {
      view: true,
      create: true,
      update: true,
      delete: true,
      manage: true,
      records: true,
      sync_section: true,
      active_list: true,
      stop_sync: true,
    },
    sharing: { view: true, add: true, manage: true },
    manage: true,
  };
}

/**
 * True when the person may see nothing at all, which the read routes treat as "no such calendar".
 *
 * Only the read flags count: a share that opens a tab but no content still shows an empty screen.
 */
export function grantsNothing(permissions: CalendarPermissions): boolean {
  return !(
    permissions.events.own_read ||
    permissions.events.others_read ||
    permissions.task_events.read ||
    permissions.sync.read
  );
}

/** Whether anything at all may be written; a tab and seeing the connection are only ways in. */
export function grantsAnyWrite(permissions: CalendarPermissions): boolean {
  return (
    permissions.events.create ||
    permissions.events.own_update ||
    permissions.events.own_delete ||
    permissions.events.others_update ||
    permissions.events.others_delete ||
    permissions.task_events.update ||
    permissions.task_events.delete ||
    permissions.sync.create ||
    permissions.sync.update ||
    permissions.sync.delete ||
    permissions.sync.manage ||
    permissions.calendar.edit ||
    permissions.calendar.delete ||
    permissions.integrations.create ||
    permissions.integrations.update ||
    permissions.integrations.delete ||
    permissions.integrations.manage ||
    permissions.manage
  );
}

/** The stronger of two rules, flag by flag: sharing adds up and never takes away. */
export function mergePermissions(
  base: CalendarPermissions,
  extra: CalendarPermissions,
): CalendarPermissions {
  return {
    events: {
      create: base.events.create || extra.events.create,
      own_read: base.events.own_read || extra.events.own_read,
      own_update: base.events.own_update || extra.events.own_update,
      own_delete: base.events.own_delete || extra.events.own_delete,
      others_read: base.events.others_read || extra.events.others_read,
      others_update: base.events.others_update || extra.events.others_update,
      others_delete: base.events.others_delete || extra.events.others_delete,
    },
    task_events: {
      read: base.task_events.read || extra.task_events.read,
      update: base.task_events.update || extra.task_events.update,
      delete: base.task_events.delete || extra.task_events.delete,
      list: base.task_events.list || extra.task_events.list,
      form: base.task_events.form || extra.task_events.form,
    },
    sync: {
      read: base.sync.read || extra.sync.read,
      create: base.sync.create || extra.sync.create,
      update: base.sync.update || extra.sync.update,
      delete: base.sync.delete || extra.sync.delete,
      manage: base.sync.manage || extra.sync.manage,
    },
    calendar: {
      edit: base.calendar.edit || extra.calendar.edit,
      delete: base.calendar.delete || extra.calendar.delete,
    },
    tabs: {
      calendar: base.tabs.calendar || extra.tabs.calendar,
      integrations: base.tabs.integrations || extra.tabs.integrations,
      sharing: base.tabs.sharing || extra.tabs.sharing,
      // settings: base.tabs.settings || extra.tabs.settings,  (Settings tab removed)
      tickets: base.tabs.tickets || extra.tabs.tickets,
    },
    tickets: {
      form: base.tickets.form || extra.tickets.form,
      link: base.tickets.link || extra.tickets.link,
      list: base.tickets.list || extra.tickets.list,
      delete: base.tickets.delete || extra.tickets.delete,
      delete_many: base.tickets.delete_many || extra.tickets.delete_many,
    },
    integrations: {
      view: base.integrations.view || extra.integrations.view,
      create: base.integrations.create || extra.integrations.create,
      update: base.integrations.update || extra.integrations.update,
      delete: base.integrations.delete || extra.integrations.delete,
      manage: base.integrations.manage || extra.integrations.manage,
      records: base.integrations.records || extra.integrations.records,
      sync_section:
        base.integrations.sync_section || extra.integrations.sync_section,
      active_list:
        base.integrations.active_list || extra.integrations.active_list,
      stop_sync: base.integrations.stop_sync || extra.integrations.stop_sync,
    },
    sharing: {
      view: base.sharing.view || extra.sharing.view,
      add: base.sharing.add || extra.sharing.add,
      manage: base.sharing.manage || extra.sharing.manage,
    },
    manage: base.manage || extra.manage,
  };
}

/** Keeps only what the ceiling also allows, flag by flag. */
export function capPermissions(
  permissions: CalendarPermissions,
  ceiling: CalendarPermissions,
): CalendarPermissions {
  return {
    events: {
      create: permissions.events.create && ceiling.events.create,
      own_read: permissions.events.own_read && ceiling.events.own_read,
      own_update: permissions.events.own_update && ceiling.events.own_update,
      own_delete: permissions.events.own_delete && ceiling.events.own_delete,
      others_read: permissions.events.others_read && ceiling.events.others_read,
      others_update:
        permissions.events.others_update && ceiling.events.others_update,
      others_delete:
        permissions.events.others_delete && ceiling.events.others_delete,
    },
    task_events: {
      read: permissions.task_events.read && ceiling.task_events.read,
      update: permissions.task_events.update && ceiling.task_events.update,
      delete: permissions.task_events.delete && ceiling.task_events.delete,
      list: permissions.task_events.list && ceiling.task_events.list,
      form: permissions.task_events.form && ceiling.task_events.form,
    },
    sync: {
      read: permissions.sync.read && ceiling.sync.read,
      create: permissions.sync.create && ceiling.sync.create,
      update: permissions.sync.update && ceiling.sync.update,
      delete: permissions.sync.delete && ceiling.sync.delete,
      manage: permissions.sync.manage && ceiling.sync.manage,
    },
    calendar: {
      edit: permissions.calendar.edit && ceiling.calendar.edit,
      delete: permissions.calendar.delete && ceiling.calendar.delete,
    },
    tabs: {
      calendar: permissions.tabs.calendar && ceiling.tabs.calendar,
      integrations: permissions.tabs.integrations && ceiling.tabs.integrations,
      sharing: permissions.tabs.sharing && ceiling.tabs.sharing,
      // settings: permissions.tabs.settings && ceiling.tabs.settings,  (Settings tab removed)
      tickets: permissions.tabs.tickets && ceiling.tabs.tickets,
    },
    tickets: {
      form: permissions.tickets.form && ceiling.tickets.form,
      link: permissions.tickets.link && ceiling.tickets.link,
      list: permissions.tickets.list && ceiling.tickets.list,
      delete: permissions.tickets.delete && ceiling.tickets.delete,
      delete_many:
        permissions.tickets.delete_many && ceiling.tickets.delete_many,
    },
    integrations: {
      view: permissions.integrations.view && ceiling.integrations.view,
      create: permissions.integrations.create && ceiling.integrations.create,
      update: permissions.integrations.update && ceiling.integrations.update,
      delete: permissions.integrations.delete && ceiling.integrations.delete,
      manage: permissions.integrations.manage && ceiling.integrations.manage,
      records: permissions.integrations.records && ceiling.integrations.records,
      sync_section:
        permissions.integrations.sync_section &&
        ceiling.integrations.sync_section,
      active_list:
        permissions.integrations.active_list &&
        ceiling.integrations.active_list,
      stop_sync:
        permissions.integrations.stop_sync && ceiling.integrations.stop_sync,
    },
    sharing: {
      view: permissions.sharing.view && ceiling.sharing.view,
      add: permissions.sharing.add && ceiling.sharing.add,
      manage: permissions.sharing.manage && ceiling.sharing.manage,
    },
    manage: permissions.manage && ceiling.manage,
  };
}

/** What `view`, `edit` and `manage` have always meant, expressed in the new flags. */
export function fromLegacyLevel(level: string): CalendarPermissions {
  if (level === 'manage') return allPermissions();

  const result = noPermissions();

  // Every level showed the whole module before tabs existed; nobody may lose a tab they see today.
  result.tabs = openTabs();

  // The Link ticket tab is granted by the org owner, never by an old level
  result.tabs.tickets = false;

  result.events.own_read = true;
  result.events.others_read = true;
  result.task_events.read = true;
  result.sync.read = true;

  if (level !== 'edit') return result;

  result.events.create = true;
  result.events.own_update = true;
  result.events.own_delete = true;
  result.events.others_update = true;
  result.events.others_delete = true;
  result.sync.create = true;
  result.sync.update = true;
  result.sync.delete = true;

  // The old edit level always reached the calendar's own name and colour; splitting the flag out
  // must not quietly take that away from a rule saved before the split.
  result.calendar.edit = true;

  // Neither view nor edit could ever manage the connection, so both leave the integration flags off.

  return result;
}

/**
 * The explicit shape, with every absent flag meaning "not granted".
 *
 * `manage` is read like any other flag. It used to return everything before the rest of the shape was
 * looked at, which quietly overruled a box somebody had deliberately unticked — and the menu drew that
 * box as ticked, so nothing showed it had been ignored. A rule now grants exactly what it says.
 */
function fromShapes(shape: CalendarSharePermissions): CalendarPermissions {
  const result = noPermissions();

  result.events.create = shape.events?.create === true;
  result.events.own_read = shape.events?.own?.read === true;
  result.events.own_update = shape.events?.own?.update === true;
  result.events.own_delete = shape.events?.own?.delete === true;
  result.events.others_read = shape.events?.others?.read === true;
  result.events.others_update = shape.events?.others?.update === true;
  result.events.others_delete = shape.events?.others?.delete === true;

  result.task_events.read = shape.task_events?.read === true;
  result.task_events.update = shape.task_events?.update === true;
  result.task_events.delete = shape.task_events?.delete === true;

  result.sync.read = shape.sync?.read === true;
  result.sync.create = shape.sync?.create === true;
  result.sync.update = shape.sync?.update === true;
  result.sync.delete = shape.sync?.delete === true;
  result.sync.manage = shape.sync?.manage === true;

  result.calendar.edit = shape.calendar?.edit === true;
  result.calendar.delete = shape.calendar?.delete === true;

  // Only an explicit false hides a tab, so a share stored before tabs existed still shows all four.
  result.tabs.calendar = shape.tabs?.calendar !== false;
  result.tabs.integrations = shape.tabs?.integrations !== false;
  result.tabs.sharing = shape.tabs?.sharing !== false;
  // result.tabs.settings = shape.tabs?.settings !== false;  (Settings tab removed)

  // Unlike the other tabs, the Link ticket tab and its boxes are granted, never assumed
  result.tabs.tickets = shape.tabs?.tickets === true;
  result.tickets.form = shape.tickets?.form === true;
  result.tickets.link = shape.tickets?.link === true;
  result.tickets.list = shape.tickets?.list === true;
  result.tickets.delete = shape.tickets?.delete === true;
  result.tickets.delete_many = shape.tickets?.delete_many === true;

  // Showing this calendar in the Linked tickets list is granted per calendar
  result.task_events.list = shape.task_events?.list === true;
  result.task_events.form = shape.task_events?.form === true;

  // Unlike a tab, reaching the connection is a power: absent means not granted, never "still open".
  result.integrations.view = shape.integrations?.view === true;
  result.integrations.create = shape.integrations?.create === true;
  result.integrations.update = shape.integrations?.update === true;
  result.integrations.delete = shape.integrations?.delete === true;
  result.integrations.manage = shape.integrations?.manage === true;
  result.integrations.records = shape.integrations?.records === true;
  result.integrations.sync_section = shape.integrations?.sync_section === true;
  result.integrations.active_list = shape.integrations?.active_list === true;
  result.integrations.stop_sync = shape.integrations?.stop_sync === true;

  // Seeing who else holds access is granted, never assumed.
  result.sharing.view = shape.sharing?.view === true;

  // Granted only when ticked; the org owner sets these, Manage calendar does not imply them
  result.sharing.add = shape.sharing?.add === true;
  result.sharing.manage = shape.sharing?.manage === true;

  // Administering the calendar: its settings, its share list and removing it. It no longer stands in
  // for the flags above, so each of those is answered on its own.
  result.manage = shape.manage === true;

  return result;
}

/**
 * A share row's own grant.
 *
 * `permissions` is read when it is there. A row that only carries the old `level` string still works
 * and is read as the matrix it always meant, so nothing stored before this change needs rewriting.
 */
export function permissionsFromShare(share: {
  level?: string;
  permissions?: CalendarSharePermissions;
}): CalendarPermissions {
  if (share.permissions) return fromShapes(share.permissions);

  return fromLegacyLevel(share.level ?? 'view');
}

/**
 * The ceiling a space's own Calendar permissions put on every share inside it.
 *
 * Reading is one permission, so it opens every kind of content; the write keys each open their own
 * column. Managing the calendar, and with it the connection, is the space's Manage calendars key.
 */
export function ceilingFromSpace(
  allows: (key: string) => boolean,
): CalendarPermissions {
  if (!allows('view_calendar')) return noPermissions();
  if (allows('manage_calendars')) return allPermissions();

  const result = noPermissions();

  // Neither matrix has a tab concept, so a ceiling must never be the thing that hides a tab.
  result.tabs = openTabs();

  const create = allows('create_calendar_entries');
  const update = allows('edit_calendar_entries');
  const remove = allows('delete_calendar_entries');

  result.events.own_read = true;
  result.events.others_read = true;
  result.task_events.read = true;
  result.sync.read = true;

  result.events.create = create;
  result.sync.create = create;

  result.events.own_update = update;
  result.events.others_update = update;
  result.task_events.update = update;
  result.sync.update = update;

  result.events.own_delete = remove;
  result.events.others_delete = remove;
  result.task_events.delete = remove;
  result.sync.delete = remove;

  // The calendar object has its own two keys, so changing one never implies removing it.
  // This space matrix has no calendar keys yet, so editing entries keeps renaming possible as before
  result.calendar.edit =
    allows('edit_calendars') || allows('edit_calendar_entries');
  result.calendar.delete = allows('delete_calendars');

  // No key here governs the connection either, so the ceiling must not be what closes it — the share
  // is the only thing that decides.
  result.integrations = {
    view: true,
    create: true,
    update: true,
    delete: true,
    manage: true,
    records: true,
    sync_section: true,
    active_list: true,
    stop_sync: true,
  };

  // No space key speaks for the Link ticket tab either
  result.tickets = {
    form: true,
    link: true,
    list: true,
    delete: true,
    delete_many: true,
  };

  // Nor for the Linked tickets list
  result.task_events.list = true;
  result.task_events.form = true;

  // Nor does any key here speak for the access list, so the share decides that too.
  // result.sharing = { view: true };
  result.sharing = { view: true, add: true, manage: true };

  return result;
}

/** Everything a reader may see, and nothing more — the fallback a calendar's visibility grants. */
export function readOnlyPermissions(): CalendarPermissions {
  return fromLegacyLevel('view');
}
