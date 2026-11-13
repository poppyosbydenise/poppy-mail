/* Poppy Mail: the retro interface. Talks only to the local Poppy Mail server on this computer. */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var TOKEN = $('meta[name="dm-token"]').content;
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('dm-' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('dm-' + k, JSON.stringify(v)); } catch (e) {} }
  };
  var S = {
    theme: ['aol', 'ms'].indexOf(store.get('theme', 'msn')) !== -1 ? store.get('theme', 'msn') : 'msn', sound: store.get('sound', true) !== false,
    email: '', demo: false, folders: [], folder: 'INBOX', page: 0, perPage: 40, total: 0, query: '', queryText: '',
    messages: [], selectedUid: null, current: null, contacts: [], loading: false, unreadInbox: 0,
    viewHtml: true, showPics: false, signedOn: false
  };
  var DEFAULT_PROFILE = { name: '', mood: '\uD83D\uDE0A|feeling happy', song: 'Dancing in my inbox', about: 'Hi! Welcome to my mail space. Sparkles are mandatory. \u2728', avatar: '\uD83E\uDD8B', skin: 'pink' };
  var AVATARS = ['\uD83E\uDD8B', '\uD83C\uDF38', '\uD83D\uDC31', '\uD83E\uDD84', '\uD83C\uDF53', '\uD83D\uDC96', '\u2B50', '\uD83C\uDF80', '\uD83C\uDF08', '\uD83D\uDC30', '\uD83C\uDF52', '\uD83C\uDF19'];
  var SKINS = [['pink', 'Bubblegum'], ['purple', 'Grape'], ['noir', 'Black & pink'], ['aqua', 'Aqua']];
  var FACE = ['#ff5fb8', '#a24bff', '#27b6c9', '#ff8a3d', '#4cc26a', '#5b7cff', '#e0359a', '#9b59b6'];
  S.profile = Object.assign({}, DEFAULT_PROFILE, store.get('profile', {})); S.sparkle = store.get('sparkle', false);
  var timers = { poll: null, clock: null, tip: null }, onlineSince = 0, composeCount = 0, tipIdx = 0;
  var TIPS = ['Tip: Star a message to find it again later.', 'Tip: Double-click a window title bar to roll it up.', 'Tip: Press Delete to throw a message in the Trash.',
    'Tip: Pictures in emails are blocked until you say so, to protect your privacy.', 'Tip: Use the Look menu to switch between MSN-style and AOL-style.',
    'Tip: Try the search box. It understands Gmail searches like from:mom.', 'Did you know? Your password lives only in memory. Sign off and it is gone.'];

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(iso) {
    if (!iso) return ''; var d = new Date(iso), n = new Date(); if (isNaN(d)) return '';
    if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.getFullYear() === n.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return d.toLocaleDateString([], { year: '2-digit', month: 'numeric', day: 'numeric' });
  }
  function fmtFull(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function person(a) { return a.name ? a.name + ' <' + a.address + '>' : a.address; }
  function personShort(a) { return a.name || a.address; }
  function profName() { return (S.profile.name || '').trim() || localName(); }
  function localName() { var n = (S.email || '').split('@')[0].replace(/[._-]+/g, ' '); return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'friend'; }
  function linkify(text) {
    return esc(text).replace(/(https?:\/\/[^\s<>"']+)/g, function (u) {
      var tail = ''; while (/[.,;:!?)]$/.test(u)) { tail = u.slice(-1) + tail; u = u.slice(0, -1); }
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>' + tail;
    });
  }
  function sanitizeHtml(html) {
    var doc = new DOMParser().parseFromString(html || '', 'text/html');
    $$('script,meta,link,base,iframe,frame,frameset,object,embed,form,noscript,applet', doc).forEach(function (n) { n.remove(); });
    $$('*', doc).forEach(function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (at) { if (/^on/i.test(at.name)) el.removeAttribute(at.name); });
      if (el.hasAttribute('href') && /^\s*(javascript|data|vbscript):/i.test(el.getAttribute('href'))) el.removeAttribute('href');
    });
    return doc.body.innerHTML;
  }
  function htmlToText(html) { var doc = new DOMParser().parseFromString(html || '', 'text/html'); return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim(); }
  function bodyText(m) { return m.text || htmlToText(m.html); }
  function icon(kind) { return { inbox: '📥', starred: '⭐', important: '❗', sent: '📤', drafts: '📝', all: '🗂️', spam: '🚫', trash: '🗑️' }[kind] || '🏷️'; }
  function folderKind(id) { var f = S.folders.filter(function (x) { return x.id === id; })[0]; return f ? f.kind : 'label'; }

  function api(path, opts) {
    opts = opts || {}; var o = { method: opts.body ? 'POST' : 'GET', headers: { 'X-DM-Token': TOKEN } };
    if (opts.body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
    return fetch(path, o).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Unexpected reply from the program.' }; }).then(function (j) { return { r: r, j: j }; }); })
      .then(function (x) {
        if (!x.j.ok) {
          var err = new Error(x.j.error || 'Something went wrong.'); err.status = x.r.status;
          if (x.r.status === 401 && path !== '/api/login' && S.signedOn) { forceSignoff('Your session ended. Please sign on again.'); }
          throw err;
        }
        return x.j;
      }, function () { throw new Error('Could not reach Poppy Mail. Is the program still running?'); });
  }
  function toast(msg, kind) {
    var el = document.createElement('div'); el.className = 'toast' + (kind ? ' ' + kind : ''); el.textContent = msg; $('#toasts').appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 4200);
  }
  function fail(e) { DMSound.error(); toast(e.message || 'Something went wrong.', 'error'); }
  function confirmBox(title, text, yes) {
    return new Promise(function (resolve) {
      var d = $('#confirm'); $('#cf-title').textContent = title; $('#cf-text').textContent = text; $('#cf-yes').textContent = yes || 'Yes';
      var done = function (v) { d.close(); $('#cf-yes').onclick = $('#cf-no').onclick = null; d.onclose = null; resolve(v); };
      $('#cf-yes').onclick = function () { done(true); }; $('#cf-no').onclick = function () { done(false); }; d.onclose = function () { resolve(false); };
      d.showModal(); $('#cf-no').focus();
    });
  }

  /* ---------- theme ---------- */
  function setTheme(t) {
    S.theme = (t === 'aol' || t === 'ms') ? t : 'msn'; document.documentElement.setAttribute('data-theme', S.theme); store.set('theme', S.theme);
    $$('input[name="look"]').forEach(function (r) { r.checked = r.value === S.theme; });
    if (S.signedOn) { buildShell(); refreshViews(); if (S.theme === 'aol' && S.current) openReaderWindow(); }
  }

  /* ---------- sign on + dial-up ---------- */
  function showSignon(errMsg) {
    S.signedOn = false; stopTimers(); WM.closeAll(); DMSound.jingle(false);
    $('#app').hidden = true; $('#signon').hidden = false; $('.signon-win').hidden = false; $('#dial').hidden = true;
    $('#so-pass').value = ''; var er = $('#so-error'); if (errMsg) { er.textContent = errMsg; er.hidden = false; } else er.hidden = true;
    document.title = 'Poppy Mail';
  }
  function doSignOn(payload) {
    $('#so-error').hidden = true; DMSound.setEnabled($('#so-sound').checked); S.sound = DMSound.isEnabled(); store.set('sound', S.sound); DMSound.unlock();
    var minMs = DMSound.isEnabled() ? 4600 : (reduceMotion ? 700 : 1900);
    $('.signon-win').hidden = true; var dial = $('#dial'), lines = $('#dial-lines'), fill = $('#dial-fill'); dial.hidden = false; lines.innerHTML = '';
    fill.style.transition = 'none'; fill.style.width = '0';
    DMSound.dial(minMs / 1000);
    var script = ['Initializing modem...', 'Dialing 555-0199...', 'Connecting at 56000 bps...', 'Checking name and password...', 'Opening your mailbox...'];
    var timeouts = [], cancelled = false;
    script.forEach(function (txt, i) { timeouts.push(setTimeout(function () { var li = document.createElement('li'); li.textContent = txt; lines.appendChild(li); }, (minMs / script.length) * i)); });
    requestAnimationFrame(function () { requestAnimationFrame(function () { fill.style.transition = 'width ' + minMs + 'ms linear'; fill.style.width = '100%'; }); });
    var req = api('/api/login', { body: payload }).then(function (j) { return { ok: true, j: j }; }, function (e) { return { ok: false, e: e }; });
    var wait = new Promise(function (res) { var tm = setTimeout(res, minMs); timeouts.push(tm); $('#dial-skip').onclick = function () { clearTimeout(tm); res(); }; });
    $('#dial-cancel').onclick = function () {
      cancelled = true; timeouts.forEach(clearTimeout); DMSound.stopDial(); api('/api/logout', { body: {} }).catch(function () {}); showSignon();
    };
    Promise.all([req, wait]).then(function (r) {
      if (cancelled) return; DMSound.stopDial(); timeouts.forEach(clearTimeout);
      if (!r[0].ok) { DMSound.error(); showSignon(r[0].e.message); return; }
      enterApp(r[0].j);
    });
  }
  function enterApp(j) {
    S.email = j.email; S.demo = !!j.demo; S.signedOn = true; S.folder = 'INBOX'; S.page = 0; S.query = ''; S.queryText = ''; S.current = null; S.selectedUid = null; S.messages = []; S.folders = []; S.contacts = [];
    $('#signon').hidden = true; $('#app').hidden = false; buildShell(); onlineSince = Date.now(); startTimers(); refreshViews();
    Promise.all([loadFolders(), loadContacts()]).then(loadMessages).then(function () { DMSound.welcome(); refreshViews(); }).catch(fail);
  }
  function forceSignoff(msg) { api('/api/logout', { body: {} }).catch(function () {}); showSignon(msg); }
  function signOff() { api('/api/logout', { body: {} }).catch(function () {}).then(function () { toast('You are signed off. Goodbye!'); showSignon(); }); }

  /* ---------- data loading ---------- */
  function loadFolders() {
    return api('/api/folders').then(function (j) { S.folders = j.folders; var inb = S.folders.filter(function (f) { return f.kind === 'inbox'; })[0]; S.unreadInbox = inb ? (inb.unread || 0) : 0; refreshViews(['folders', 'tabs', 'welcome']); });
  }
  function loadContacts() { return api('/api/contacts').then(function (j) { S.contacts = j.contacts; refreshViews(['contacts', 'top8']); }).catch(function () {}); }
  function loadMessages() {
    S.loading = true; refreshViews(['list']); setStatus('Checking mail...');
    return api('/api/messages?folder=' + encodeURIComponent(S.folder) + '&page=' + S.page + '&q=' + encodeURIComponent(S.query)).then(function (j) {
      S.messages = j.messages; S.total = j.total; S.perPage = j.perPage || 40; S.loading = false; setStatus(); refreshViews(['list', 'tabs']);
    }, function (e) { S.loading = false; S.messages = []; S.total = 0; setStatus(); refreshViews(['list']); throw e; });
  }
  function selectMessage(uid, open) {
    S.selectedUid = uid; var m = S.messages.filter(function (x) { return x.uid === uid; })[0];
    $$('.mrow').forEach(function (r) { r.setAttribute('aria-selected', String(+r.getAttribute('data-uid') === uid)); });
    S.viewHtml = true; S.showPics = false;
    return api('/api/message?folder=' + encodeURIComponent(S.folder) + '&uid=' + uid).then(function (j) {
      S.current = j.message;
      if (m && m.unread) { m.unread = false; var f = S.folders.filter(function (x) { return x.id === S.folder; })[0]; if (f && f.unread > 0) f.unread--; if (folderKind(S.folder) === 'inbox') S.unreadInbox = f ? f.unread : S.unreadInbox; }
      if (S.theme === 'aol' && open) openReaderWindow();
      refreshViews(); if (S.theme === 'aol' && WM.has('reader')) WM.get('reader').setTitle('Read: ' + S.current.subject);
    }).catch(fail);
  }
  function setFolder(id) { S.folder = id; S.page = 0; S.query = ''; S.queryText = ''; S.current = null; S.selectedUid = null; if (WM.has('reader')) WM.close('reader'); refreshViews(); return loadMessages().catch(fail); }

  /* ---------- shell + layouts ---------- */
  function buildShell() {
    WM.closeAll(); var desk = $('#desk'); desk.innerHTML = ''; WM.init(desk); buildToolbar();
    if (S.theme === 'aol') buildAol(desk); else if (S.theme === 'ms') buildMs(desk); else buildMsn(desk);
  }
  function buildToolbar() {
    var tb = $('#toolbar'), aol = S.theme === 'aol';
    function b(act, ic, label, title) { return '<button type="button" class="tb" data-act="' + act + '" title="' + esc(title || label) + '"><span class="ic" aria-hidden="true">' + ic + '</span><span>' + esc(label) + '</span></button>'; }
    var html = aol
      ? b('read', '📬', 'Read', 'Open your mailbox') + b('new', '✏️', 'Write', 'Write a new message') + b('refresh', '🔄', 'Check Mail') + b('buddies', '👥', 'Buddies', 'Open the buddy list') + b('welcome', '🏠', 'Welcome')
      : b('new', '✉️', 'New') + b('reply', '↩️', 'Reply') + b('replyall', '↩️', 'Reply all') + b('forward', '➡️', 'Forward') + b('delete', '🗑️', 'Delete') + b('refresh', '🔄', 'Send/Receive');
    if (S.theme === 'ms') html += b('profile', '\uD83D\uDC96', 'My profile', 'Edit my profile') + '<button type="button" class="tb" data-act="sparkle" id="spk-btn" aria-pressed="false" title="Sparkle cursor"><span class="ic" aria-hidden="true">\u2728</span><span>Sparkles</span></button>';
    html += '<span class="tb-sp"></span><label class="tb-look">Look: <select id="look-sel" aria-label="Look"><option value="msn">MSN-style</option><option value="aol">AOL-style</option><option value="ms">MySpace-style</option></select></label>' +
      '<button type="button" class="tb" data-act="sound" id="snd-btn"><span class="ic" aria-hidden="true">' + (DMSound.isEnabled() ? '🔊' : '🔇') + '</span><span>Sound</span></button>' + b('signoff', '🚪', 'Sign off');
    tb.innerHTML = html; $('#look-sel').value = S.theme; updateToolbar();
  }
  function updateToolbar() {
    var has = !!S.current; ['reply', 'replyall', 'forward', 'delete'].forEach(function (a) { var el = $('#toolbar [data-act="' + a + '"]'); if (el) el.disabled = !has; });
    var sk = $('#spk-btn'); if (sk) sk.setAttribute('aria-pressed', String(!!S.sparkle));
    var sb = $('#snd-btn'); if (sb) sb.firstChild.textContent = DMSound.isEnabled() ? '🔊' : '🔇';
  }
  function buildMsn(desk) {
    desk.innerHTML = '<div class="msn"><aside class="msn-side" aria-label="Folders and contacts"><div class="panel-title">Mail folders</div><div data-view="folders"></div><div class="panel-title">People you write to</div><div data-view="contacts"></div></aside>' +
      '<section class="msn-center"><div class="msn-listwrap" data-view="list"></div><div class="msn-readerwrap" data-view="reader" aria-live="polite"></div></section></div>';
  }
  function buildMs(desk) {
    desk.innerHTML = '<div class="ms"><aside class="ms-left" aria-label="My profile and folders"><div class="ms-box" data-view="profile"></div><div class="ms-box"><h3>\uD83D\uDC8C Mail Center</h3><div data-view="folders"></div></div></aside>' +
      '<section class="ms-center"><div class="ms-banner" data-view="banner"></div><div class="ms-listwrap" data-view="list"></div><div class="ms-readerwrap" data-view="reader" aria-live="polite"></div></section>' +
      '<aside class="ms-right" aria-label="Top 8 friends"><div class="ms-box"><h3>\uD83D\uDC96 My Top 8</h3><div data-view="top8"></div></div></aside></div>';
  }
  function buildAol(desk) {
    var w = desk.clientWidth || 1000, h = desk.clientHeight || 600, wide = w >= 1000, bh = Math.max(320, h - 28);
    WM.open({ id: 'welcome', title: 'Welcome', icon: '🏠', x: 14, y: 14, w: 290, render: function (el) { el.innerHTML = '<div data-view="welcome"></div>'; } });
    WM.open({ id: 'mailbox', title: 'Mailbox', icon: '📬', x: 318, y: 14, w: wide ? w - 318 - 262 : Math.max(300, w - 332), h: bh, render: function (el) { el.innerHTML = '<div data-view="tabs" class="tabs"></div><div class="aol-list" data-view="list"></div>'; } });
    if (wide) WM.open({ id: 'buddies', title: 'Buddy List', icon: '👥', x: w - 244, y: 14, w: 230, h: Math.min(bh, 420), render: function (el) { el.innerHTML = '<div class="buddy" data-view="contacts"></div>'; } });
  }
  function openReaderWindow() {
    var desk = $('#desk'), w = desk.clientWidth || 1000, h = desk.clientHeight || 600;
    WM.open({ id: 'reader', title: 'Read: ' + (S.current ? S.current.subject : 'Mail'), icon: '✉️', x: Math.max(20, Math.min(340, w - 620)), y: 60, w: Math.min(620, w - 30), h: Math.min(500, h - 70), cls: 'reader-win', render: function (el) { el.innerHTML = '<div data-view="reader" style="height:100%"></div>'; } });
  }
  function openBuddies() { var d = $('#desk'); WM.open({ id: 'buddies', title: 'Buddy List', icon: '👥', x: Math.max(20, (d.clientWidth || 800) - 250), y: 30, w: 230, h: 340, render: function (el) { el.innerHTML = '<div class="buddy" data-view="contacts"></div>'; } }); refreshViews(['contacts']); }
  function openWelcome() { WM.open({ id: 'welcome', title: 'Welcome', icon: '🏠', x: 14, y: 14, w: 290, render: function (el) { el.innerHTML = '<div data-view="welcome"></div>'; } }); refreshViews(['welcome']); }

  /* ---------- views ---------- */
  var VIEWS = { profile: renderProfile, banner: renderBanner, top8: renderTop8, folders: renderFolders, contacts: renderContacts, list: renderList, reader: renderReader, welcome: renderWelcome, tabs: renderTabs };
  function refreshViews(only) {
    $$('[data-view]').forEach(function (el) { var name = el.getAttribute('data-view'), f = VIEWS[name]; if (f && (!only || only.indexOf(name) !== -1)) f(el); });
    updateToolbar(); updateTitle(); setStatus();
  }
  function updateTitle() { document.title = (S.unreadInbox > 0 ? '(' + S.unreadInbox + ') ' : '') + 'Poppy Mail'; }
  function moodParts() { var m = String(S.profile.mood || DEFAULT_PROFILE.mood).split('|'); return { emoji: m[0], text: m[1] || '' }; }
  function renderProfile(el) {
    var md = moodParts(), playing = DMSound.isJingle();
    el.className = 'ms-box profile'; el.innerHTML = '<div class="avatar" aria-hidden="true">' + esc(S.profile.avatar) + '</div><h2 class="pname glitter">' + esc(profName()) + '</h2><div class="online">Online now</div>' +
      '<div class="mood">Mood: ' + esc(md.emoji) + ' ' + esc(md.text) + '</div>' +
      '<div class="nowplaying' + (playing ? '' : ' paused') + '"><button type="button" data-act="jingle" aria-pressed="' + playing + '" aria-label="' + (playing ? 'Pause the tune' : 'Play a little tune') + '">' + (playing ? '\u23F8' : '\u25B6') + '</button><span class="song" title="' + esc(S.profile.song) + '"><span>\uD83C\uDFB5 Now playing: ' + esc(S.profile.song) + '</span></span></div>' +
      '<div class="about">' + esc(S.profile.about) + '</div><button type="button" class="btn" data-act="profile">\uD83D\uDC96 Edit my profile</button>';
  }
  function renderBanner(el) {
    var md = moodParts(), n = S.unreadInbox;
    el.innerHTML = '<h2><span aria-hidden="true">\u2728</span> <span class="glitter">' + esc(profName()) + '\u2019s Mail Space</span> <span aria-hidden="true">\u2728</span></h2><span class="sub">' + (n ? '\uD83D\uDCEC ' + n + ' new message' + (n === 1 ? '' : 's') + '!' : '\uD83D\uDCED No new mail') + ' &nbsp;|&nbsp; Mood: ' + esc(md.emoji) + ' ' + esc(md.text) + '</span>';
  }
  function renderTop8(el) {
    var top = S.contacts.slice(0, 8);
    el.innerHTML = top.length ? '<div class="top8">' + top.map(function (c, i) {
      return '<button type="button" class="t8" data-contact="' + esc(c.address) + '" title="Write to ' + esc(c.address) + '"><span class="rank" aria-hidden="true">#' + (i + 1) + '</span><span class="face" style="background:' + FACE[i % FACE.length] + '" aria-hidden="true">' + esc((c.name || c.address).charAt(0).toUpperCase()) + '</span><span class="nm">' + esc(c.name) + '</span></button>';
    }).join('') + '</div>' : '<p class="empty">Your Top 8 fills up as you read and write mail.</p>';
  }
  function renderFolders(el) {
    el.innerHTML = '<ul class="folders">' + S.folders.map(function (f) {
      return '<li><button type="button" class="folder" data-folder="' + esc(f.id) + '" aria-current="' + (f.id === S.folder) + '"><span aria-hidden="true">' + icon(f.kind) + '</span><span>' + esc(f.label) + '</span><span class="cnt">' + (f.unread || '') + '</span></button></li>';
    }).join('') + '</ul>';
  }
  function renderTabs(el) {
    var main = S.folders.filter(function (f) { return ['inbox', 'sent', 'drafts', 'spam', 'trash', 'starred'].indexOf(f.kind) !== -1; }), rest = S.folders.filter(function (f) { return main.indexOf(f) === -1; });
    el.setAttribute('role', 'tablist');
    el.innerHTML = main.map(function (f) { return '<button type="button" role="tab" class="tab" data-folder="' + esc(f.id) + '" aria-selected="' + (f.id === S.folder) + '">' + esc(f.label) + (f.unread ? ' (' + f.unread + ')' : '') + '</button>'; }).join('') +
      (rest.length ? '<select class="tab-more" data-more aria-label="More folders"><option value="">More...</option>' + rest.map(function (f) { return '<option value="' + esc(f.id) + '">' + esc(f.label) + '</option>'; }).join('') + '</select>' : '');
  }
  function renderContacts(el) {
    var aol = S.theme === 'aol';
    el.innerHTML = (aol ? '<h3>Buddies (' + S.contacts.length + ')</h3>' : '') + (S.contacts.length ? '<ul class="contacts">' + S.contacts.map(function (c) {
      return '<li><button type="button" class="contact" data-contact="' + esc(c.address) + '" title="Write to ' + esc(c.address) + '"><span class="dot" aria-hidden="true"></span><span>' + esc(c.name) + '</span></button></li>';
    }).join('') + '</ul>' : '<p class="empty">Nobody yet. Read some mail and your friends will show up here.</p>');
  }
  function renderWelcome(el) {
    var n = S.unreadInbox;
    el.className = 'welcome'; el.innerHTML = '<div class="big"><span class="' + (n ? 'flag-up' : '') + '" aria-hidden="true">' + (n ? '📬' : '📭') + '</span></div><h2>Welcome, ' + esc(profName()) + '!</h2>' +
      '<div class="banner">' + (n ? 'You’ve got ' + n + ' new message' + (n === 1 ? '' : 's') + '!' : 'No new mail right now.') + '</div>' +
      '<div class="so-buttons" style="justify-content:center"><button type="button" class="btn primary" data-act="read">Read My Mail</button><button type="button" class="btn" data-act="new">Write Mail</button></div>' +
      '<div class="tipbox">' + esc(TIPS[tipIdx % TIPS.length]) + '</div>';
  }
  function senderOf(m) { if (folderKind(S.folder) === 'sent') { var t = (m.to || '').split(',')[0].replace(/<.*>/, '').replace(/"/g, '').trim() || (m.to || ''); return 'To: ' + t; } return m.fromName || m.fromAddress || '(unknown)'; }
  function renderList(el) {
    var old = $('.mlist', el), st = old ? old.scrollTop : 0, hadFocus = el.contains(document.activeElement), focusSearch = document.activeElement && document.activeElement.id === 'list-q';
    var from = S.total ? S.page * S.perPage + 1 : 0, to = Math.min(S.total, (S.page + 1) * S.perPage), fk = S.folders.filter(function (f) { return f.id === S.folder; })[0];
    var rows = S.messages.map(function (m) {
      var sel = m.uid === S.selectedUid;
      return '<li class="mrow' + (m.unread ? ' unread' : '') + '" role="option" tabindex="' + (sel ? 0 : -1) + '" aria-selected="' + sel + '" data-uid="' + m.uid + '"><button type="button" class="star' + (m.starred ? ' on' : '') + '" data-star="' + m.uid + '" aria-label="' + (m.starred ? 'Unstar' : 'Star') + ' this message" aria-pressed="' + !!m.starred + '">⭐</button>' +
        '<span aria-hidden="true">' + (m.unread ? '✉️' : '📖') + (m.attachment ? '📎' : '') + '</span><span class="from">' + esc(senderOf(m)) + '</span><span class="subj">' + esc(m.subject) + '</span><span class="date">' + esc(fmtDate(m.date)) + '</span></li>';
    }).join('');
    var empty = S.loading ? '<li class="empty">Checking for mail...</li>' : (S.messages.length ? '' : '<li class="empty">' + (S.query ? 'Nothing matched your search.' : 'No messages here. 🍃') + '</li>');
    el.innerHTML = '<form class="lhead" data-search role="search"><label class="sr-only" for="list-q">Search mail</label><input id="list-q" type="search" placeholder="Search this folder..." value="' + esc(S.queryText) + '" autocomplete="off"><button type="submit" class="btn">Search</button>' +
      (S.query ? '<button type="button" class="btn" data-clear-search>Clear</button>' : '') + '<span class="pager"><span>' + (S.total ? from + '-' + to + ' of ' + S.total : '') + '</span><button type="button" class="btn" data-pager="-1" ' + (S.page <= 0 ? 'disabled' : '') + ' aria-label="Newer messages">◀</button><button type="button" class="btn" data-pager="1" ' + (to >= S.total ? 'disabled' : '') + ' aria-label="Older messages">▶</button></span></form>' +
      '<ul class="mlist" role="listbox" aria-label="Messages in ' + esc(fk ? fk.label : S.folder) + '">' + rows + empty + '</ul>';
    var nl = $('.mlist', el); nl.scrollTop = st;
    if (focusSearch) { var q = $('#list-q', el); q.focus(); try { q.setSelectionRange(q.value.length, q.value.length); } catch (e) {} }
    else if (hadFocus) { var r = $('.mrow[aria-selected="true"]', el); if (r) r.focus(); }
  }
  function viewDoc(m) {
    var csp = "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:" + (S.showPics ? ' https:' : '');
    return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '"><base target="_blank"><style>body{font:14px/1.45 Verdana,Arial,sans-serif;color:#111;background:#fff;margin:10px;overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:#0645ad}</style></head><body>' + sanitizeHtml(m.html) + '</body></html>';
  }
  function renderReader(el) {
    var m = S.current;
    if (!m) { el.innerHTML = '<div class="empty">' + (S.theme === 'aol' ? 'Pick a message in your mailbox and double-click it.' : 'Select a message to read it.') + '</div>'; return; }
    var hasHtml = !!m.html, formatted = hasHtml && S.viewHtml;
    var attach = (m.attachments || []).map(function (a) { return '<a href="/api/attachment?folder=' + encodeURIComponent(m.folder) + '&uid=' + m.uid + '&index=' + a.index + '&token=' + encodeURIComponent(TOKEN) + '" download>📎 ' + esc(a.filename) + ' (' + fmtSize(a.size) + ')</a>'; }).join('');
    el.innerHTML = '<article class="reader"><div class="reader-head"><h2>' + esc(m.subject) + '</h2><dl class="hdr"><dt>From</dt><dd>' + esc(m.from.map(person).join(', ')) + '</dd><dt>To</dt><dd>' + esc(m.to.map(personShort).join(', ')) + '</dd>' +
      (m.cc.length ? '<dt>Cc</dt><dd>' + esc(m.cc.map(personShort).join(', ')) + '</dd>' : '') + '<dt>Date</dt><dd>' + esc(fmtFull(m.date)) + '</dd></dl></div>' +
      '<div class="rtools ractions"><button type="button" class="btn" data-act="reply">↩️ Reply</button><button type="button" class="btn" data-act="replyall">Reply all</button><button type="button" class="btn" data-act="forward">➡️ Forward</button><button type="button" class="btn" data-act="delete">🗑️ Delete</button>' +
      '<button type="button" class="btn" data-act="unread">Mark unread</button><button type="button" class="btn" data-act="star" aria-pressed="' + !!m.starred + '">' + (m.starred ? '⭐ Starred' : '☆ Star') + '</button></div>' +
      (hasHtml ? '<div class="rtools"><button type="button" class="btn" data-viewmode="' + (formatted ? 'text' : 'html') + '">' + (formatted ? 'View as plain text' : 'View formatted') + '</button>' +
        (formatted && !S.showPics ? '<span class="imgwarn">Pictures from the internet are blocked to protect your privacy. <button type="button" class="btn" data-pics>Show pictures</button></span>' : '') + '</div>' : '') +
      '<div class="rbody' + (formatted ? ' frame-mode' : '') + '"></div>' + (attach ? '<div class="attach">' + attach + '</div>' : '') + '</article>';
    var body = $('.rbody', el);
    if (formatted) {
      var f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox'); f.setAttribute('title', 'Message: ' + m.subject); f.srcdoc = viewDoc(m); body.appendChild(f);
    } else { var pre = document.createElement('pre'); pre.innerHTML = linkify(bodyText(m)); body.appendChild(pre); }
  }

  /* ---------- status bar ---------- */
  function setStatus(msg) {
    var st = $('#status'); if (!st) return;
    st.innerHTML = '<span>' + (S.demo ? '🎮 Demo mailbox' : '🟢 Connected as ' + esc(S.email)) + '</span><span class="st-tip">' + esc(msg || TIPS[tipIdx % TIPS.length]) + '</span><span id="st-clock">' + clockText() + '</span><span>56000 bps</span>';
  }
  function clockText() { var s = Math.floor((Date.now() - onlineSince) / 1000); return 'Online ' + pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60); }
  function startTimers() {
    stopTimers();
    timers.clock = setInterval(function () { var c = $('#st-clock'); if (c) c.textContent = clockText(); }, 1000);
    timers.tip = setInterval(function () { tipIdx++; var t = $('#status .st-tip'); if (t) t.textContent = TIPS[tipIdx % TIPS.length]; var w = $('[data-view="welcome"] .tipbox'); if (w) w.textContent = TIPS[tipIdx % TIPS.length]; }, 12000);
    timers.poll = setInterval(poll, S.demo ? 12000 : 60000);
  }
  function stopTimers() { Object.keys(timers).forEach(function (k) { if (timers[k]) clearInterval(timers[k]); timers[k] = null; }); }
  function poll() {
    if (!S.signedOn) return;
    api('/api/poll').then(function (j) {
      if (j.unread > S.unreadInbox) {
        S.unreadInbox = j.unread; DMSound.newMail(); toast('📬 You’ve got new mail!');
        loadFolders(); if (folderKind(S.folder) === 'inbox' && S.page === 0 && !S.query) loadMessages().catch(function () {});
      } else if (j.unread !== S.unreadInbox) { S.unreadInbox = j.unread; loadFolders(); }
    }).catch(function () {});
  }

  /* ---------- composing ---------- */
  function openCompose(o) {
    o = o || {}; var id = 'compose' + (++composeCount), sent = false, handle;
    handle = WM.open({
      id: id, title: o.title || 'Write Mail', icon: '✏️', w: 540, h: 470, x: 60 + (composeCount % 5) * 26, y: 40 + (composeCount % 5) * 26, cls: 'compose-win',
      onClose: function () {
        if (handle.forceClose || sent) return true;
        var dirty = ($('textarea', handle.body).value.trim() && $('textarea', handle.body).value.trim() !== (o.body || '').trim()) || $('[name=to]', handle.body).value.trim() !== (o.to || '').trim();
        if (!dirty) return true;
        confirmBox('Throw this message away?', 'You haven’t sent it yet.', 'Throw it away').then(function (ok) { if (ok) { handle.forceClose = true; WM.close(id); } });
        return false;
      },
      render: function (el) {
        el.innerHTML = '<form class="compose" novalidate><div class="row"><label for="' + id + '-to">To</label><input id="' + id + '-to" name="to" type="text" list="' + id + '-dl" autocomplete="off" value="' + esc(o.to || '') + '"></div>' +
          '<div class="row cc-row"' + (o.cc ? '' : ' hidden') + '><label for="' + id + '-cc">Cc</label><input id="' + id + '-cc" name="cc" type="text" autocomplete="off" value="' + esc(o.cc || '') + '"></div>' +
          '<div class="row"><label for="' + id + '-sub">Subject</label><input id="' + id + '-sub" name="subject" type="text" autocomplete="off" value="' + esc(o.subject || '') + '"></div>' +
          '<datalist id="' + id + '-dl">' + S.contacts.map(function (c) { return '<option value="' + esc(c.address) + '">' + esc(c.name) + '</option>'; }).join('') + '</datalist>' +
          '<label class="sr-only" for="' + id + '-body">Message</label><textarea id="' + id + '-body" name="body"></textarea>' +
          '<div class="actions"><button type="submit" class="btn primary">📨 Send</button><button type="button" class="btn" data-cc>Add Cc</button><button type="button" class="btn" data-discard>Discard</button><span class="muted" data-cstatus></span></div></form>';
        $('textarea', el).value = o.body || '';
        var form = $('form', el), statusEl = $('[data-cstatus]', el);
        $('[data-cc]', el).onclick = function () { $('.cc-row', el).hidden = false; $('[name=cc]', el).focus(); };
        $('[data-discard]', el).onclick = function () { WM.close(id); };
        form.onsubmit = function (e) {
          e.preventDefault();
          var data = { to: form.to.value.trim(), cc: form.cc.value.trim(), subject: form.subject.value.trim(), body: form.body.value, inReplyTo: o.inReplyTo || '', references: o.references || '' };
          if (!data.to && !data.cc) { toast('Please add someone to send this to.', 'error'); DMSound.error(); form.to.focus(); return; }
          var btn = $('.btn.primary', el); btn.disabled = true; statusEl.textContent = 'Sending...';
          api('/api/send', { body: data }).then(function () {
            sent = true; DMSound.sent(); toast('📨 Message sent!'); WM.close(id);
            if (folderKind(S.folder) === 'sent') loadMessages().catch(function () {});
          }).catch(function (err) { btn.disabled = false; statusEl.textContent = ''; fail(err); });
        };
        setTimeout(function () { (o.to ? $('[name=body]', el) : $('[name=to]', el)).focus(); }, 30);
      }
    });
    return handle;
  }
  function quoted(m) { return bodyText(m).split(/\r?\n/).map(function (l) { return '> ' + l; }).join('\n'); }
  function replyTo(all) {
    var m = S.current; if (!m) return; var f = (m.replyTo && m.replyTo[0]) || m.from[0] || { address: '', name: '' }, cc = [];
    if (all) (m.to.concat(m.cc)).forEach(function (a) { if (a.address.toLowerCase() !== S.email.toLowerCase() && a.address.toLowerCase() !== f.address.toLowerCase()) cc.push(a.address); });
    openCompose({ title: 'Reply: ' + m.subject, to: f.address, cc: cc.join(', '), subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject,
      body: '\n\nOn ' + fmtFull(m.date) + ', ' + personShort(f) + ' wrote:\n' + quoted(m), inReplyTo: m.messageId, references: (m.references + ' ' + m.messageId).trim() });
  }
  function forward() {
    var m = S.current; if (!m) return;
    openCompose({ title: 'Forward: ' + m.subject, subject: /^fwd?:/i.test(m.subject) ? m.subject : 'Fwd: ' + m.subject,
      body: '\n\n---------- Forwarded message ----------\nFrom: ' + m.from.map(person).join(', ') + '\nDate: ' + fmtFull(m.date) + '\nSubject: ' + m.subject + '\nTo: ' + m.to.map(person).join(', ') + '\n\n' + bodyText(m) + (m.attachments.length ? '\n\n(Attachments are not included when forwarding.)' : '') });
  }

  /* ---------- message actions ---------- */
  function deleteCurrent() {
    var m = S.current; if (!m) return; var inTrash = folderKind(S.folder) === 'trash';
    confirmBox(inTrash ? 'Delete forever?' : 'Move to the Trash?', inTrash ? 'This message will be gone for good. This can’t be undone.' : 'You can find it again in the Trash.', inTrash ? 'Delete forever' : 'Move to Trash').then(function (ok) {
      if (!ok) return;
      api('/api/delete', { body: { folder: S.folder, uid: m.uid } }).then(function (j) {
        DMSound.trash(); toast('🗑️ Message ' + j.result + '.');
        var i = S.messages.map(function (x) { return x.uid; }).indexOf(m.uid), next = S.messages[i + 1] || S.messages[i - 1];
        S.messages = S.messages.filter(function (x) { return x.uid !== m.uid; }); S.total = Math.max(0, S.total - 1); S.current = null; S.selectedUid = null;
        if (WM.has('reader')) WM.close('reader'); refreshViews(); loadFolders();
        if (next && S.theme !== 'aol') selectMessage(next.uid, false);
      }).catch(fail);
    });
  }
  function toggleStar(uid) {
    var m = S.messages.filter(function (x) { return x.uid === uid; })[0], val = !(m ? m.starred : (S.current && S.current.starred));
    api('/api/flag', { body: { folder: S.folder, uid: uid, flag: 'starred', value: val } }).then(function () {
      if (m) m.starred = val; if (S.current && S.current.uid === uid) S.current.starred = val; refreshViews(['list', 'reader']); if (folderKind(S.folder) === 'starred' && !val) loadMessages().catch(function () {});
    }).catch(fail);
  }
  function markUnread() {
    var m = S.current; if (!m) return;
    api('/api/flag', { body: { folder: S.folder, uid: m.uid, flag: 'seen', value: false } }).then(function () {
      var row = S.messages.filter(function (x) { return x.uid === m.uid; })[0]; if (row) row.unread = true; loadFolders(); refreshViews(['list']); toast('Marked as unread.');
    }).catch(fail);
  }
  function act(name) {
    DMSound.click();
    switch (name) {
      case 'new': openCompose({}); break;
      case 'reply': replyTo(false); break;
      case 'replyall': replyTo(true); break;
      case 'forward': forward(); break;
      case 'delete': deleteCurrent(); break;
      case 'star': if (S.current) toggleStar(S.current.uid); break;
      case 'unread': markUnread(); break;
      case 'refresh': setStatus('Checking mail...'); Promise.all([loadFolders(), loadMessages()]).then(function () { toast('Mail checked.'); }).catch(fail); break;
      case 'read': if (!WM.has('mailbox')) buildShell(); WM.focus('mailbox'); break;
      case 'buddies': openBuddies(); break;
      case 'welcome': openWelcome(); break;
      case 'sound': DMSound.setEnabled(!DMSound.isEnabled()); S.sound = DMSound.isEnabled(); store.set('sound', S.sound); if (S.sound) { DMSound.unlock(); DMSound.click(); } updateToolbar(); break;
      case 'profile': openProfile(); break;
      case 'sparkle': S.sparkle = !S.sparkle; store.set('sparkle', S.sparkle); updateToolbar(); toast(S.sparkle ? '\u2728 Sparkle cursor on!' : 'Sparkle cursor off.'); break;
      case 'jingle': if (DMSound.isJingle()) DMSound.jingle(false); else if (!DMSound.jingle(true)) toast('Turn Sound on to play the tune.'); refreshViews(['profile']); break;
      case 'signoff': signOff(); break;
    }
  }

  /* ---------- profile (MySpace-style look) ---------- */
  function applySkin() { document.documentElement.setAttribute('data-skin', S.profile.skin || 'pink'); }
  function openProfile() {
    var d = $('#profile-dlg'), P = S.profile;
    $('#pf-name').value = P.name; $('#pf-mood').value = P.mood; if ($('#pf-mood').value !== P.mood) $('#pf-mood').selectedIndex = 0; $('#pf-song').value = P.song; $('#pf-about').value = P.about;
    $('#pf-avatars').innerHTML = AVATARS.map(function (a) { return '<label><input type="radio" name="pf-av" value="' + a + '"' + (a === P.avatar ? ' checked' : '') + '><span class="opt" aria-label="Avatar ' + a + '">' + a + '</span></label>'; }).join('');
    $('#pf-skins').innerHTML = SKINS.map(function (k) { return '<label><input type="radio" name="pf-sk" value="' + k[0] + '"' + (k[0] === P.skin ? ' checked' : '') + '><span class="opt skin">' + esc(k[1]) + '</span></label>'; }).join('');
    d.showModal(); $('#pf-name').focus();
  }
  function saveProfile(e) {
    e.preventDefault();
    var av = $('input[name="pf-av"]:checked'), sk = $('input[name="pf-sk"]:checked');
    S.profile = { name: $('#pf-name').value.trim().slice(0, 30), mood: $('#pf-mood').value, song: $('#pf-song').value.trim().slice(0, 60) || DEFAULT_PROFILE.song, about: $('#pf-about').value.trim().slice(0, 140) || DEFAULT_PROFILE.about, avatar: av ? av.value : DEFAULT_PROFILE.avatar, skin: sk ? sk.value : 'pink' };
    store.set('profile', S.profile); applySkin(); $('#profile-dlg').close(); DMSound.click(); toast('\uD83D\uDC96 Profile saved!'); refreshViews(['profile', 'banner', 'welcome']);
  }
  var lastSpark = 0;
  function trail(e) {
    if (!S.sparkle || reduceMotion) return; var now = Date.now(); if (now - lastSpark < 45) return; lastSpark = now;
    var el = document.createElement('i'); el.className = 'spark'; el.setAttribute('aria-hidden', 'true'); el.textContent = ['\u2726', '\u2727', '\u2665', '\u273F'][Math.floor(Math.random() * 4)];
    el.style.left = (e.clientX + 6) + 'px'; el.style.top = (e.clientY + 6) + 'px'; el.style.color = ['#ff2fa6', '#a24bff', '#ffd23f', '#27b6c9'][Math.floor(Math.random() * 4)];
    document.body.appendChild(el); setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 850);
  }

  /* ---------- events (delegated, set up once) ---------- */
  function wire() {
    $('#toolbar').addEventListener('click', function (e) { var b = e.target.closest('[data-act]'); if (b && !b.disabled) act(b.getAttribute('data-act')); });
    $('#toolbar').addEventListener('change', function (e) { if (e.target.id === 'look-sel') setTheme(e.target.value); });
    var desk = $('#desk');
    desk.addEventListener('click', function (e) {
      var t = e.target, el;
      if ((el = t.closest('[data-star]'))) { e.stopPropagation(); toggleStar(+el.getAttribute('data-star')); return; }
      if ((el = t.closest('[data-folder]'))) { DMSound.click(); setFolder(el.getAttribute('data-folder')); return; }
      if ((el = t.closest('[data-pager]'))) { S.page = Math.max(0, S.page + +el.getAttribute('data-pager')); loadMessages().catch(fail); return; }
      if (t.closest('[data-clear-search]')) { S.query = ''; S.queryText = ''; S.page = 0; loadMessages().catch(fail); return; }
      if ((el = t.closest('[data-contact]'))) { openCompose({ to: el.getAttribute('data-contact') }); return; }
      if ((el = t.closest('[data-viewmode]'))) { S.viewHtml = el.getAttribute('data-viewmode') === 'html'; refreshViews(['reader']); return; }
      if (t.closest('[data-pics]')) { S.showPics = true; refreshViews(['reader']); return; }
      if ((el = t.closest('[data-act]'))) { act(el.getAttribute('data-act')); return; }
      if ((el = t.closest('.mrow'))) { selectMessage(+el.getAttribute('data-uid'), false); }
    });
    desk.addEventListener('dblclick', function (e) { var row = e.target.closest('.mrow'); if (row && !e.target.closest('[data-star]')) selectMessage(+row.getAttribute('data-uid'), true); });
    desk.addEventListener('change', function (e) { if (e.target.hasAttribute('data-more') && e.target.value) { var v = e.target.value; e.target.value = ''; setFolder(v); } });
    desk.addEventListener('input', function (e) { if (e.target.id === 'list-q') S.queryText = e.target.value; });
    desk.addEventListener('submit', function (e) {
      if (e.target.hasAttribute('data-search')) { e.preventDefault(); S.query = (S.queryText || '').trim(); S.page = 0; loadMessages().catch(fail); }
    });
    desk.addEventListener('keydown', function (e) {
      var row = e.target.closest && e.target.closest('.mrow'); if (!row) return;
      var rows = $$('.mrow', row.parentNode), i = rows.indexOf(row);
      if (e.key === 'ArrowDown' && rows[i + 1]) { e.preventDefault(); selectMessage(+rows[i + 1].getAttribute('data-uid'), false); }
      else if (e.key === 'ArrowUp' && rows[i - 1]) { e.preventDefault(); selectMessage(+rows[i - 1].getAttribute('data-uid'), false); }
      else if (e.key === 'Enter') { e.preventDefault(); selectMessage(+row.getAttribute('data-uid'), true); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (S.current && S.current.uid === +row.getAttribute('data-uid')) { e.preventDefault(); deleteCurrent(); } }
    });
    window.addEventListener('focus', function () { if (S.signedOn) poll(); });
    document.addEventListener('pointermove', trail);
    $('#profile-form').addEventListener('submit', saveProfile); $('#pf-cancel').addEventListener('click', function () { $('#profile-dlg').close(); });
  }

  /* ---------- start ---------- */
  function init() {
    document.documentElement.setAttribute('data-theme', S.theme); applySkin(); DMSound.setEnabled(S.sound); $('#so-sound').checked = S.sound;
    $$('input[name="look"]').forEach(function (r) { r.checked = r.value === S.theme; r.addEventListener('change', function () { setTheme(r.value); }); });
    $('#so-show').addEventListener('change', function (e) { $('#so-pass').type = e.target.checked ? 'text' : 'password'; });
    $('#so-form').addEventListener('submit', function (e) { e.preventDefault(); var em = $('#so-email').value.trim(), pw = $('#so-pass').value; if (!em || !pw) { var er = $('#so-error'); er.textContent = 'Please type your Gmail address and your App Password, or try the demo.'; er.hidden = false; return; } doSignOn({ email: em, password: pw }); });
    $('#so-demo').addEventListener('click', function () { doSignOn({ demo: true }); });
    wire();
    if ($('meta[name="dm-autodemo"]').content === '1') doSignOn({ demo: true });
  }
  init();
})();
