/* company-model.js — the Company page's logic, with no page in it.
 *
 * Who is on the team and in what order, one person's page, who may change
 * whose role or status, the invitation form, the studio's profile and the
 * studio's connections. The team used to be listed by the spelling of the role
 * — the owner last, with the owner's styling on whichever card came first — and
 * a name with no letters became "?"; a person's page had a name and a title
 * and nothing else; nobody could be invited, given a role or deactivated; no
 * connection was shown anywhere; and the studio's name, place and website were
 * written into the page. Kept apart from workspace.js so it can be tested
 * without a browser — tests/company.test.mjs.
 *
 * The database decides all of it. This says beforehand what it will decide, so
 * the page offers only what will be accepted:
 *   employees                0005; read as 0043 grants it, written as 0042 guards it
 *   workspace_settings       0016 (owners and admins alone read it), 0041
 *   integration_connections  0024, 0036; read as 0044 allows, changed as 0038 allows
 *   invite-employee          _shared/team-rules.ts
 *   microsoft-connect        _shared/connection-rules.ts
 *
 * What the functions are given:
 *   viewer  the signed-in person's employees row as workspaceSession.employee
 *           has it — { id, role, status, … } — or null for anyone not on the team.
 *   member  an employees row — { id, user_id, email, full_name, role, title,
 *           status, start_date, created_at } — or a store entry carrying one
 *           under `row`, as queries.team() makes them.
 *   team    every member, the deactivated included, each with user_id and
 *           email: invite-employee checks an address against the whole team,
 *           and whether an owner can sign in decides who may be stood down
 *           (0042). A row read without a user_id key does not show that its
 *           owner can sign in. The owner looking is one, being signed in
 *           (employee_role(), 0040), unless the rows given say they have none.
 *
 * One global, companyModel. No page, no network. Everything returned is frozen.
 */
const companyModel = (function () {
  'use strict';

  /* employees.role (0005), from the most access to the least: the order the team
     is listed in. `manages` is is_manager() (0040): Finance and the team. */
  const ROLES = Object.freeze([
    Object.freeze({ value: 'owner', label: 'Owner', manages: true }),
    Object.freeze({ value: 'admin', label: 'Admin', manages: true }),
    Object.freeze({ value: 'assistant', label: 'Assistant', manages: false }),
    Object.freeze({ value: 'employee', label: 'Employee', manages: false })
  ]);
  /* employees.status (0005). A deactivated member has no role (employee_role()). */
  const STATUSES = Object.freeze([
    Object.freeze({ value: 'active', label: 'Active' }),
    Object.freeze({ value: 'invited', label: 'Invited' }),
    Object.freeze({ value: 'inactive', label: 'Deactivated' })
  ]);
  /* The groups the team is listed in, in order. */
  const TEAM_GROUPS = Object.freeze([
    Object.freeze({ value: 'owner', label: 'Owners' }),
    Object.freeze({ value: 'admin', label: 'Admins' }),
    Object.freeze({ value: 'staff', label: 'Team' }),
    Object.freeze({ value: 'invited', label: 'Invited' }),
    Object.freeze({ value: 'inactive', label: 'Deactivated' })
  ]);
  /* integration_connections.provider (0036). `reconnects`: microsoft-connect
     connects these two; nothing else can be reconnected from the workspace. */
  const PROVIDERS = Object.freeze([
    Object.freeze({ value: 'microsoft_mail', label: 'Outlook mail', kind: 'mail', reconnects: true }),
    Object.freeze({ value: 'microsoft_calendar', label: 'Outlook calendar', kind: 'calendar', reconnects: true }),
    Object.freeze({ value: 'imap', label: 'IMAP mailbox', kind: 'mail', reconnects: false }),
    Object.freeze({ value: 'caldav', label: 'CalDAV calendar', kind: 'calendar', reconnects: false }),
    Object.freeze({ value: 'ics', label: 'Calendar feed', kind: 'calendar', reconnects: false }),
    Object.freeze({ value: 'mercury', label: 'Mercury', kind: 'bank', reconnects: false }),
    Object.freeze({ value: 'stripe', label: 'Stripe', kind: 'payments', reconnects: false })
  ]);
  /* integration_connections.status (0024), each with its pill colour. The last
     is the column's default, and what a status it cannot hold reads as. */
  const CONNECTION_STATUSES = Object.freeze([
    Object.freeze({ value: 'connected', label: 'Connected', tone: 'green' }),
    Object.freeze({ value: 'needs_reauth', label: 'Needs reconnecting', tone: 'amber' }),
    Object.freeze({ value: 'error', label: 'Error', tone: 'red' }),
    Object.freeze({ value: 'disconnected', label: 'Disconnected', tone: null })
  ]);
  /* The studio's profile in workspace_settings. 0016 keeps any key as text and
     defines none, so these keys are the profile's own; nothing writes them yet.
     The defaults are the public facts the page used to carry. */
  const STUDIO_KEYS = Object.freeze({
    name: 'studio_name', tagline: 'studio_tagline', location: 'studio_location', email: 'studio_email', website: 'studio_website'
  });
  const STUDIO_DEFAULTS = Object.freeze({
    name: 'Veyago Inc.', tagline: 'Independent software studio. Software for the journey.',
    location: 'New York, United States', email: 'hello@veyago.cloud', website: 'https://www.veyago.cloud/'
  });

  /* What the page says when the database would say no. Where 0042 or
     team-rules.ts already words a refusal for people, these are its words. */
  const SAY = Object.freeze({
    managersChange: 'Only an owner or admin can change a team member’s role or status.',
    notOnTeam: 'This person is not on the team.',
    chooseRole: 'Choose a role: Owner, Admin, Assistant or Employee.',
    chooseStatus: 'Choose a status: Active, Invited or Deactivated.',
    own: 'Nobody can change their own role or status. Ask another owner or admin.',
    changeOwner: 'Only an owner can change an owner.',
    makeOwner: 'Only an owner can make someone an owner.',
    keepAnOwner: 'The studio needs an owner who can sign in. Make someone else an owner first.',
    alreadyInactive: 'They are already deactivated.',
    managersInvite: 'Only an owner or admin can invite someone.',
    yourself: 'You can’t re-invite yourself: it would change your own role. Ask another owner or admin.',
    reinviteOwner: 'Only an owner can re-invite an owner.',
    email: 'Enter a valid email address.',
    fullName: 'Enter their full name.',
    startDate: 'Enter the start date as a date, like 2026-09-14.'
  });
  const ACCESS = Object.freeze({
    owner: 'Everything, including Finance, the team and other owners.',
    admin: 'Everything, including Finance and the team, except owners.',
    assistant: 'The studio’s work, without Finance or changes to the team.',
    employee: 'The studio’s work, without Finance or changes to the team.'
  });
  const SIGN_IN = Object.freeze({
    active: 'Can sign in', invited: 'Invited, not signed in yet', none: 'No sign-in yet',
    deactivated: 'Deactivated, cannot sign in', unknown: 'Not known'
  });

  const MONTHS = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December']);
  const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;                 // invite-employee's own check
  const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const LETTER = /\p{L}\p{M}*/u;
  /* A website to link to: http or https, with no sign-in part — the browser goes
     to whatever follows an @ — and no quote or backslash in it. */
  const WEBSITE = /^https?:\/\/[^\s/?#@\\"'<>]+\.[^\s/?#@\\"'<>]+([/?#][^\s"'<>\\]*)?$/i;
  const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#][^\s"'<>\\]*)?$/i;
  const LINKED = 'linked';
  const NONE = 'none';
  const UNKNOWN = 'unknown';

  const text = value => String(value == null ? '' : value);
  const tidy = value => text(value).replace(/\r\n?/g, '\n').trim();
  const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const pad = n => String(n).padStart(2, '0');
  const exact = (list, value) => list.find(x => x.value === value) || null;
  const loose = (list, given) => {
    const wanted = text(given).trim().toLowerCase();
    return (wanted && list.find(x => x.value === wanted || x.label.toLowerCase() === wanted)) || null;
  };
  const byWords = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);

  /* roleLabel(role) → 'Owner', 'Admin', 'Assistant' or 'Employee', from a role's
     value or label; '' for anything employees.role cannot hold. */
  const roleLabel = role => (loose(ROLES, role) || { label: '' }).label;
  /* statusLabel(status) → 'Active', 'Invited' or 'Deactivated'; '' otherwise. */
  const statusLabel = status => (loose(STATUSES, status) || { label: '' }).label;

  /* ── Members ─────────────────────────────────────────────────────────── */

  /* A member as the rules read one, from a row or a store entry. */
  function memberOf(record) {
    const outer = isObject(record) ? record : {};
    const row = isObject(outer.row) ? outer.row : outer;
    const link = row.user_id;
    return {
      id: text(row.id != null ? row.id : outer.id) || null,
      userId: link == null || link === '' ? null : text(link),
      signIn: link === undefined ? UNKNOWN : link === null || link === '' ? NONE : LINKED,
      address: text(row.email),
      email: text(row.email).trim(),
      name: text(row.full_name).trim(),
      role: exact(ROLES, row.role) ? row.role : null,
      title: text(row.title).trim(),
      status: exact(STATUSES, row.status) ? row.status : null,
      startDate: row.start_date,
      createdAt: row.created_at
    };
  }

  /* Every readable member once, in the order given. */
  function membersOf(list) {
    const members = (Array.isArray(list) ? list : []).map(memberOf).filter(m => m.id !== null);
    return members.filter((m, i) => members.findIndex(other => other.id === m.id) === i);
  }

  const samePerson = (a, b) => (a.id !== null && a.id === b.id) || (a.userId !== null && a.userId === b.userId);
  const displayName = m => m.name || m.email;
  const routeOf = m => 'company/people/' + encodeURIComponent(m.id);

  /* employee_role() (0005, 0040): the viewer's role — none for a deactivated row,
     or for anyone not on the team. */
  function roleOf(viewer) {
    const me = memberOf(viewer);
    return me.id !== null && me.status !== 'inactive' ? me.role : null;
  }

  /* isManager(viewer) → true for an owner or an admin: is_manager() (0040). */
  function isManager(viewer) {
    const role = roleOf(viewer);
    return role === 'owner' || role === 'admin';
  }

  /* ── Initials ────────────────────────────────────────────────────────── */

  /* A letter in capitals, unless its capital is more letters than one: ß's is SS,
     and a letter added is a letter made up. */
  function capital(letter) {
    const letters = value => (value.match(/\p{L}/gu) || []).length;
    const upper = letter.toUpperCase();
    return letters(upper) === letters(letter) ? upper : letter;
  }

  /* A virama: the sign that takes a letter's vowel away and joins the letter to
     the one after it, so that प् and श are written as the one conjunct प्श. The
     viramas of every script are the marks of Unicode's combining class 9.
     JavaScript does not tell a character's class, but normalising puts marks
     side by side in the order of their classes, and the class shows in that: a
     virama goes after U+3099, of class 8, and before U+05B0, of class 10. */
  const CLASS_8 = String.fromCharCode(0x3099);
  const CLASS_10 = String.fromCharCode(0x05B0);
  function isVirama(mark) {
    return mark !== CLASS_8 && mark !== CLASS_10
      && (mark + CLASS_8).normalize('NFD') === CLASS_8 + mark
      && (CLASS_10 + mark).normalize('NFD') === mark + CLASS_10;
  }

  /* A word's initial: its first letter with the signs written on it, accents,
     vowel signs and nuktas kept — but no virama, which would join it to the
     next initial as one conjunct. */
  function initialOf(word) {
    const found = (LETTER.exec(word) || [''])[0];
    return Array.from(found).filter((char, i) => i === 0 || !isVirama(char)).join('');
  }

  /* The initials of the first and last words that have a letter. */
  function firstAndLast(words) {
    const found = words.map(initialOf).filter(Boolean);
    const picked = found.length > 1 ? [found[0], found[found.length - 1]] : found;
    return picked.map(capital).join('').normalize('NFC');
  }

  /* initials(name, email) → up to two letters: the first letters of the name's
     first and last words — one for a one-word name — else of the address's
     words before the @, its +tag left off; else ''. Never "?", never half an
     emoji: a word's first letter is its first letter, whatever comes before it. */
  function initials(name, email) {
    const fromName = firstAndLast(text(name).normalize('NFC').split(/\s+/));
    if (fromName) return fromName;
    const local = text(email).trim().split('@')[0].split('+')[0];
    return firstAndLast(local.normalize('NFC').split(/[\s._-]+/));
  }

  /* ── The team ────────────────────────────────────────────────────────── */

  function groupOf(m) {
    if (m.status === 'inactive' || m.status === 'invited') return m.status;
    return m.role === 'owner' || m.role === 'admin' ? m.role : 'staff';
  }
  const rank = group => TEAM_GROUPS.findIndex(g => g.value === group);

  /* teamCards(employees, viewer) → a card for every member: owners, admins, the
     rest of the team, the invited and the deactivated (TEAM_GROUPS), each group
     in name order. A card: { id, route, name (the address when there is no
     name), email, initials, title (the job title, or ''), role, roleLabel,
     status, statusLabel, group, owner, you }. */
  function teamCards(employees, viewer) {
    const me = memberOf(viewer);
    return Object.freeze(membersOf(employees)
      .map(m => ({ m, group: groupOf(m) }))
      .sort((a, b) => rank(a.group) - rank(b.group) || byWords(displayName(a.m), displayName(b.m))
        || byWords(a.m.email, b.m.email) || byWords(a.m.id, b.m.id))
      .map(({ m, group }) => Object.freeze({
        id: m.id, route: routeOf(m), name: displayName(m), email: m.email, initials: initials(m.name, m.email),
        title: m.title, role: m.role, roleLabel: roleLabel(m.role), status: m.status, statusLabel: statusLabel(m.status),
        group, owner: m.role === 'owner', you: samePerson(me, m)
      })));
  }

  /* ── A person's page ─────────────────────────────────────────────────── */

  const dayLabel = (year, month, day) => MONTHS[month - 1] + ' ' + day + ', ' + year;

  /* A date column, "2026-09-14", as { key, label }: a date has no time zone, so it
     is the same date on every clock. null for anything that is not a real date. */
  function dateOnly(value) {
    const m = DATE.exec(text(value));
    if (!m) return null;
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    return real ? Object.freeze({ key: m[0], label: dayLabel(year, month, day) }) : null;
  }

  /* A moment's date on this clock, as { key, label }, or null. */
  function localDay(value) {
    const ms = Date.parse(text(value));
    if (Number.isNaN(ms)) return null;
    const date = new Date(ms);
    const [year, month, day] = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
    return Object.freeze({ key: year + '-' + pad(month) + '-' + pad(day), label: dayLabel(year, month, day) });
  }

  /* Whether someone can sign in: a sign-in linked (invite-employee links one when
     it invites), and a row that is not deactivated. */
  function signInOf(m) {
    const state = m.status === 'inactive' ? 'deactivated'
      : m.signIn !== LINKED ? m.signIn
        : m.status === 'invited' ? 'invited' : 'active';
    return Object.freeze({ state, label: SIGN_IN[state] });
  }

  const privateRowOf = details => {
    const row = Array.isArray(details) ? details[0] : details;
    return isObject(row) ? row : null;
  };

  /* personDetails(employee, privateDetails, viewer) → a person's page, or null for
     a record with no id: what a card has, and access (what the role reaches),
     signIn { state: active | invited | none | deactivated | unknown, label },
     startDate and added ({ key, label } or null), phone and notes ({ shown,
     value }). privateDetails is what rpc('employee_private') returned — its rows,
     or one row — and null when it was not asked or failed. It answers the phone
     to owners, admins and the person themself, and the notes to owners and
     admins alone (0043), so each is shown only when a row came back to someone
     it answers; a notes value null for anyone else means "not yours", not "none". */
  function personDetails(employee, privateDetails, viewer) {
    const m = memberOf(employee);
    if (m.id === null) return null;
    const you = samePerson(memberOf(viewer), m);
    const answered = privateRowOf(privateDetails);
    const phoneShown = answered !== null && (isManager(viewer) || (you && roleOf(viewer) !== null));
    const notesShown = answered !== null && isManager(viewer);
    const privately = (shown, value) => Object.freeze({ shown, value: shown ? tidy(value) || null : null });
    return Object.freeze({
      id: m.id, route: routeOf(m), name: displayName(m), email: m.email, initials: initials(m.name, m.email),
      title: m.title, role: m.role, roleLabel: roleLabel(m.role), status: m.status, statusLabel: statusLabel(m.status),
      you, access: m.role ? ACCESS[m.role] : '', signIn: signInOf(m),
      startDate: dateOnly(m.startDate), added: localDay(m.createdAt),
      phone: privately(phoneShown, answered && answered.phone),
      notes: privately(notesShown, answered && answered.notes)
    });
  }

  /* ── Roles and statuses (0042) ───────────────────────────────────────── */

  /* An owner who can sign in, as 0042 counts one: an owner linked to a sign-in,
     not deactivated. A target whose link was not read may be one. */
  const ownerWhoCanSignIn = m => m.role === 'owner' && m.status !== 'inactive' && m.signIn === LINKED;
  const mayBeOwnerWhoCanSignIn = m => m.role === 'owner' && m.status !== 'inactive' && m.signIn !== NONE;

  /* ownersWhoCanSignIn(team) → the ids of the owners who can sign in, in the
     team's order. Whatever changes, the studio keeps one (0042). */
  function ownersWhoCanSignIn(team) {
    return Object.freeze(membersOf(team).filter(ownerWhoCanSignIn).map(m => m.id));
  }

  /* Whether the viewer is an owner who can sign in. They are signed in, and the
     database calls someone an owner only for the row they are signed in to, when
     it is not deactivated (employee_role(), 0040): the owner 0042 counts. A row
     that says that person has no sign-in — the viewer's own, or theirs in team —
     cannot be a signed-in person's, and is not taken for theirs. */
  function signedInOwner(viewer, team) {
    const me = memberOf(viewer);
    return roleOf(viewer) === 'owner' && me.signIn !== NONE
      && !membersOf(team).some(m => samePerson(m, me) && m.signIn === NONE);
  }

  /* changeRefusal(viewer, target, team, change) → why saving change — { role },
     { status } or both — on target would be refused, in the order the database
     asks, or null when it would be saved. Only owners and admins change anyone
     ("managers change employees"); nobody their own role or status; only an owner
     changes an owner or makes one (employees_guard); and no change may leave the
     studio without an owner who can sign in (employees_keep_an_owner). Only an
     owner gets that far, and only to stand down someone else, so the owner making
     the change is one who remains, whatever team shows — 08: "OWNER: changes an
     owner back" — unless the rows given say that owner has no sign-in, when the
     owners in team who can sign in are counted instead. */
  function changeRefusal(viewer, target, team, change) {
    const myRole = roleOf(viewer);
    const who = memberOf(target);
    const wanted = isObject(change) ? change : {};
    if (myRole !== 'owner' && myRole !== 'admin') return SAY.managersChange;
    if (who.id === null) return SAY.notOnTeam;
    if (wanted.role !== undefined && !exact(ROLES, wanted.role)) return SAY.chooseRole;
    if (wanted.status !== undefined && !exact(STATUSES, wanted.status)) return SAY.chooseStatus;
    const role = wanted.role === undefined ? who.role : wanted.role;
    const status = wanted.status === undefined ? who.status : wanted.status;
    if (samePerson(memberOf(viewer), who) && (role !== who.role || status !== who.status)) return SAY.own;
    if (who.role === 'owner' && myRole !== 'owner') return SAY.changeOwner;
    if (role === 'owner' && myRole !== 'owner') return SAY.makeOwner;
    const standsDown = mayBeOwnerWhoCanSignIn(who) && !(role === 'owner' && status !== 'inactive');
    const remains = signedInOwner(viewer, team) && !samePerson(memberOf(viewer), who);
    const another = remains || membersOf(team).some(m => !samePerson(m, who) && ownerWhoCanSignIn(m));
    return standsDown && !another ? SAY.keepAnOwner : null;
  }

  function choicesFor(options, field, viewer, target, team) {
    const who = memberOf(target);
    const choices = Object.freeze(options.map(option => {
      const reason = changeRefusal(viewer, target, team, { [field]: option.value });
      return Object.freeze({ value: option.value, label: option.label, current: who[field] === option.value, allowed: reason === null, reason });
    }));
    const others = choices.filter(choice => !choice.current);
    const editable = others.some(choice => choice.allowed);
    return Object.freeze({ editable, reason: editable || !others.length ? null : others[0].reason, choices });
  }

  /* roleChoices(viewer, target, team) → { editable, reason, choices }: every role
     (ROLES' order) as { value, label, current, allowed, reason }, by
     changeRefusal(). editable when another role may be chosen; reason says why
     none may. statusChoices(viewer, target, team) → the same over STATUSES. */
  const roleChoices = (viewer, target, team) => choicesFor(ROLES, 'role', viewer, target, team);
  const statusChoices = (viewer, target, team) => choicesFor(STATUSES, 'status', viewer, target, team);

  /* deactivateRefusal(viewer, target, team) → why target cannot be deactivated
     (status 'inactive'), or null. canDeactivate(viewer, target, team) → whether
     they can. The row stays and so does their history: nobody deletes a team
     member through the API (0042). */
  function deactivateRefusal(viewer, target, team) {
    return changeRefusal(viewer, target, team, { status: 'inactive' })
      || (memberOf(target).status === 'inactive' ? SAY.alreadyInactive : null);
  }
  const canDeactivate = (viewer, target, team) => deactivateRefusal(viewer, target, team) === null;

  /* ── Inviting (invite-employee, _shared/team-rules.ts) ──────────────── */

  const sameAddress = (a, b) => {
    const left = text(a).trim().toLowerCase();
    return left !== '' && left === text(b).trim().toLowerCase();
  };
  const summary = m => Object.freeze({
    id: m.id, name: displayName(m), email: m.email, role: m.role, roleLabel: roleLabel(m.role), status: m.status, statusLabel: statusLabel(m.status)
  });

  /* inviteRefusal() in team-rules.ts, after the function's own "Managers only". */
  function inviteRefusal(viewer, request, matches) {
    const myRole = roleOf(viewer);
    if (myRole !== 'owner' && myRole !== 'admin') return SAY.managersInvite;
    const me = memberOf(viewer);
    if (matches.some(m => samePerson(m, me))) return SAY.yourself;
    if (request.role === 'owner' && myRole !== 'owner') return SAY.makeOwner;
    if (matches.some(m => m.role === 'owner') && myRole !== 'owner') return SAY.reinviteOwner;
    if (matches.length > 0 && !matches.some(m => m.address === request.email)) {
      return matches[0].address + ' is already on the team. Re-invite them from their profile.';
    }
    return null;
  }

  function roleOptions(viewer) {
    const myRole = roleOf(viewer);
    const manager = myRole === 'owner' || myRole === 'admin';
    return Object.freeze(ROLES.map(role => {
      const reason = !manager ? SAY.managersInvite : role.value === 'owner' && myRole !== 'owner' ? SAY.makeOwner : null;
      return Object.freeze({ value: role.value, label: role.label, manages: role.manages, allowed: reason === null, reason });
    }));
  }

  /* inviteForm(values, viewer, team) → the invitation form's state. values are the
     function's own fields: { email, full_name, role, title, start_date }.
     → { ok, errors ({ field: message } for what the function would answer 400
     to), refusal (what it would answer 403 to, in its words), payload (the body
     to send when ok, else null), existing (the member this address already is,
     or null), reinvite, statusAfter ('active' or 'invited', as statusAfterInvite
     leaves them), roles (ROLES with allowed and reason) }. The address is
     checked against the whole team whatever its case, as the function checks
     it. Asked on the server alone: whether a member who can already sign in
     does so at this address (signInRefusal), and whether email can be sent
     (the dry run). */
  function inviteForm(values, viewer, team) {
    const given = isObject(values) ? values : {};
    const request = {
      email: text(given.email).trim().toLowerCase(),
      full_name: text(given.full_name).trim(),
      role: given.role == null ? 'employee' : text(given.role),
      title: text(given.title).trim() || null,
      start_date: text(given.start_date).trim() || null
    };
    const errors = Object.freeze(Object.fromEntries([
      ['email', ADDRESS.test(request.email) ? null : SAY.email],
      ['full_name', request.full_name ? null : SAY.fullName],
      ['role', exact(ROLES, request.role) ? null : SAY.chooseRole],
      ['start_date', request.start_date === null || dateOnly(request.start_date) ? null : SAY.startDate]
    ].filter(([, message]) => message !== null)));
    const matches = membersOf(team).filter(m => sameAddress(m.address, request.email));
    const existing = matches.find(m => m.address === request.email) || null;
    const refusal = inviteRefusal(viewer, request, matches);
    const ok = refusal === null && Object.keys(errors).length === 0;
    return Object.freeze({
      ok, errors, refusal,
      payload: ok ? Object.freeze(request) : null,
      existing: existing && summary(existing),
      reinvite: existing !== null,
      statusAfter: existing && existing.status === 'active' ? 'active' : 'invited',
      roles: roleOptions(viewer)
    });
  }

  /* ── The studio's profile (0016, 0041) ───────────────────────────────── */

  const websiteOf = value => (WEBSITE.test(value) ? value : DOMAIN.test(value) ? 'https://' + value : null);

  /* studio_currency()'s first answer (0041): base_currency with its spaces
     trimmed — Postgres trim() takes nothing else — when it is three letters. Its
     later answers, a finance account's currency and then USD, are the
     database's to give. */
  function currencyOf(rows) {
    const row = rows.find(r => r.key === 'base_currency');
    const value = text(row && row.value).replace(/^ +| +$/g, '');
    return /^[a-z]{3}$/i.test(value) ? value.toUpperCase() : null;
  }

  /* studioProfile(settingsRows) → { name, tagline, location, email, website,
     websiteLabel, currency, fromSettings }. settingsRows are workspace_settings
     rows, { key, value }. Each field is its STUDIO_KEYS setting, trimmed, or its
     STUDIO_DEFAULTS fact when the setting is missing, blank or cannot be what it
     says (an address that is not one, a website that is not http or https).
     currency is base_currency's, or null. fromSettings names the fields that
     came from settings. Only owners and admins read workspace_settings (0016):
     everyone else is handed no rows and sees the defaults. Bank details are in
     the same table and never read here. */
  function studioProfile(settingsRows) {
    const rows = Array.isArray(settingsRows) ? settingsRows.filter(isObject) : [];
    const setting = key => tidy((rows.find(r => r.key === key) || {}).value);
    const email = setting(STUDIO_KEYS.email);
    const read = {
      name: setting(STUDIO_KEYS.name) || null,
      tagline: setting(STUDIO_KEYS.tagline) || null,
      location: setting(STUDIO_KEYS.location) || null,
      email: ADDRESS.test(email) ? email : null,
      website: websiteOf(setting(STUDIO_KEYS.website)),
      currency: currencyOf(rows)
    };
    const website = read.website || STUDIO_DEFAULTS.website;
    return Object.freeze({
      name: read.name || STUDIO_DEFAULTS.name,
      tagline: read.tagline || STUDIO_DEFAULTS.tagline,
      location: read.location || STUDIO_DEFAULTS.location,
      email: read.email || STUDIO_DEFAULTS.email,
      website,
      websiteLabel: website.replace(/^https?:\/\//i, '').replace(/\/+$/, ''),
      currency: read.currency,
      fromSettings: Object.freeze(Object.keys(read).filter(field => read[field] !== null))
    });
  }

  /* ── Connections (0024, 0036, 0038, 0044, connection-rules.ts) ──────── */

  /* A moment on this clock: "Sep 14, 2026, 09:30". */
  const momentLabel = date => MONTHS[date.getMonth()].slice(0, 3) + ' ' + date.getDate() + ', ' + date.getFullYear()
    + ', ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  const providerRank = value => {
    const i = PROVIDERS.findIndex(p => p.value === value);
    return i < 0 ? PROVIDERS.length : i;
  };
  const byConnection = (a, b) => (a.whose === b.whose ? 0 : a.whose === 'studio' ? -1 : 1)
    || providerRank(a.provider) - providerRank(b.provider) || byWords(a.account, b.account) || byWords(text(a.id), text(b.id));

  function connectionRow(row, whose, manager) {
    const provider = exact(PROVIDERS, row.provider);
    const status = exact(CONNECTION_STATUSES, row.status) || CONNECTION_STATUSES[3];
    const account = text(row.account_label).trim();
    const synced = Date.parse(text(row.last_synced_at));
    const mayReconnect = Boolean(provider && provider.reconnects) && account !== '' && (whose === 'own' || manager);
    return Object.freeze({
      id: text(row.id) || null,
      provider: text(row.provider),
      providerLabel: provider ? provider.label : text(row.provider),
      kind: provider ? provider.kind : 'other',
      account,
      whose,
      whoseLabel: whose === 'studio' ? 'Studio' : 'Yours',
      status: status.value,
      statusLabel: status.label,
      tone: status.tone,
      lastError: status.value === 'error' || status.value === 'needs_reauth' ? tidy(row.last_error) || null : null,
      lastSyncedAt: Number.isNaN(synced) ? null : new Date(synced).toISOString(),
      lastSyncedLabel: Number.isNaN(synced) ? 'Never synced' : 'Last synced ' + momentLabel(new Date(synced)),
      mayReconnect,
      reconnect: mayReconnect ? Object.freeze({ provider: provider.value, accountLabel: account.toLowerCase() }) : null,
      mayDisconnect: manager && status.value !== 'disconnected'
    });
  }

  /* connectionRows(connections, viewer) → the connections the viewer may see —
     the studio's (employee_id null) and their own, and nothing for anyone not on
     staff (0044) — studio first, then by provider and address. connections are
     integration_status or integration_connections rows. A row: { id, provider,
     providerLabel, kind, account, whose ('studio' | 'own'), whoseLabel, status
     (connected | needs_reauth | error | disconnected), statusLabel, tone,
     lastError (the stored reason, for an error or a needed reconnect), lastSyncedAt
     (ISO or null), lastSyncedLabel, mayReconnect, reconnect (microsoft-connect's
     body, or null: no employeeId, so the connection keeps its owner), mayDisconnect }.
     Reconnecting, as connectRefusal() decides it: an owner or admin the studio's,
     anyone their own, Outlook mail and calendars only. Disconnecting, as 0038
     allows it: owners and admins, the studio's or their own, and only a
     connection that is not disconnected already. */
  function connectionRows(connections, viewer) {
    if (roleOf(viewer) === null) return Object.freeze([]);
    const me = memberOf(viewer);
    const manager = isManager(viewer);
    return Object.freeze((Array.isArray(connections) ? connections : [])
      .filter(isObject)
      .map(row => ({ row, ownerId: text(row.employee_id) || null }))
      .filter(({ ownerId }) => ownerId === null || ownerId === me.id)
      .map(({ row, ownerId }) => connectionRow(row, ownerId === null ? 'studio' : 'own', manager))
      .sort(byConnection));
  }

  return Object.freeze({
    ROLES, STATUSES, TEAM_GROUPS, PROVIDERS, CONNECTION_STATUSES, STUDIO_KEYS, STUDIO_DEFAULTS,
    roleLabel, statusLabel, isManager, initials,
    teamCards, personDetails,
    changeRefusal, roleChoices, statusChoices, deactivateRefusal, canDeactivate, ownersWhoCanSignIn,
    inviteForm, studioProfile, connectionRows
  });
})();
