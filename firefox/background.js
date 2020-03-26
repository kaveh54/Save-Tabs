/* globals safe */
'use strict';

const storage = {
  get: prefs => new Promise(resolve => chrome.storage.sync.get(prefs, resolve)),
  set: prefs => new Promise(resolve => chrome.storage.sync.set(prefs, resolve)),
  remove: arr => new Promise(resolve => chrome.storage.sync.remove(arr, resolve))
};

const notify = message => chrome.notifications.create({
  type: 'basic',
  title: chrome.runtime.getManifest().name,
  message,
  iconUrl: 'data/icons/48.png'
});

const write = async (tabs, request, type = 'new') => {
  let json = JSON.stringify(tabs.map(t => {
    let url = t.url;
    if (url.startsWith('chrome-extension://') && url.indexOf(chrome.runtime.id) !== -1) {
      url = (new URLSearchParams(url.split('?')[1])).get('href');
    }
    return {
      url,
      title: t.title,
      active: t.active,
      pinned: t.pinned,
      incognito: t.incognito,
      index: t.index,
      windowId: t.windowId,
      cookieStoreId: t.cookieStoreId
    };
  }));
  if (request.password) {
    json = await safe.encrypt(json, request.password);
  }
  const name = type === 'new' ? 'session.' + request.name : request.session;
  const prefs = await storage.get({
    sessions: [],
    [name]: {}
  });
  if (type === 'new') {
    prefs.sessions.push(name);
  }
  prefs[name] = {
    protected: Boolean(request.password),
    json,
    timestamp: Date.now(),
    tabs: tabs.length,
    permanent: type === 'new' ? request.permanent : prefs[name].permanent
  };
  await storage.set(prefs);
};

chrome.runtime.onMessage.addListener((request, sender, response) => {
  if (request.method === 'store') {
    const props = {
      windowType: 'normal'
    };
    if (request.rule.startsWith('save-window')) {
      props.currentWindow = true;
    }
    if (request.rule.startsWith('save-other-windows')) {
      props.currentWindow = false;
    }
    if (request.pinned === false) {
      props.pinned = false;
    }

    chrome.tabs.query(props, async tabs => {
      if (request.internal !== true) {
        tabs = tabs.filter(
          ({url}) => url &&
            url.startsWith('file://') === false &&
            url.startsWith('chrome://') === false &&
            (
              url.startsWith('chrome-extension://') === false ||
              (url.startsWith('chrome-extension://') && url.indexOf(chrome.runtime.id) !== -1)
            ) &&
            url.startsWith('moz-extension://') === false &&
            url.startsWith('about:') === false
        );
      }
      if (tabs.length === 0) {
        notify('nothing to save');

        return response(false);
      }
      await write(tabs, request);
      if (request.rule === 'save-tabs-close') {
        chrome.tabs.create({
          url: 'about:blank'
        }, () => chrome.tabs.remove(tabs.map(t => t.id)));
      }
      else if (request.rule.endsWith('-close')) {
        chrome.tabs.remove(tabs.map(t => t.id));
      }
      response(true);
    });

    return true;
  }
  else if (request.method === 'update') {
    write(request.tabs, request, 'update');
    response(true);
  }
  else if (request.method === 'restore' || request.method === 'preview') {
    storage.get({
      sessions: [],
      [request.session]: {}
    }).then(async prefs => {
      const session = prefs[request.session];
      try {
        const tabs = JSON.parse(
          session.protected ? await safe.decrypt(session.json, request.password) : session.json
        );
        if (request.method === 'preview') {
          return response(tabs);
        }
        //
        const create = (tab, props) => {
          const discarded = request.discard && tab.active !== true;
          if (/Firefox/.test(navigator.userAgent)) {
            props = {...props, discarded, url: tab.url};
            if (discarded) {
              props.title = tab.title;
            }
            chrome.tabs.create(props);
          }
          else {
            let url = tab.url;
            if (discarded && url.startsWith('http')) {
              url = chrome.runtime.getURL('data/discard/index.html?href=' +
                encodeURIComponent(tab.url)) + '&title=' + encodeURIComponent(tab.title);
            }
            chrome.tabs.create({
              ...props,
              url
            });
          }
        };
        if (request.single) {
          tabs.forEach(t => {
            const props = {
              pinned: t.pinned,
              active: t.active
            };
            if ('cookieStoreId' in t) {
              props.cookieStoreId = t.cookieStoreId;
            }
            create(t, props);
          });
        }
        else {
          const windows = {};
          tabs.forEach(t => {
            windows[t.windowId] = windows[t.windowId] || [];
            windows[t.windowId].push(t);
          });
          // sort
          Object.keys(windows).forEach(id => windows[id].sort((a, b) => a.index - b.index));
          // restore
          for (const id of Object.keys(windows)) {
            chrome.windows.create({
              incognito: windows[id][0].incognito
            }, win => {
              const toberemoved = win.tabs;
              for (const t of windows[id]) {
                const props = {
                  pinned: t.pinned,
                  active: t.active,
                  windowId: win.id,
                  index: t.index
                };
                if ('cookieStoreId' in t) {
                  props.cookieStoreId = t.cookieStoreId;
                }
                create(t, props);
              }
              for (const {id} of toberemoved) {
                chrome.tabs.remove(id);
              }
            });
          }
        }
        if (request.remove && session.permanent !== true) {
          const index = prefs.sessions.indexOf(request.session);
          prefs.sessions.splice(index, 1);
          await storage.set({
            sessions: prefs.sessions
          });
          await storage.remove(request.session);
        }
      }
      catch (e) {
        console.error(e);
        notify('Cannot restore tabs. Wrong password?');
        response(false);
      }
    });

    return request.method === 'restore' ? false : true;
  }
});

// context menu
{
  const onstartup = () => {
    chrome.contextMenus.create({
      title: 'Append JSON sessions',
      id: 'append',
      contexts: ['browser_action']
    });
    chrome.contextMenus.create({
      title: 'Overwrite JSON sessions',
      id: 'overwrite',
      contexts: ['browser_action']
    });
    chrome.contextMenus.create({
      title: 'Export as JSON',
      id: 'export',
      contexts: ['browser_action']
    });
  };
  chrome.runtime.onStartup.addListener(onstartup);
  chrome.runtime.onInstalled.addListener(onstartup);
}
chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId === 'export') {
    storage.get(null).then(prefs => {
      const text = JSON.stringify(prefs, null, '\t');
      const blob = new Blob([text], {type: 'application/json'});
      const objectURL = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), {
        href: objectURL,
        type: 'application/json',
        download: 'save-tabs-sessions.json'
      }).dispatchEvent(new MouseEvent('click'));
      setTimeout(() => URL.revokeObjectURL(objectURL));
    });
  }
  else if (info.menuItemId === 'append' || info.menuItemId === 'overwrite') {
    chrome.windows.create({
      url: 'data/drop/index.html?command=' + info.menuItemId,
      width: 600,
      height: 300,
      left: screen.availLeft + Math.round((screen.availWidth - 600) / 2),
      top: screen.availTop + Math.round((screen.availHeight - 300) / 2),
      type: 'popup'
    });
  }
});

/* FAQs & Feedback */
{
  const {onInstalled, setUninstallURL, getManifest} = chrome.runtime;
  const {name, version} = getManifest();
  const page = getManifest().homepage_url;
  if (navigator.webdriver !== true) {
    onInstalled.addListener(({reason, previousVersion}) => {
      chrome.storage.local.get({
        'faqs': true,
        'last-update': 0
      }, prefs => {
        if (reason === 'install' || (prefs.faqs && reason === 'update')) {
          const doUpdate = (Date.now() - prefs['last-update']) / 1000 / 60 / 60 / 24 > 45;
          if (doUpdate && previousVersion !== version) {
            chrome.tabs.create({
              url: page + '?version=' + version +
                (previousVersion ? '&p=' + previousVersion : '') +
                '&type=' + reason,
              active: reason === 'install'
            });
            chrome.storage.local.set({'last-update': Date.now()});
          }
        }
      });
    });
    setUninstallURL(page + '?rd=feedback&name=' + encodeURIComponent(name) + '&version=' + version);
  }
}
