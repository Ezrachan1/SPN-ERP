/* SPN OS mobile shim. Appended to the web app by scripts/build-www.mjs and only
   active inside the Capacitor app (it does nothing in a normal browser).
   - hardware Back: close overlays, step back through modules, then background the app
   - downloads: the WebView cannot save blob: URLs, so PDF/Excel exports are written
     to the app cache and handed to the Android share sheet (save to Drive, WhatsApp,
     print, ...)
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
  async function shareBlob(blob, filename){
    if(!P.Filesystem || !P.Share){ alert('Sharing is not available in this build.'); return; }
    const b64 = await new Promise(function(res, rej){
      const fr = new FileReader();
      fr.onload = function(){ res(String(fr.result).split(',')[1]); };
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
    const safe = String(filename || 'file').replace(/[^A-Za-z0-9._-]+/g, '_');
    const w = await P.Filesystem.writeFile({ path: safe, data: b64, directory: 'CACHE' });
    await P.Share.share({ title: safe, url: w.uri, dialogTitle: 'Save or share ' + safe });
  }
  window.SPN_MOBILE = { shareBlob: shareBlob, platform: cap.getPlatform ? cap.getPlatform() : 'android' };

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
          try{ shareBlob(this.output('blob'), name || 'document.pdf'); return this; }
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
            shareBlob(new Blob([ab], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name || 'sheet.xlsx');
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
    try{ const blob = await (await fetch(href)).blob(); shareBlob(blob, a.getAttribute('download') || 'file'); }catch(err){}
  }, true);

  /* external links (maps, APK downloads): Capacitor already opens target="_blank"
     and other-origin links in the system browser, nothing to do here */
})();
