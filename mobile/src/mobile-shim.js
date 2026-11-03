/* SPN OS mobile shim. Appended to the web app by scripts/build-www.mjs and only
   active inside the Capacitor app (it does nothing in a normal browser).
   - hardware Back: close overlays, step back through modules, then background the app
   - downloads: the WebView cannot save blob: URLs, so PDF/Excel exports are saved to
     Downloads/SPN OS by the native SpnDownloads plugin, with a "Download complete"
     notification in the notification bar and an Open / Share bar in the app
   - sharing (WhatsApp receipts): the file goes to the Android share sheet
   - external links open in the system browser instead of inside the app */
(function(){
  const cap = window.Capacitor;
  const P = (cap && cap.Plugins) || {};
  const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  if(!isNative) return;

  /* 1) hardware back button */
  if(P.App && typeof P.App.addListener === 'function'){
    P.App.addListener('backButton', function(){
      try{
        if(document.getElementById('active-modal')){ if(typeof closeModal === 'function') closeModal(); return; }
        if(document.querySelector('.drawer')){ if(typeof closeDrawer === 'function') closeDrawer(); return; }
        if(document.body.classList.contains('sb-open')){ document.body.classList.remove('sb-open'); return; }
        const view = history.state && history.state.view;
        if(view && view !== 'dashboard' && history.length > 1){ history.back(); return; }
      }catch(e){}
      if(P.App.minimizeApp) P.App.minimizeApp();
    });
  }

  /* 2) status bar colour matches the sidebar */
  try{
    if(P.StatusBar){
      if(P.StatusBar.setBackgroundColor) P.StatusBar.setBackgroundColor({ color: '#1E2B22' });
      if(P.StatusBar.setStyle) P.StatusBar.setStyle({ style: 'DARK' });
    }
  }catch(e){}

  /* 3) share-sheet downloads */
  /* opts.text becomes the message caption (WhatsApp shows it under the PDF) */
  async function shareBlob(blob, filename, opts){
    if(!P.Filesystem || !P.Share){ alert('Sharing is not available in this build.'); return; }
    const b64 = await new Promise(function(res, rej){
      const fr = new FileReader();
      fr.onload = function(){ res(String(fr.result).split(',')[1]); };
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
    const safe = String(filename || 'file').replace(/[^A-Za-z0-9._-]+/g, '_');
    const w = await P.Filesystem.writeFile({ path: safe, data: b64, directory: 'CACHE' });
    const o = opts || {};
    const req = { title: safe, url: w.uri, dialogTitle: o.dialogTitle || ('Save or share ' + safe) };
    if(o.text) req.text = String(o.text);
    /* closing the share sheet is not an error */
    try{ await P.Share.share(req); }catch(e){ if(/cancel/i.test(String((e && e.message) || e))) return; throw e; }
  }
  /* 3) downloads: saved to Downloads/SPN OS with a "Download complete" notification (tap opens
     the file) and the same news in the app, with Open and Share. A build without the native
     plugin falls back to the share sheet. */
  var MIME = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv', json: 'application/json', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
  function mimeFor(name, blob){
    var ext = String(name || '').split('.').pop().toLowerCase();
    return MIME[ext] || (blob && blob.type) || 'application/octet-stream';
  }
  function blobToB64(blob){
    return new Promise(function(res, rej){ var fr = new FileReader(); fr.onload = function(){ res(String(fr.result).split(',')[1]); }; fr.onerror = rej; fr.readAsDataURL(blob); });
  }
  var askedNotif = false;
  async function ensureNotifPermission(){
    if(askedNotif || !P.LocalNotifications) return;
    askedNotif = true;
    try{ var p = await P.LocalNotifications.checkPermissions(); if(p.display !== 'granted' && p.display !== 'denied') await P.LocalNotifications.requestPermissions(); }catch(e){}
  }
  async function saveBlob(blob, filename){
    var DL = P.SpnDownloads;
    var name = String(filename || 'file').replace(/[\\\/:*?"<>|]+/g, '_');
    if(!DL || !DL.save){ try{ return await shareBlob(blob, name); }catch(e){ showDownloadBar(null, (e && e.message) || 'Sharing failed'); return; } }
    var mime = mimeFor(name, blob);
    try{
      await ensureNotifPermission();
      var r = await DL.save({ data: await blobToB64(blob), filename: name, mimeType: mime });
      showDownloadBar(r);
      return r;
    }catch(e){
      /* not saved: offer the share sheet instead so the file is never lost */
      showDownloadBar(null, (e && e.message) || 'The file could not be saved');
      try{ await shareBlob(blob, name); }catch(e2){}
    }
  }
  /* the in-app half of "Download complete": file name, where it went, Open and Share */
  function showDownloadBar(r, error){
    var old = document.getElementById('spn-dl-bar'); if(old) old.remove();
    var bar = document.createElement('div');
    bar.id = 'spn-dl-bar';
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(14px + env(safe-area-inset-bottom, 0px));z-index:2147483000;background:var(--surface,#fff);color:var(--ink,#242B22);border:1px solid var(--line,#E2E7DF);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.22);padding:12px 14px;display:flex;align-items:center;gap:12px;font:13px/1.35 Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;';
    var esc = function(t){ return String(t == null ? '' : t).replace(/[&<>"']/g, function(c){ return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
    var btn = 'border:none;background:var(--mint,#E3EEDA);color:var(--forest,#315C3A);font-weight:600;border-radius:9px;padding:7px 12px;font-size:12.5px;';
    var closeBtn = '<button type="button" data-a="close" aria-label="Dismiss" style="border:none;background:none;color:inherit;opacity:.6;font-size:20px;line-height:1;padding:4px 2px 4px 6px;">&times;</button>';
    if(error){
      bar.innerHTML = '<div style="flex:1;min-width:0;"><b>Download not saved</b><div style="opacity:.75;font-size:12px;">' + esc(error) + '. Opening the share sheet instead.</div></div>' + closeBtn;
    } else {
      bar.innerHTML = '<div style="width:34px;height:34px;border-radius:10px;background:var(--mint,#E3EEDA);color:var(--forest,#315C3A);display:flex;align-items:center;justify-content:center;flex:none;"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></div>'
        + '<div style="flex:1;min-width:0;"><b>Download complete</b><div style="opacity:.75;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(r.name) + ' · ' + esc(r.location || 'Downloads') + '</div></div>'
        + '<button type="button" data-a="open" style="' + btn + '">Open</button><button type="button" data-a="share" style="' + btn + '">Share</button>' + closeBtn;
      bar.querySelector('[data-a="open"]').onclick = function(){ P.SpnDownloads.open({ uri: r.uri, mimeType: r.mimeType }).catch(function(e){ if(typeof toast === 'function') toast((e && e.message) || 'Could not open the file', 'err'); }); bar.remove(); };
      bar.querySelector('[data-a="share"]').onclick = function(){ P.SpnDownloads.share({ uri: r.uri, mimeType: r.mimeType, name: r.name }).catch(function(){}); bar.remove(); };
    }
    var cl = bar.querySelector('[data-a="close"]'); if(cl) cl.onclick = function(){ bar.remove(); };
    document.body.appendChild(bar);
    /* sit above a dialog's Save / Close bar rather than over its buttons */
    try{
      var foot = Array.prototype.slice.call(document.querySelectorAll('#active-modal .modal-foot, .drawer .drawer-foot')).filter(function(fo){ var fr = fo.getBoundingClientRect(); return fr.height > 0 && fr.top < window.innerHeight; }).pop();
      if(foot){ var ft = foot.getBoundingClientRect().top; if(bar.getBoundingClientRect().bottom > ft) bar.style.bottom = Math.max(14, window.innerHeight - ft + 8) + 'px'; }
    }catch(e){}
    setTimeout(function(){ if(bar.parentNode) bar.remove(); }, error ? 6000 : 9000);
  }
  window.SPN_MOBILE = { shareBlob: shareBlob, saveBlob: saveBlob, platform: cap.getPlatform ? cap.getPlatform() : 'android' };

  /* 3a) the field being typed in stays visible above the keyboard (the app shrinks when the
     keyboard opens; this brings the focused field back into view once it has) */
  function revealFocused(){
    var el = document.activeElement;
    if(!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !el.getBoundingClientRect) return;
    var r = el.getBoundingClientRect();
    /* inside a dialog, the part the user can see sits between its sticky title and Save bar */
    var top = 8, bottom = window.innerHeight - 8;
    var m = el.closest && el.closest('.modal');
    if(m){
      var mr = m.getBoundingClientRect(), hd = m.querySelector('.modal-head'), ft = m.querySelector('.modal-foot');
      top = Math.max(top, hd ? hd.getBoundingClientRect().bottom : mr.top);
      bottom = Math.min(bottom, ft ? ft.getBoundingClientRect().top : mr.bottom);
    }
    if(r.top >= top && r.bottom <= bottom) return;
    try{ el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }catch(e){ el.scrollIntoView(); }
  }
  document.addEventListener('focusin', function(){ setTimeout(revealFocused, 350); });
  /* only when the keyboard opens (the height shrinks, the width stays): rotating the phone or
     resizing a split screen must not pull the page back to a field the user has left */
  var lastW = window.innerWidth, lastH = window.innerHeight;
  window.addEventListener('resize', function(){
    var w = window.innerWidth, hgt = window.innerHeight;
    var opened = (w === lastW) && (hgt < lastH - 80);
    lastW = w; lastH = hgt;
    if(opened) setTimeout(revealFocused, 80);
  });

  /* 3b) notification-bar notifications (local, no Google/Huawei push services needed,
     so they work on HMS phones too). One channel per tone; the user's tone in the
     profile picks the channel. Reminders are scheduled by the app for dated items. */
  var LN = P.LocalNotifications;
  var TONE_FILES = { default: 'spn_chime.wav', bell: 'spn_bell.wav', drip: 'spn_drip.wav', soft: 'spn_soft.wav', alert: 'spn_alert.wav' };
  function channelFor(tone){ return 'spn_' + (TONE_FILES[tone] ? tone : (tone === 'none' ? 'none' : (tone === 'system' ? 'system' : 'default'))); }
  async function ensureChannels(){
    if(!LN || !LN.createChannel) return;
    /* no sound property = the phone's own default notification sound; the user can
       change any channel's sound to any system sound/ringtone in the phone settings */
    try{ await LN.createChannel({ id: 'spn_system', name: 'SPN OS · phone default sound', description: 'SPN OS alerts and reminders with the phone\'s notification sound', importance: 4, visibility: 1, vibration: true, lights: true }); }catch(e){}
    for(const k of Object.keys(TONE_FILES)){
      try{ await LN.createChannel({ id: 'spn_' + k, name: 'SPN OS · ' + k + ' tone', description: 'SPN OS alerts and reminders', importance: 4, visibility: 1, sound: TONE_FILES[k], vibration: true, lights: true }); }catch(e){}
    }
    try{ await LN.createChannel({ id: 'spn_none', name: 'SPN OS · silent', description: 'SPN OS alerts without sound', importance: 3, sound: null, vibration: false }); }catch(e){}
  }
  /* opens Settings → Apps → SPN OS → Notifications, where each tone channel can be
     given any system sound or ringtone (the only place Android allows that) */
  async function openNotificationSettings(){
    var NS = P.NativeSettings;
    if(!NS || !NS.openAndroid) return false;
    try{ await NS.openAndroid({ option: 'app_notification' }); return true; }catch(e){ try{ await NS.openAndroid({ option: 'application_details' }); return true; }catch(e2){ return false; } }
  }
  var nextNotifId = 1;
  async function notify(o){
    if(!LN) return;
    try{
      var perm = await LN.checkPermissions();
      if(perm.display !== 'granted'){ var r = await LN.requestPermissions(); if(r.display !== 'granted') return; }
      await LN.schedule({ notifications: [{ id: 1000000 + (nextNotifId++ % 100000), title: o.title, body: o.body || '', channelId: channelFor(o.tone), smallIcon: 'ic_stat_spn', extra: { view: o.view || 'dashboard' }, schedule: { at: new Date(Date.now() + 400) } }] });
    }catch(e){}
  }
  async function scheduleReminders(list, tone){
    if(!LN) return;
    try{
      var pending = await LN.getPending();
      var ours = (pending.notifications || []).filter(function(n){ return n.id >= 2000000 && n.id < 3000000; }).map(function(n){ return { id: n.id }; });
      if(ours.length) await LN.cancel({ notifications: ours });
      if(!list || !list.length) return;
      var perm = await LN.checkPermissions();
      if(perm.display !== 'granted') return;
      var ch = channelFor(tone);
      var notifications = list.slice(0, 60).map(function(r, i){ return { id: 2000000 + i, title: r.title, body: r.body || '', channelId: ch, smallIcon: 'ic_stat_spn', extra: { view: r.view || 'dashboard' }, schedule: { at: new Date(r.at), allowWhileIdle: true } }; });
      await LN.schedule({ notifications: notifications });
    }catch(e){}
  }
  async function requestNotifPermission(){ if(!LN) return 'unavailable'; try{ var r = await LN.requestPermissions(); return r.display; }catch(e){ return 'error'; } }
  async function notifPermission(){ if(!LN) return 'unavailable'; try{ var r = await LN.checkPermissions(); return r.display; }catch(e){ return 'error'; } }
  if(LN && LN.addListener){
    LN.addListener('localNotificationActionPerformed', function(ev){
      try{ var v = ev && ev.notification && ev.notification.extra && ev.notification.extra.view; if(v && typeof nav === 'function' && typeof CURRENT !== 'undefined' && CURRENT) nav(v); }catch(e){}
    });
  }
  ensureChannels();
  Object.assign(window.SPN_MOBILE, { notify: notify, scheduleReminders: scheduleReminders, requestNotifPermission: requestNotifPermission, notifPermission: notifPermission, openNotificationSettings: openNotificationSettings });

  function hookLibraries(){
    try{
      const J = window.jspdf && window.jspdf.jsPDF;
      if(J && J.API && !J.API.__spnHooked){
        const origSave = J.API.save;
        J.API.save = function(name){
          try{ saveBlob(this.output('blob'), name || 'document.pdf').catch(function(){}); return this; }
          catch(e){ return origSave.apply(this, arguments); }
        };
        J.API.__spnHooked = true;
      }
    }catch(e){}
    try{
      if(window.XLSX && !window.XLSX.__spnHooked){
        const origWrite = window.XLSX.writeFile;
        window.XLSX.writeFile = function(wb, name, opts){
          try{
            const ab = window.XLSX.write(wb, Object.assign({ bookType: 'xlsx', type: 'array' }, opts || {}));
            saveBlob(new Blob([ab], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name || 'sheet.xlsx').catch(function(){});
          }catch(e){ return origWrite.apply(this, arguments); }
        };
        window.XLSX.__spnHooked = true;
      }
    }catch(e){}
  }
  hookLibraries();
  document.addEventListener('DOMContentLoaded', hookLibraries);

  /* anchors with a download attribute that point at blob:/data: URLs */
  document.addEventListener('click', async function(e){
    const a = e.target && e.target.closest && e.target.closest('a[download]');
    if(!a) return;
    const href = a.getAttribute('href') || '';
    if(!/^(blob:|data:)/.test(href)) return;
    e.preventDefault();
    /* private documents (staff ID copies) stay out of the shared Downloads folder: share sheet only */
    try{
      const blob = await (await fetch(href)).blob();
      await (a.hasAttribute('data-spn-private') ? shareBlob : saveBlob)(blob, a.getAttribute('download') || 'file');
    }catch(err){ if(typeof toast === 'function') toast('Could not open the file', 'err'); }
  }, true);

  /* external links (maps, APK downloads): Capacitor already opens target="_blank"
     and other-origin links in the system browser, nothing to do here */
})();
