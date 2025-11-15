// main.js
const { app, BrowserWindow, ipcMain, session, dialog, globalShortcut, shell, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const util = require('util');

// --- 简单文件日志记录器 ---
try {
  const LOG_FILE = path.join(__dirname, 'launcher.log');
  const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf8' });
  const origConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };

  function formatArgs(args) {
    return args.map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 4 }))).join(' ');
  }

  console.log = function (...args) {
    try { logStream.write(new Date().toISOString() + ' [LOG] ' + formatArgs(args) + '\n'); } catch (e) {}
    origConsole.log.apply(console, args);
  };
  console.info = function (...args) {
    try { logStream.write(new Date().toISOString() + ' [INFO] ' + formatArgs(args) + '\n'); } catch (e) {}
    origConsole.info.apply(console, args);
  };
  console.warn = function (...args) {
    try { logStream.write(new Date().toISOString() + ' [WARN] ' + formatArgs(args) + '\n'); } catch (e) {}
    origConsole.warn.apply(console, args);
  };
  console.error = function (...args) {
    try { logStream.write(new Date().toISOString() + ' [ERROR] ' + formatArgs(args) + '\n'); } catch (e) {}
    origConsole.error.apply(console, args);
  };

  process.on('exit', () => {
    try { logStream.end(); } catch (e) {}
  });

  process.on('uncaughtException', (err) => {
    try { logStream.write(new Date().toISOString() + ' [UNCAUGHT] ' + (err && err.stack ? err.stack : String(err)) + '\n'); } catch (e) {}
    try { logStream.end(); } catch (e) {}
  });
} catch (e) {
  // 如果日志初始化失败，不影响主流程
}

const https = require('https');
const pkg = require('./package.json');

// 常用快捷键集合（提升为模块级以便其它逻辑访问/暂时注销）
const COMMON_SHORTCUTS = [
  'Home', 'End', 'Insert', 'Delete', 'PageUp', 'PageDown',
  'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Ctrl+Home', 'Ctrl+End', 'Ctrl+Insert', 'Ctrl+Delete',
  'Alt+Home', 'Alt+End', 'Alt+Insert', 'Alt+Delete'
];
let commonShortcutsPaused = false;

let launcherWin = null;
let quittingApp = false;

const gameWindows = new Map();
const assistWindows = new Map(); // 跟踪辅助窗口

const LEGACY_DIRNAME = 'UserData';
const legacyUserData = path.join(__dirname, LEGACY_DIRNAME);

try { 
  fs.mkdirSync(legacyUserData, { recursive: true }); 
  console.log('Created user data directory:', legacyUserData);
} catch (e) {
  console.error('Failed to create user data directory:', e);
}
app.setName('FlyffU Launcher');
app.setPath('userData', legacyUserData);

const USER_DATA = app.getPath('userData');
const PROFILES_FILE = path.join(USER_DATA, 'profiles.json');
const PENDING_FILE = path.join(USER_DATA, 'pending_deletes.json');
const TRASH_DIR = path.join(USER_DATA, 'Trash');
const SETTINGS_FILE = path.join(USER_DATA, 'settings.json');

// Screenshots dir (Pictures/FlyffU Launcher Screenshots)
const SHOTS_DIR = path.join(app.getPath('pictures'), 'FlyffU Launcher Screenshots');
try { fs.mkdirSync(SHOTS_DIR, { recursive: true }); } catch {}

// Jobs
const JOBS = [
  '守护',
  '暴力',
  '精神',
  '元素',
  '骑士',
  '刀锋',
  '游侠',
  '暗杀'
];
const JOBS_SET = new Set(JOBS);
const DEFAULT_JOB = '守护';
const JOB_OPTIONS_HTML = JOBS.map(j => `<option value="${j}">${j}</option>`).join('');

// ---------- Settings ----------
function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return { stayOpenAfterLaunch: false };
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const json = JSON.parse(raw);
    return {
      stayOpenAfterLaunch: (typeof json.stayOpenAfterLaunch === 'boolean') ? json.stayOpenAfterLaunch : false,
      allowSingleKeyGlobal: (typeof json.allowSingleKeyGlobal === 'boolean') ? json.allowSingleKeyGlobal : false
    };
  } catch {
    return { stayOpenAfterLaunch: false, allowSingleKeyGlobal: false };
  }
}

function writeSettings(s) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
  } catch {}
}
let settings = readSettings();

// Single-instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    ensureLauncher();
    if (launcherWin && !launcherWin.isDestroyed()) {
      if (launcherWin.isMinimized()) launcherWin.restore();
      launcherWin.show();
      launcherWin.focus();
    }
  });
}

// ---------- Profiles storage helpers ----------

/** @typedef {{name:string, job:string, partition:string, frame?:boolean, isClone?:boolean, winState?:{bounds?:{x?:number,y?:number,width:number,height:number}, isMaximized?:boolean}, muted?:boolean}} Profile */

function readRawProfiles() {
  try {
    if (!fs.existsSync(PROFILES_FILE)) return [];
    const raw = fs.readFileSync(PROFILES_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function safeProfileName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 40);
}

// Preferred stable partition generator (sanitized)
function partitionFromName(name) {
  return `persist:profile-${String(name || '').replace(/[^a-z0-9-_ ]/gi, '_')}`;
}

/**
 * Legacy/variant partition resolution helpers
 * NOTE: These are STRICT variants of the SAME name (sanitized/encoded/raw), not "Copy" suffixes.
 */
function partitionCandidatesFromName(name) {
  const raw = String(name || '');
  const sanitized = `profile-${raw.replace(/[^a-z0-9-_ ]/gi, '_')}`;
  const encoded = `profile-${encodeURIComponent(raw)}`;
  const rawDirect = `profile-${raw}`;
  const extras = [];
  if (!sanitized.endsWith('_')) extras.push(sanitized + '_');
  if (!encoded.endsWith('_')) extras.push(encoded + '_');
  if (!rawDirect.endsWith('_')) extras.push(rawDirect + '_');
  const uniq = new Set([sanitized, encoded, rawDirect, ...extras]);
  return Array.from(uniq);
}

function partitionDirExists(dirName) {
  try {
    const p = path.join(USER_DATA, 'Partitions', dirName);
    const st = fs.statSync(p);
    return st && st.isDirectory();
  } catch {
    return false;
  }
}

function resolveLegacyPartition(name) {
  const candidates = partitionCandidatesFromName(name);
  for (const cand of candidates) {
    if (partitionDirExists(cand)) {
      return `persist:${cand}`;
    }
  }
  return undefined;
}

function partitionForProfile(p) {
  if (p && typeof p.partition === 'string' && p.partition) return p.partition;
  const legacy = resolveLegacyPartition(p?.name || '');
  if (legacy) return legacy;
  return partitionFromName(p?.name || '');
}

function inferIsCloneFromName(name) {
  return /\bCopy(?:\s+\d+)?$/i.test(String(name || '').trim());
}

function sanitizeWinState(ws) {
  try {
    if (!ws || typeof ws !== 'object') return undefined;
    const isMaximized = !!ws.isMaximized;
    let bounds;
    if (ws.bounds && typeof ws.bounds === 'object') {
      const b = {
        x: (typeof ws.bounds.x === 'number') ? ws.bounds.x : undefined,
        y: (typeof ws.bounds.y === 'number') ? ws.bounds.y : undefined,
        width: Math.max(200, Number(ws.bounds.width) || 0),
        height: Math.max(200, Number(ws.bounds.height) || 0)
      };
      if (b.width && b.height) bounds = b;
    }
    if (!bounds && !isMaximized) return undefined;
    return { bounds, isMaximized };
  } catch {
    return undefined;
  }
}

function normalizeProfiles(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(Boolean)
    .map(item => {
      if (typeof item === 'string') {
        const name = safeProfileName(item);
        return {
          name,
          job: DEFAULT_JOB,
          partition: partitionForProfile({ name }),
          frame: false,
          isClone: inferIsCloneFromName(name),
          winState: undefined
        };
      }
      const name = safeProfileName(item?.name);
      if (!name) return null;
      const jobRaw = (item?.job || '').trim();
      const job = JOBS_SET.has(jobRaw) ? jobRaw : DEFAULT_JOB;
      const partition = (typeof item?.partition === 'string' && item.partition) ? item.partition : partitionForProfile({ name });
      const frame = !!item?.frame;
      const isClone = (typeof item?.isClone === 'boolean') ? item.isClone : inferIsCloneFromName(name);
      const winState = (item && typeof item.winState === 'object') ? sanitizeWinState(item.winState) : undefined;
      return { name, job, partition, frame, isClone, winState, muted: !!item?.muted };
    })
    .filter(Boolean);
}

/** @returns {Profile[]} */
function readProfiles() {
  return normalizeProfiles(readRawProfiles());
}

function writeProfiles(list) {
  try {
    fs.mkdirSync(path.dirname(PROFILES_FILE), { recursive: true });
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save profiles:', e);
  }
}

function getProfileIndex(list, name) {
  return list.findIndex(p => p.name === name);
}

function getProfileByName(name) {
  const list = readProfiles();
  return list.find(p => p.name === name) || null;
}

function saveProfile(updated) {
  const list = readProfiles();
  const idx = getProfileIndex(list, updated.name);
  if (idx === -1) return false;
  list[idx] = updated;
  writeProfiles(list);
  return true;
}

function patchProfile(name, patch) {
  const list = readProfiles();
  const idx = getProfileIndex(list, name);
  if (idx === -1) return false;
  list[idx] = { ...list[idx], ...patch };
  writeProfiles(list);
  return true;
}

function getActiveProfileNames() {
  const names = [];
  for (const [key, set] of gameWindows.entries()) {
    if (set && set.size > 0) names.push(key);
  }
  return names;
}

function broadcastActiveUpdate() {
  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.webContents.send('profiles:active-updated', getActiveProfileNames());
  }
  updateGlobalShortcut();
}

function ensureLauncher() {
  if (launcherWin && !launcherWin.isDestroyed()) return;
  createLauncher();
}

function toggleLauncherVisibility() {
  ensureLauncher();
  if (!launcherWin) return;

  const shouldShow = !launcherWin.isVisible() || !launcherWin.isFocused();

  if (shouldShow) {
    launcherWin.show();
    launcherWin.focus();
  } else {
    launcherWin.hide();
  }
}

// Inside updateGlobalShortcut(), fully updated with audio sync

// 全局F1键处理函数
function handleGlobalF1KeyPress() {
  try {
    // 获取当前焦点窗口
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (!focusedWindow) return;
    
    // 检查是否是游戏窗口
    let targetProfileName = null;
    for (const [profileName, windowSet] of gameWindows.entries()) {
      if (windowSet && windowSet.has(focusedWindow)) {
        targetProfileName = profileName;
        break;
      }
    }
    
    // 如果没有找到对应的游戏窗口，尝试获取最后一个活动的游戏窗口
    if (!targetProfileName) {
      const allGameWindows = [];
      for (const [profileName, windowSet] of gameWindows.entries()) {
        if (windowSet) {
          for (const win of windowSet) {
            if (win && !win.isDestroyed()) {
              allGameWindows.push({ profileName, win });
            }
          }
        }
      }
      
      if (allGameWindows.length > 0) {
        // 使用最后一个游戏窗口
        targetProfileName = allGameWindows[allGameWindows.length - 1].profileName;
      }
    }
    
    if (targetProfileName) {
      // 查找对应的辅助窗口
      const assistWin = assistWindows.get(targetProfileName);
      if (assistWin && !assistWin.isDestroyed()) {
        // 向辅助窗口发送F1键按下消息
        assistWin.webContents.send('global-f1-pressed');
        console.log('已向辅助窗口发送F1键消息，角色：', targetProfileName);
      }
    }
  } catch (error) {
    console.error('处理全局F1键时出错：', error);
  }
}

// 注册快捷命令快捷键
function registerQuickCommandShortcuts() {
  // 使用模块级 COMMON_SHORTCUTS 列表
  COMMON_SHORTCUTS.forEach(shortcut => {
    const ret = globalShortcut.register(shortcut, () => {
      console.log('快捷命令快捷键被按下：', shortcut);
      
      // 向所有辅助窗口发送快捷键消息
      assistWindows.forEach((assistWin, profileName) => {
        if (assistWin && !assistWin.isDestroyed()) {
          assistWin.webContents.send('quick-command-shortcut', shortcut);
          console.log('已向角色 ' + profileName + ' 发送快捷键消息：', shortcut);
        }
      });
    });
    
    if (ret) {
      console.log('快捷键注册成功：', shortcut);
    } else {
      console.log('快捷键注册失败：', shortcut);
    }
  });
}

function updateGlobalShortcut() {
  globalShortcut.unregister('CommandOrControl+Shift+L');
  globalShortcut.unregister('CommandOrControl+Shift+M');
  globalShortcut.unregister('CommandOrControl+Shift+P');
  globalShortcut.unregister('Control+Tab');
  globalShortcut.unregister('Control+Shift+Tab');
  globalShortcut.unregister('F1');

  if (getActiveProfileNames().length > 0) {
    // Toggle launcher visibility
    globalShortcut.register('CommandOrControl+Shift+L', () => {
      toggleLauncherVisibility();
    });

    // F1键 - 自动添加BUFF
    globalShortcut.register('F1', () => {
      handleGlobalF1KeyPress();
    });
    
    // 快捷命令快捷键
    registerQuickCommandShortcuts();

    // Mute/unmute current session
    globalShortcut.register('CommandOrControl+Shift+M', async () => {
      try {
        let target = BrowserWindow.getFocusedWindow();
        let profileName = null;

        if (target) {
          for (const [name, set] of gameWindows.entries()) {
            if (set && set.has(target)) { profileName = name; break; }
          }
        }

        if (!profileName) {
          const all = [];
          for (const [name, set] of gameWindows.entries()) {
            for (const w of set) all.push({ name, w });
          }
          if (all.length) profileName = all[all.length - 1].name;
        }

        if (profileName) {
          const wins = getAllGameWindowsForProfile(profileName);
          if (!wins.length) return;

          const currentlyMuted = wins.every(w => w.webContents.isAudioMuted());
          const next = !currentlyMuted;
          for (const w of wins) {
            try { w.webContents.setAudioMuted(next); } catch {}
          }

          const msg = next ? 'Session muted.' : 'Session unmuted.';
          for (const w of wins) {
            try { await showToastInWindow(w, msg); } catch {}
          }

          if (launcherWin && !launcherWin.isDestroyed()) {
            launcherWin.webContents.send('profiles:audio-updated', { name: profileName, muted: next });
          }
        }
      } catch (e) {
        console.error('Mute shortcut failed:', e);
      }
    });

    // Screenshot of focused session
    globalShortcut.register('CommandOrControl+Shift+P', async () => {
      try { await captureScreenshotOfFocusedSession(); } catch {}
    });

    // --- Session switching (Ctrl+Tab / Ctrl+Shift+Tab) ---
    function cycleSession(dir = 1) {
      const all = [];
      for (const [, set] of gameWindows.entries()) {
        for (const w of set) {
          if (w && !w.isDestroyed()) all.push(w);
        }
      }
      if (all.length < 2) return;

      const focused = BrowserWindow.getFocusedWindow();

      if (!focused || focused === launcherWin) return;

      const idx = all.findIndex(w => w === focused);
      if (idx === -1) return;

      let nextIdx = (idx + dir + all.length) % all.length;
      const nextWin = all[nextIdx];
      if (nextWin && !nextWin.isDestroyed()) {
        try {
          nextWin.show();
          nextWin.focus();
        } catch (e) {
          console.error('Focus failed:', e);
        }
      }
    }

    globalShortcut.register('Control+Tab', () => cycleSession(1));
    globalShortcut.register('Control+Shift+Tab', () => cycleSession(-1));
  }
}

// 管理每个辅助窗口注册的全局快捷键集合
const profileShortcutRegistrations = new Map();
// 全局加速键 -> 角色->原始快捷键 映射，允许同一加速键为多个角色注册（触发时根据焦点分发）
// Map<accelerator, Map<profileName, rendererShortcutString>>
const acceleratorToProfiles = new Map();
// 暂停期间临时注销的加速键集合
const pausedAccelerators = new Set();

function ensureAcceleratorRegistered(acc) {
  try {
    if (!acceleratorToProfiles.has(acc)) return false;
    if (globalShortcut.isRegistered && globalShortcut.isRegistered(acc)) return true;
    const ok = globalShortcut.register(acc, () => {
      try {
        console.log('globalShortcut fired for', acc);
        const focused = BrowserWindow.getFocusedWindow();
        try { console.log('focused window:', focused ? { id: focused.id, title: (focused.getTitle ? focused.getTitle() : '') } : null); } catch (e) {}
        if (!focused) return;
        const candidates = acceleratorToProfiles.get(acc) || new Map();
        for (const [targetProfile, scForProfile] of candidates.entries()) {
          try {
            const gwSet = gameWindows.get(targetProfile);
            if (gwSet && focused && gwSet.has(focused)) {
              const assistWin = assistWindows.get(targetProfile);
              if (assistWin && !assistWin.isDestroyed()) {
                assistWin.webContents.send('quick-command-shortcut', scForProfile);
                console.log('已触发并转发快捷键', scForProfile, '(acc:', acc + ') 给', targetProfile);
              }
              break;
            }
          } catch (e) { console.error('触发时分发出错', e); }
        }
      } catch (e) { console.error('全局快捷键回调错误', e); }
    });
    if (!ok) console.log('ensureAcceleratorRegistered: register returned false for', acc);
    return ok;
  } catch (e) {
    console.error('ensureAcceleratorRegistered error', acc, e);
    return false;
  }
}

// 在捕获期间，渲染器可请求主进程临时注销会阻塞捕获的单键全局快捷键
ipcMain.on('assist:begin-capture', (event, data) => {
  try {
    // 查找所有已注册的、且不含修饰键的加速键并注销
    for (const acc of acceleratorToProfiles.keys()) {
      try {
        // 如果含 '+' 则视为含修饰键，跳过
        if (String(acc).includes('+')) continue;
        if (globalShortcut.isRegistered && globalShortcut.isRegistered(acc)) {
          try { globalShortcut.unregister(acc); pausedAccelerators.add(acc); console.log('临时注销加速键以便捕获:', acc); } catch (e) { console.error('unregister failed', acc, e); }
        }
      } catch (e) {}
    }
    // 另外也临时注销 COMMON_SHORTCUTS 中的全局注册（因为它们在 registerQuickCommandShortcuts 中直接注册）
    try {
      for (const cs of COMMON_SHORTCUTS) {
        try {
          if (globalShortcut.isRegistered && globalShortcut.isRegistered(cs)) {
            try { globalShortcut.unregister(cs); pausedAccelerators.add(cs); console.log('临时注销 COMMON_SHORTCUT:', cs); commonShortcutsPaused = true; } catch (e) { console.error('unregister COMMON_SHORTCUT failed', cs, e); }
          }
        } catch (e) {}
      }
    } catch (e) { console.error('assist:begin-capture common shortcuts error', e); }
  } catch (e) { console.error('assist:begin-capture error', e); }
});

ipcMain.on('assist:end-capture', (event, data) => {
  try {
    // 恢复之前临时注销的加速键
    for (const acc of Array.from(pausedAccelerators)) {
      try {
        ensureAcceleratorRegistered(acc);
      } catch (e) { console.error('恢复加速键失败', acc, e); }
      pausedAccelerators.delete(acc);
    }
    // 恢复 COMMON_SHORTCUTS
    try {
      if (commonShortcutsPaused) {
        try { registerQuickCommandShortcuts(); } catch (e) { console.error('恢复 COMMON_SHORTCUTS 失败:', e); }
        commonShortcutsPaused = false;
      }
    } catch (e) { console.error('assist:end-capture common shortcuts error', e); }
  } catch (e) { console.error('assist:end-capture error', e); }
});

function unregisterProfileShortcuts(profileName) {
  const set = profileShortcutRegistrations.get(profileName);
  if (!set) return;
  for (const acc of set) {
    try {
      // 从 acceleratorToProfiles 中移除该 profile
      const profiles = acceleratorToProfiles.get(acc);
      if (profiles) {
        profiles.delete(profileName);
        if (profiles.size === 0) {
          // 若没有任何 profile 使用该加速键，注销全局注册并移除映射
          try { globalShortcut.unregister(acc); } catch (e) {}
          acceleratorToProfiles.delete(acc);
        }
      }
    } catch (e) {}
  }
  profileShortcutRegistrations.delete(profileName);
}

// 接收辅助窗口发送的需要注册的快捷键列表，并为其注册全局快捷键（共享注册，触发时按焦点分发）
ipcMain.on('assist:register-quick-shortcuts', (event, data) => {
  const { profileName, shortcuts } = data || {};
  try {
    // 先注销该 profile 先前注册的加速键（会从 acceleratorToProfiles 中移除）
    unregisterProfileShortcuts(profileName);

    const newlyRegisteredAccs = new Set();
    if (Array.isArray(shortcuts)) {
      for (const sc of shortcuts) {
        if (!sc) continue;
        try {
          const acc = String(sc || '')
            .replace(/\bCTRL\b/g, 'Control')
            .replace(/\bALT\b/g, 'Alt')
            .replace(/\bSHIFT\b/g, 'Shift')
            .replace(/\bMETA\b/g, 'CommandOrControl')
            .replace(/\bSPACE\b/g, 'Space')
            .replace(/\bESCAPE\b/g, 'Escape')
            .replace(/\bENTER\b/g, 'Enter')
            .replace(/\bUP\b/g, 'Up')
            .replace(/\bDOWN\b/g, 'Down')
            .replace(/\bLEFT\b/g, 'Left')
            .replace(/\bRIGHT\b/g, 'Right')
            .replace(/\bPAGEUP\b/g, 'PageUp')
            .replace(/\bPAGEDOWN\b/g, 'PageDown');
          // 支持更多键名，包括home、ins、del、end的各种写法
          const accExtended = acc
            .replace(/\bHOME\b/g, 'Home')
            .replace(/\bEND\b/g, 'End')
            .replace(/\bINSERT\b/g, 'Insert')
            .replace(/\bDELETE\b/g, 'Delete')
            .replace(/\bBACKSPACE\b/g, 'Backspace')
            .replace(/\bTAB\b/g, 'Tab')
            // 增加对缩写形式的支持
            .replace(/\bINS\b/g, 'Insert')
            .replace(/\bDEL\b/g, 'Delete');
          const finalAcc = accExtended;

          let profilesForAcc = acceleratorToProfiles.get(finalAcc);
          if (!profilesForAcc) {
            profilesForAcc = new Map();
            acceleratorToProfiles.set(finalAcc, profilesForAcc);

            // Determine if this shortcut contains modifiers (CTRL/ALT/SHIFT/META)
            const hasModifier = /\bCTRL\b|\bALT\b|\bSHIFT\b|\bMETA\b/i.test(sc || '');
            const allowSingle = !!(settings && settings.allowSingleKeyGlobal);
            const shouldRegisterGlobal = hasModifier || allowSingle;

            // 首次为此加速键创建全局注册，回调会根据当前焦点分发到对应角色
            try {
              if (shouldRegisterGlobal) {
                const ok = globalShortcut.register(finalAcc, () => {
                try {
                  console.log('globalShortcut fired for', finalAcc);
                  const focused = BrowserWindow.getFocusedWindow();
                  try { console.log('focused window:', focused ? { id: focused.id, title: (focused.getTitle ? focused.getTitle() : '') } : null); } catch (e) {}
                  if (!focused) return;

                  // 检查游戏窗口内是否有输入焦点（避免打字/聊天被拦截）
                  try {
                    focused.webContents.executeJavaScript(`(function(){
                      try {
                        // 获取当前活动元素
                        const ae = document.activeElement;
                        if (!ae) return false;
                        
                        // 检查是否是常见的输入元素
                        const tag = (ae.tagName || '').toUpperCase();
                        if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
                        
                        // 检查是否是可编辑内容
                        if (ae.isContentEditable) return true;
                        
                        // 检查是否有输入类相关的特征
                        if (ae.hasAttribute('role') && 
                            (ae.getAttribute('role').toLowerCase() === 'textbox' || 
                             ae.getAttribute('role').toLowerCase() === 'combobox')) {
                          return true;
                        }
                        
                        // 检查元素的类名或ID中是否包含与输入相关的关键词
                        const classes = (ae.className || '').toLowerCase();
                        const id = (ae.id || '').toLowerCase();
                        const inputKeywords = ['chat', 'input', 'message', 'text', 'edit', 'textarea'];
                        for (const keyword of inputKeywords) {
                          if (classes.includes(keyword) || id.includes(keyword)) {
                            return true;
                          }
                        }
                        
                        return false;
                      } catch (e) { 
                        console.log('检测输入焦点时出错，但默认视为非输入状态', e);
                        return false;
                      }
                    })()`)
                    .then(isTyping => {
                      if (isTyping) {
                        // 游戏内正在输入，不触发快捷命令
                        console.log('检测到游戏窗口正在输入状态，跳过快捷键触发');
                        return;
                      }

                      // 没有输入焦点，按之前逻辑分发给对应的角色
                      const candidates = acceleratorToProfiles.get(finalAcc) || new Map();
                      for (const [targetProfile, scForProfile] of candidates.entries()) {
                        try {
                          const gwSet = gameWindows.get(targetProfile);
                          if (gwSet && focused && gwSet.has(focused)) {
                            const assistWin = assistWindows.get(targetProfile);
                            if (assistWin && !assistWin.isDestroyed()) {
                              assistWin.webContents.send('quick-command-shortcut', scForProfile);
                              console.log('已触发并转发快捷键', scForProfile, '(acc:', acc + ') 给', targetProfile);
                            }
                            break;
                          }
                        } catch (e) { console.error('触发时分发出错', e); }
                      }
                    }).catch(err => {
                      console.error('检测输入焦点失败，继续分发:', err);
                      const candidates = acceleratorToProfiles.get(finalAcc) || new Map();
                      for (const [targetProfile, scForProfile] of candidates.entries()) {
                        try {
                          const gwSet = gameWindows.get(targetProfile);
                          if (gwSet && focused && gwSet.has(focused)) {
                            const assistWin = assistWindows.get(targetProfile);
                            if (assistWin && !assistWin.isDestroyed()) {
                              assistWin.webContents.send('quick-command-shortcut', scForProfile);
                              console.log('已触发并转发快捷键', scForProfile, '(acc:', acc + ') 给', targetProfile);
                            }
                            break;
                          }
                        } catch (e) { console.error('触发时分发出错', e); }
                      }
                    });
                  } catch (e) {
                    console.error('调用 executeJavaScript 检测输入焦点失败:', e);
                  }
                } catch (e) { console.error('全局快捷键回调错误', e); }
                });

                if (!ok) {
                  console.log('globalShortcut.register 返回 false for', finalAcc);
                }
              } else {
                console.log('跳过全局注册单键加速键（未允许）:', sc, '->', finalAcc);
              }

            } catch (e) {
              console.error('注册全局加速键异常:', finalAcc, e);
            }
          }

          profilesForAcc.set(profileName, sc);
          newlyRegisteredAccs.add(finalAcc);
          console.log('为角色注册加速键映射:', profileName, '<-', sc, '->', finalAcc, ' (global registered:', (hasModifier || !!(settings && settings.allowSingleKeyGlobal)) + ')');
        } catch (e) { console.error('注册快捷键异常', sc, e); }
      }
    }

    if (newlyRegisteredAccs.size) profileShortcutRegistrations.set(profileName, newlyRegisteredAccs);
  } catch (e) {
    console.error('assist:register-quick-shortcuts error', e);
  }
});

// ---------- Partition dir + Retriable delete helpers ----------

function getPartitionDir(partition) {
  const name = String(partition || '').replace(/^persist:/, '');
  return path.join(USER_DATA, 'Partitions', name);
}

function getLegacyPartitionDirsForProfile(p) {
  const name = p?.name || '';
  const cands = partitionCandidatesFromName(name);
  return cands.map(dir => path.join(USER_DATA, 'Partitions', dir));
}

/**
 * Produce a conservative set of folder name candidates that represent the SAME partition
 * string (handles encoded/decoded/underscored + optional trailing underscore variants).
 * We DO NOT derive from display name here to avoid touching other profiles.
 */
function dirBasesFromPartition(partition) {
  const base = String(partition || '').replace(/^persist:/, ''); // e.g. profile-Test_Copy
  const bases = new Set([base]);

  let decoded = base;
  try { decoded = decodeURIComponent(base); } catch {}
  const encoded = encodeURIComponent(decoded);
  bases.add(decoded);
  bases.add(encoded);

  const underscored = decoded.replace(/[^a-z0-9-_ ]/gi, '_');
  bases.add(underscored);

  for (const b of Array.from(bases)) {
    if (!/^profile-/.test(b)) bases.add(`profile-${b}`);
  }

  for (const b of Array.from(bases)) {
    if (!b.endsWith('_')) bases.add(b + '_');
  }

  return Array.from(bases);
}

function readPendingDeletes() {
  try {
    if (!fs.existsSync(PENDING_FILE)) return [];
    const raw = fs.readFileSync(PENDING_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writePendingDeletes(list) {
  try {
    fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
    fs.writeFileSync(PENDING_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write pending deletes:', e);
  }
}

function enqueuePendingDelete(dirPath) {
  const list = readPendingDeletes();
  if (!list.includes(dirPath)) list.push(dirPath);
  writePendingDeletes(list);
}

async function tryRmDirRecursive(dir, attempts = 4, delayMs = 250) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      lastErr = e;
      if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'ENOENT')) {
        await new Promise(r => setTimeout(r, delayMs * Math.pow(2, i)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function safeRemovePartitionDirByPath(dir) {
  try {
    await tryRmDirRecursive(dir);
    return true;
  } catch (e) {
    try {
      await fs.promises.mkdir(TRASH_DIR, { recursive: true }).catch(() => {});
      const base = path.basename(dir);
      const tmp = path.join(TRASH_DIR, `${base}-${Date.now()}`);
      await fs.promises.rename(dir, tmp);
      try {
        await tryRmDirRecursive(tmp);
        return true;
      } catch (e2) {
        enqueuePendingDelete(tmp);
        console.error('Queued for later deletion:', tmp, e2);
        return false;
      }
    } catch (eRename) {
      enqueuePendingDelete(dir);
      console.error('Failed renaming partition dir, queued for later deletion:', dir, eRename);
      return false;
    }
  }
}

async function safeRemovePartitionDir(partition, profileObjForLegacySweep) {
  const primary = getPartitionDir(partition);
  let ok = await safeRemovePartitionDirByPath(primary);

  if (profileObjForLegacySweep) {
    const legacyDirs = getLegacyPartitionDirsForProfile(profileObjForLegacySweep);
    for (const dir of legacyDirs) {
      if (dir === primary) continue;
      try {
        const st = await fs.promises.stat(dir).catch(() => null);
        if (st && st.isDirectory()) {
          const res = await safeRemovePartitionDirByPath(dir);
          ok = ok && res;
        }
      } catch {}
    }
  }

  try {
    const partsRoot = path.join(USER_DATA, 'Partitions');
    const candidates = dirBasesFromPartition(partition);
    for (const base of candidates) {
      const full = path.join(partsRoot, base);
      if (full === primary) continue;
      try {
        const st = await fs.promises.stat(full);
        if (st && st.isDirectory()) {
          const res = await safeRemovePartitionDirByPath(full);
          ok = ok && res;
        }
      } catch {}
    }
  } catch (e) {
    console.error('Partition-variant sweep failed:', e);
  }

  return ok;
}

async function processPendingDeletes() {
  const list = readPendingDeletes();
  if (list.length === 0) return;
  const remain = [];
  for (const p of list) {
    try {
      await tryRmDirRecursive(p);
    } catch {
      remain.push(p);
    }
  }
  writePendingDeletes(remain);
}

// ---------- Update check + News/Tools helpers ----------

function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'FlyffU-Launcher',
        'Accept': 'application/vnd.github+json',
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode || 0, json });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpGetText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'FlyffU-Launcher',
        'Accept': 'text/html,application/xhtml+xml',
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

function normalizeVersion(v) {
  return String(v || '').trim().replace(/^v/i, '');
}

function compareSemver(a, b) {
  const pa = normalizeVersion(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = normalizeVersion(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function fetchLatestReleaseTag() {
  const { status, json } = await httpGetJson('https://api.github.com/repos/toffeegg/FlyffU-Launcher/releases/latest');
  if (status !== 200) throw new Error('GitHub API error: ' + status);
  return normalizeVersion(json.tag_name || json.name || '');
}

// ---------- Screenshots & Audio helpers ----------

function getAllGameWindowsForProfile(name) {
  const set = gameWindows.get(name);
  if (!set) return [];
  return Array.from(set).filter(w => w && !w.isDestroyed());
}

async function captureScreenshotOfFocusedSession() {
  try {
    let target = BrowserWindow.getFocusedWindow();

    let isGame = false;
    if (target) {
      for (const [, set] of gameWindows.entries()) {
        if (set && set.has(target)) { isGame = true; break; }
      }
    }

    if (!isGame) {
      const all = [];
      for (const [, set] of gameWindows.entries()) {
        for (const w of set) all.push(w);
      }
      target = all[all.length - 1];
    }

    if (!target || target.isDestroyed()) return;

    const image = await target.capturePage();
    if (!image || image.isEmpty?.()) {
      try { await showToastInWindow?.(target, 'Screenshot failed (empty image).'); } catch {}
      if (launcherWin && !launcherWin.isDestroyed()) {
        launcherWin.webContents.send('shots:done', { error: 'empty_image' });
      }
      return;
    }

    try { await fs.promises.mkdir(SHOTS_DIR, { recursive: true }); } catch {}

    const ts = new Date();
    const pad = n => String(n).padStart(2, '0');
    const filename = `FlyffU_${ts.getFullYear()}-${pad(ts.getMonth()+1)}-${pad(ts.getDate())}_${pad(ts.getHours())}-${pad(ts.getMinutes())}-${pad(ts.getSeconds())}.png`;
    const out = path.join(SHOTS_DIR, filename);

    const pngBuffer = image.toPNG();
    await fs.promises.writeFile(out, pngBuffer);

    try { await showToastInWindow?.(target, 'Screenshot saved.'); } catch {}

    if (launcherWin && !launcherWin.isDestroyed()) {
      launcherWin.webContents.send('shots:done', { file: out });
    }

    return out;
  } catch (e) {
    console.error('Screenshot failed:', e);
    if (launcherWin && !launcherWin.isDestroyed()) {
      launcherWin.webContents.send('shots:done', { error: String(e && e.message || e) });
    }
  }
}

async function showToastInWindow(win, message = 'Screenshot saved.') {
  if (!win || win.isDestroyed()) return;
  const js = `
    (function(){
      try {
        const id = '__flyffu_toast_styles__';
        if (!document.getElementById(id)) {
          const st = document.createElement('style');
          st.id = id;
          st.textContent = \`
            @keyframes flyffu-toast-in { from {opacity:0; transform: translateY(6px)} to {opacity:1; transform:none} }
            @keyframes flyffu-toast-out { to {opacity:0; transform: translateY(6px)} }
            .flyffu-toast-wrap {
              position: fixed;
              right: 12px;
              bottom: 12px;
              z-index: 2147483647;
              display: flex;
              flex-direction: column;
              gap: 8px;
              pointer-events: none;
            }
            .flyffu-toast {
              background: rgba(15,22,36,.96);
              border: 1px solid #1e2a3e;
              border-left: 3px solid #2c8ae8;
              padding: 10px 14px;
              border-radius: 8px;
              max-width: 150px;
              color: #d6e6ff;
              font: 500 13px/1.3 system-ui, -apple-system, Segoe UI, Roboto, Arial;
              box-shadow: 0 8px 20px rgba(0,0,0,.35);
              animation: flyffu-toast-in .22s ease forwards;
			  margin: 10px 10px -2px 10px;
            }
            .flyffu-toast.hide { animation: flyffu-toast-out .22s ease forwards }
          \`;
          document.head.appendChild(st);
        }
        let wrap = document.querySelector('.flyffu-toast-wrap');
        if (!wrap) {
          wrap = document.createElement('div');
          wrap.className = 'flyffu-toast-wrap';
          document.body.appendChild(wrap);
        }
        const el = document.createElement('div');
        el.className = 'flyffu-toast';
        el.textContent = ${JSON.stringify(message)};
        wrap.appendChild(el);
        setTimeout(() => { el.classList.add('hide'); }, 2200);
        setTimeout(() => { el.remove(); if (wrap && !wrap.children.length) wrap.remove(); }, 2600);
      } catch(e) {}
    })();
  `;
  try { await win.webContents.executeJavaScript(js, true); } catch {}
}

// ---------- UI ----------

function createLauncher() {
  launcherWin = new BrowserWindow({
    width: 1000,
    height: 760,
    resizable: false,
    autoHideMenuBar: true,
    show: false,
    icon: 'icon.png',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });

  launcherWin.on('close', (e) => {
    if (quittingApp) return;
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && focused !== launcherWin) return;

    if (getActiveProfileNames().length > 0) {
      e.preventDefault();
      launcherWin.hide();
    }
  });

  const jobFilterOptions = `<option value="all">所有职业</option>${JOB_OPTIONS_HTML}`;

  const html = `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>FlyffU Launcher</title>
  <style>
    :root{
      --bg:#0b0f16; --panel:#0f1522; --panel-2:#0c1220;
      --line:#1c2533; --text:#e6edf3; --sub:#9aa7bd; --accent:#2563eb; --danger:#b91c1c; --ok:#16a34a;
    }
    *{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial}
    html,body{height:100%}
    body{margin:0;background:var(--bg);color:var(--text);display:flex;flex-direction:column}

    .top{
      display:flex;align-items:center;gap:8px;
      padding:2px 8px 2px 8px;border-bottom:1px solid var(--line);
      position:sticky;top:0;background:var(--bg);z-index:1000
    }
    .menubar{display:flex;align-items:center;gap:8px}
    .menu-item{font-size:12px;color:#d7e2f1;padding:4px 6px;cursor:pointer;user-select:none}
    .menu-item:hover{background:#111829}
    .menu-dropdown{
      position:absolute;
      background:#0f1624;
      padding:6px;
      min-width:180px;
      display:flex;
      flex-direction:column;
      gap:2px;
      border-radius:8px;
      border:1px solid var(--line);
      box-shadow:0 10px 24px rgba(0,0,0,.4);
      opacity:0;
      transform:translateY(-6px) scale(0.98);
      pointer-events:none;
      visibility:hidden;
      transition:
        opacity .15s ease,
        transform .15s ease,
        visibility 0s linear .15s;
    }
    .menu-dropdown.show{
      opacity:1;
      transform:none;
      pointer-events:auto;
      visibility:visible;
      transition:
        opacity .16s ease,
        transform .16s ease,
        visibility 0s;
    }

    .menu-btn {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      text-align: left;
      padding: 8px 14px;
      margin: 2px 0;
      border: none;
      border-radius: 0px;
      background: #0f1624;
      color: #fff;         
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      letter-spacing: .3px;
      transition: transform .1s ease, 
      filter .2s ease, 
      background .2s ease;
    }
    .menu-btn:hover { 
      filter: brightness(1.25);
      border-radius: 6px;
    }
    .menu-sep{height:1px;background:#22304a;margin:4px 6px}
	
    .update-wrap{ margin-left:auto; display:flex; align-items:center; gap:8px }
    .btn.sm{ padding:0px 3px 0px 3px; font-size:10px; border-radius:3px }
    .btn.gold {
    background: linear-gradient(135deg, #d4af37, #b88a1e);
    color: #000;
    font-weight: 700;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    box-sizing: border-box;
    animation: glow 1.5s infinite alternate;
	}
	
	@keyframes glow {
	  from {
	    box-shadow: 0 0 5px 2px #d4af37;
	  }
	  to {
	    box-shadow: 0 0 15px 4px #ffd700;
	  }
	}

	.muted{color:var(--sub);font-size:12px;line-height:1.25;margin-right:5px}

    .wrap{
      flex:1;display:flex;align-items:stretch;justify-content:center;
      padding:0 12px 0 3px
    }

    .content{
      width:min(1000px, 100vw);
      display:grid;
      grid-template-columns: 7fr 3fr;
      gap:12px;
      height:94svh;
    }

    .card { display:flex; flex-direction:column; border-radius:0; background:transparent; min-height:0; }
    .card-h { flex:0 0 auto; padding:1px 0px 10px 0px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:8px }
    .card-h #count { margin-left:auto; }
    .card-c{ flex:1; display:flex; flex-direction:column; padding:1px 12px; min-height:0; }

    .news{ border:1px solid var(--line); margin-top:10px; margin-left:-10px; background:var(--panel-2); border-radius:10px; display:flex; flex-direction:column; min-height:0; overflow:hidden; }
    .news-h{ padding:10px 12px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;flex:0 0 auto }
    .news-title{font-size:14px;font-weight:600}
    .news-c{ padding:10px 12px; display:flex; flex-direction:column; gap:8px; flex:1 1 auto; min-height:0; overflow:auto; }
	.news-c::-webkit-scrollbar{width:8px}
    .news-c::-webkit-scrollbar-thumb{background:#1f2633;border-radius:8px}
    .news-c::-webkit-scrollbar-track{background:transparent}
    .news-item{ padding:9px 10px;border:1px solid #1e2a3e;border-radius:8px;background:#0f1624 }
    .news-item a{color:#8fbaff;text-decoration:none}
    .news-item a:hover{text-decoration:underline}
    .news-item .nt{font-size:13px;font-weight:600;color:#d6e6ff}
    .news-item .ns{font-size:11px;color:#9aa7bd;margin-top:2px}
	.news-item:hover { background: var(--panel-5); }
    .news-empty{ padding:18px;border:1px dashed #263146;border-radius:8px; text-align:center;font-size:13px;color:var(--sub) }

    .btn { border:none; padding:8px 14px; margin:2px 0; border-radius:6px; background:#1b2334; color:#fff; cursor:pointer; font-size:13px; font-weight:500; letter-spacing:.3px; transition: transform .1s ease, filter .2s ease, background .2s ease; }
    .btn:hover { filter: brightness(1.15); }
    .btn:active { transform: scale(.97); }
    .btn.primary { background: linear-gradient(135deg, #2c8ae8, #1f6fc2); color:#fff; box-shadow:0 2px 6px rgba(44, 138, 232, 0.35); }
    .btn.primary:hover { filter: brightness(1.15); box-shadow:0 3px 8px rgba(44, 138, 232, 0.45); }
    .btn.primary:active { transform: scale(.97); box-shadow:0 1px 4px rgba(44, 138, 232, 0.25); }
    .btn.danger { background: linear-gradient(135deg, #c62828, #a91d1d); color:#fff; }
    .btn[disabled] { opacity:.5; cursor:not-allowed; }

    input[type="text"], select {
      width: 100%;
      padding: 8px 12px;
      margin: 2px 0;
      border-radius: 6px;
      border: 1px solid #2a3548;
      background: #151c28;
      color: #e0e3ea;
      font-size: 13px;
      transition: border .2s ease, box-shadow .2s ease;
    }
    input[type="text"]:focus, select:focus {
      border-color: #d4af37;
      box-shadow: 0 0 0 2px rgba(212, 175, 55, .25);
      outline: none;
    }

    .list{ flex:1 1 auto; min-height:0; display:flex; flex-direction:column; gap:8px; overflow:auto; margin-top:8px; scroll-behavior:smooth; padding-right:8px; margin-right:0; }
    .row{ border:1px solid var(--line); background:var(--panel-2); border-radius:8px; padding:10px }
	.row:hover { background: var(--panel-5); }
	.row:hover .name { color: #2c8ae8; }
    .row-top{ display:flex; align-items:center; justify-content:space-between; gap:8px }
    .name { font-weight:600; font-size:15px; color:#e6efff; margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; letter-spacing:.2px; transition: color .2s ease; }
    .row-actions{display:flex;gap:6px}
    .manage{margin-top:8px;border-top:1px dashed var(--line);padding-top:8px;display:none}
    .manage.show{display:block}
    .grid{display:grid;gap:8px}
    .grid.cols-2{grid-template-columns:1fr 1fr}
    .grid.cols-2 > .btn{width:100%}
    .empty{ padding:18px;border:1px dashed #263146;border-radius:8px; text-align:center;margin-top:8px;font-size:13px;color:var(--sub) }
    .create-form{margin-top:8px;display:none}
    .create-form.show{display:block}
    .sec-title{font-size:11px;color:var(--sub);margin:6px 0 2px}
    .tag { display:inline-block; background: rgba(44, 138, 232, 0.08); border: 1px solid rgba(44, 138, 232, 0.35); border-radius:999px; padding:3px 8px; font-size:11px; font-weight:500; color:#9fb5d9; margin-left:6px; line-height:1.3; }
    .toasts{ position:fixed;right:12px;bottom:12px;display:flex;flex-direction:column; gap:8px; z-index:9999 }
    .toast { background:#0f1624; border:1px solid #1e2a3e; border-left:3px solid #2c8ae8; padding:10px 14px; border-radius:8px; min-width:220px; box-shadow:0 8px 20px rgba(0,0,0,.35); opacity:0; transform: translateY(6px); transition: opacity .25s ease, transform .25s ease; }
    .toast.show { opacity:1; transform: translateY(0); }
    .toast .tmsg { font-size:13px; font-weight:500; color:#d6e6ff; letter-spacing:.2px; }
    .drag-handle{cursor:grab;user-select:none;margin-right:6px;font-size:13px;color:#9aa7bd}
    .row.dragging{opacity:.6}
    .drop-indicator{height:6px;border-radius:6px;background:#233046;margin:6px 0;display:none}
    .drop-indicator.show{display:block}

    @media (max-width:880px){ .content{grid-template-columns:1fr} }
    .list::-webkit-scrollbar{width:8px}
    .list::-webkit-scrollbar-thumb{background:#1f2633;border-radius:8px}
    .list::-webkit-scrollbar-track{background:transparent}

    .tips { border:1px solid var(--line); background:var(--panel-2); border-radius:8px; padding:10px; margin-top:12px; font-size:13px; color:var(--sub); }
    .tips-title { font-weight:600; color:var(--text); margin-bottom:6px; }
    .tips-content { margin-bottom:8px; line-height:1.4; }

  </style>

  </head>
  <body>
    <div class="top">
      <div class="menubar">
        <div class="menu-item" id="menuOptions">选项</div>
        <div class="menu-item" id="menuHelp">帮助</div>

        <!-- Options dropdown -->
        <div class="menu-dropdown" id="dropOptions">
          <button class="menu-btn" id="optImport">导入配置文件</button>
          <button class="menu-btn" id="optExport">导出配置文件</button>
          <div class="menu-sep"></div>
          <button class="menu-btn" id="optScreenshots">打开截图文件夹</button>
          <div class="menu-sep"></div>
          <button class="menu-btn" id="optStayOpen">启动后保持打开</button>
        </div>

        <!-- Help dropdown -->
        <div class="menu-dropdown" id="dropHelp">
          <button class="menu-btn" id="helpShortcuts">快捷键</button>
          <button class="menu-btn" id="helpAbout">关于</button>
        </div>
      </div>

      <div class="update-wrap" style="margin-left:auto">
	    <button id="updateBtn" class="btn sm gold" style="display:none"></button>
        <div class="muted" id="versionLink">
          <a href="#" onclick="require('electron').shell.openExternal('https://github.com/toffeegg/FlyffU-Launcher/releases')" style="color:inherit;text-decoration:none;">
            Version ${pkg.version}
          </a>
        </div>
      </div>
    </div>

    <div class="wrap">
      <div class="content">
        <!-- LEFT: Profiles (70%) -->
        <section class="card">
          <div class="card-c">

            <div class="card-h" style="margin-top:10px">
              <button id="createBtn" class="btn primary" style="max-height:34px">创建角色</button>
              <input id="searchInput" type="text" placeholder="搜索角色名称..." style="max-width:240px">
              <select id="jobFilter" style="max-width:180px;height:34px;padding:0 8px;">${jobFilterOptions}</select>
              <span class="muted" id="count">0</span>
            </div>

            <div id="createForm" class="create-form">
              <div class="sec-title">角色名称</div>
              <div class="grid cols-2">
                <input id="createName" type="text" placeholder="角色名称 (例如: 主号, 小号, FWC)">
                <select id="createJob">${JOB_OPTIONS_HTML}</select>
              </div>
              <div class="grid cols-2" style="margin-top:8px">
                <button id="createAdd" class="btn primary">添加</button>
                <button id="createCancel" class="btn">取消</button>
              </div>
            </div>

            <div id="emptyState" class="empty" style="display:none">暂无角色。创建一个角色开始使用。</div>
            <div id="dropAbove" class="drop-indicator"></div>
            <div id="list" class="list"></div>
            <div id="dropBelow" class="drop-indicator"></div>
			
			<div id="tipsBox" class="tips">
			<div class="tips-title">💡 Tip</div>
			<div id="tipsContent" class="tips-content"></div>
			</div>

          </div>
        </section>


      </div>
    </div>

    <div class="toasts" id="toasts"></div>

    <script>
      const { ipcRenderer, shell } = require('electron');
      let profiles = [];
      let manageOpen = null;
      let actives = [];
      let filterText = '';
      let jobFilter = 'all';
      let draggingName = null;
      let audioStates = {};
      let stayOpenAfterLaunch = false;

      const toastsEl = document.getElementById('toasts');
      function showToast(msg) {
        const el = document.createElement('div');
        el.className = 'toast';
        el.innerHTML = '<div class="tmsg"></div>';
        el.querySelector('.tmsg').textContent = msg;
        toastsEl.appendChild(el);
        setTimeout(()=> el.classList.add('show'), 10);
        setTimeout(()=>{
          el.classList.remove('show');
          setTimeout(()=> el.remove(), 200);
        }, 2600);
      }

      async function nativeConfirm(message, detail = '', title = 'Confirm') {
        try {
          const res = await ipcRenderer.invoke('ui:confirm', { message, detail, title });
          return !!(res && res.ok);
        } catch {
          return window.confirm(message);
        }
      }

      function showShortcutsDialog(){
        return ipcRenderer.invoke('ui:shortcuts');
      }

      async function showAssistWindow(profileName) {
        try {
          const res = await ipcRenderer.invoke('ui:assist', profileName);
          if (res && res.ok) {
            console.log('辅助窗口已打开，角色：', profileName);
          } else {
            console.error('打开辅助窗口失败');
          }
        } catch (error) {
          console.error('打开辅助窗口时出错：', error);
        }
      }

      const menuOptions = document.getElementById('menuOptions');
      const menuHelp = document.getElementById('menuHelp');
      const dropOptions = document.getElementById('dropOptions');
      const dropHelp = document.getElementById('dropHelp');

      let menuMode = false;
      let activeMenu = null;

      function positionDropdown(anchorEl, dropdownEl){
        const rect = anchorEl.getBoundingClientRect();
        dropdownEl.style.left = rect.left + 'px';
        dropdownEl.style.top = (rect.bottom + 4) + 'px';
      }

      function closeAllMenus() {
        dropOptions.classList.remove('show');
        dropHelp.classList.remove('show');
        activeMenu = null;
      }

      async function openMenu(key){
        if (key === 'options') {
          positionDropdown(menuOptions, dropOptions);
          dropOptions.classList.add('show');
          dropHelp.classList.remove('show');
          activeMenu = 'options';
        } else if (key === 'help') {
          positionDropdown(menuHelp, dropHelp);
          dropHelp.classList.add('show');
          dropOptions.classList.remove('show');
          activeMenu = 'help';
        }
      }

      document.addEventListener('click', (e) => {
        const withinMenu = e.target.closest('.menu-item') || e.target.closest('.menu-dropdown');
        if (!withinMenu) {
          closeAllMenus();
          menuMode = false;
        }
      });
	  
	  window.addEventListener('blur', () => {
        closeAllMenus();
        menuMode = false;
      });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          closeAllMenus();
          menuMode = false;
        }
      });

      menuOptions.addEventListener('click', () => {
        if (menuMode && activeMenu === 'options') {
          closeAllMenus();
          menuMode = false;
        } else {
          menuMode = true;
          openMenu('options');
        }
      });

      menuHelp.addEventListener('click', () => {
        if (menuMode && activeMenu === 'help') {
          closeAllMenus();
          menuMode = false;
        } else {
          menuMode = true;
          openMenu('help');
        }
      });

      menuOptions.addEventListener('mouseenter', () => { if (menuMode) openMenu('options'); });
      menuHelp.addEventListener('mouseenter', () => { if (menuMode) openMenu('help'); });

      document.getElementById('helpAbout').onclick = async () => {
        closeAllMenus();
        menuMode = false;
        await ipcRenderer.invoke('ui:about');
      };
      document.getElementById('helpShortcuts').onclick = async () => {
        closeAllMenus();
        menuMode = false;
        await showShortcutsDialog();
      };

      document.getElementById('optImport').onclick = async () => {
        closeAllMenus();
        menuMode = false;
        const res = await ipcRenderer.invoke('profiles:import');
        if (res && res.ok) {
          await refresh();
          showToast('配置文件已导入。');
        } else if (res && res.error) {
          alert(res.error);
        }
      };
      document.getElementById('optExport').onclick = async () => {
        closeAllMenus();
        menuMode = false;
        const res = await ipcRenderer.invoke('profiles:export');
        if (res && res.ok) showToast('配置文件已导出。');
        else if (res && res.error) alert(res.error);
      };
      document.getElementById('optScreenshots').onclick = async () => {
        closeAllMenus();
        menuMode = false;
        await ipcRenderer.invoke('shots:open-folder');
      };

      const optStayOpen = document.getElementById('optStayOpen');
      function updateStayOpenLabel() {
        if (optStayOpen) {
          optStayOpen.textContent = stayOpenAfterLaunch
            ? '启动后隐藏启动器'
            : '启动后保持打开';
        }
      }
      (async () => {
        try {
          const s = await ipcRenderer.invoke('settings:get');
          stayOpenAfterLaunch = !!(s && s.stayOpenAfterLaunch);
        } catch { stayOpenAfterLaunch = false; }
        updateStayOpenLabel();
      })();

      optStayOpen.onclick = async() => {
          stayOpenAfterLaunch = !stayOpenAfterLaunch;
          updateStayOpenLabel();
          await ipcRenderer.invoke('settings:update', {
              stayOpenAfterLaunch
          });
          showToast(
              stayOpenAfterLaunch ?
              '启动器将在启动后保持打开。' :
              '启动器将在启动后隐藏。'
          );
          closeAllMenus();
          menuMode = false;
      };

      const updateBtn = document.getElementById('updateBtn');
      (async() => {
          try {
              const res = await ipcRenderer.invoke('app:check-update');
              if (res && res.ok && res.updateAvailable) {
                  updateBtn.style.display = '';
                  updateBtn.textContent = '更新可用 — ' + res.latest;
                  updateBtn.onclick = () => shell.openExternal('https://github.com/toffeegg/FlyffU-Launcher/releases');
                  showToast('新版本 ' + res.latest + ' 可用。');
              }
          } catch {}
      })();

      const createBtn = document.getElementById('createBtn');
      const createForm = document.getElementById('createForm');
      const createName = document.getElementById('createName');
      const createJob = document.getElementById('createJob');
      const createAdd = document.getElementById('createAdd');
      const createCancel = document.getElementById('createCancel');

      const searchInput = document.getElementById('searchInput');
      const jobFilterEl = document.getElementById('jobFilter');

      createBtn.onclick = () => { 
        manageOpen = null;
        document.querySelectorAll('.manage.show').forEach(el => el.classList.remove('show'));
        document.querySelectorAll('.manage-btn').forEach(btn => { btn.textContent = 'Manage'; });
        render();
        createForm.classList.toggle('show'); 
        if (createForm.classList.contains('show')) {
          if (createJob && createJob.options && createJob.options.length) createJob.selectedIndex = 0;
          createName.focus();
        }
      };
      createCancel.onclick = () => {
        createForm.classList.remove('show');
        createName.value = '';
        if (createJob && createJob.options && createJob.options.length) createJob.selectedIndex = 0;
      };

      searchInput.addEventListener('input', () => {
        filterText = (searchInput.value || '').trim().toLowerCase();
        if (manageOpen !== null) manageOpen = null;
        createForm.classList.remove('show');
        render();
      });

      jobFilterEl.addEventListener('change', () => {
        jobFilter = (jobFilterEl.value || 'all').trim();
        if (manageOpen !== null) manageOpen = null;
        createForm.classList.remove('show');
        render();
      });

      function isActive(name){ return actives.includes(name); }
      function anySessionOpen(){ return (actives && actives.length > 0); }

      async function addProfile() {
        const val = (createName.value || '').trim();
        const job = (createJob.value || '').trim();
        if (!val) {
          showToast('请输入角色名称。');
          createName.focus();
          return;
        }
        const res = await ipcRenderer.invoke('profiles:add', { name: val, job });
        if (!res.ok) {
          showToast(res.error || '添加角色失败。');
          createName.focus();
          return;
        }
        createName.value = '';
        if (createJob && createJob.options && createJob.options.length) {
          createJob.selectedIndex = 0;
        }
        createForm.classList.remove('show');
        await refresh();
        showToast('角色已创建');
      }
      createAdd.onclick = addProfile;
      createName.addEventListener('keydown', (e) => { 
        if (e.key === 'Enter') {
          e.preventDefault();
          addProfile();
        }
      });

      const listEl = document.getElementById('list');
      const countEl = document.getElementById('count');
      const emptyEl = document.getElementById('emptyState');
      const dropAbove = document.getElementById('dropAbove');
      const dropBelow = document.getElementById('dropBelow');

      function applyFilters(list){
        const ft = filterText;
        const jf = jobFilter;
        return list.filter(p => {
          const byText = !ft || (p.name || '').toLowerCase().includes(ft);
          const byJob = (jf === 'all') || ((p.job || '').trim() === jf);
          return byText && byJob;
        });
      }

      function setUiBusy(busy) {
        try {
          document.body.style.cursor = busy ? 'progress' : '';
          document.body.style.pointerEvents = busy ? 'none' : '';
        } catch {}
      }

      async function queryAudioState(name){
        try{
          const res = await ipcRenderer.invoke('profiles:audio-state', name);
        if (res && res.ok) audioStates[name] = !!res.muted;
        }catch{}
      }

      function render() {
        const items = applyFilters(profiles);
        countEl.textContent = String(items.length);
        emptyEl.style.display = items.length ? 'none' : '';
        listEl.innerHTML = '';

        items.forEach(p => {
          const name = p.name;

          const row = document.createElement('div');
          row.className = 'row';
          row.setAttribute('draggable', 'true');
          row.dataset.name = name;

          row.addEventListener('dragstart', (e) => {
            draggingName = name;
            row.classList.add('dragging');
            e.dataTransfer.setData('text/plain', name);
            manageOpen = null;
            document.querySelectorAll('.manage.show').forEach(el => el.classList.remove('show'));
            document.querySelectorAll('.manage-btn').forEach(btn => { btn.textContent = 'Manage'; });
          });
          row.addEventListener('dragend', () => {
            draggingName = null;
            row.classList.remove('dragging');
            dropAbove.classList.remove('show');
            dropBelow.classList.remove('show');
          });
          row.addEventListener('dragover', (e) => {
            e.preventDefault();
            const rect = row.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            if (e.clientY < mid) {
              dropAbove.classList.add('show');
              dropBelow.classList.remove('show');
              listEl.insertBefore(dropAbove, row);
            } else {
              dropBelow.classList.add('show');
              dropAbove.classList.remove('show');
              if (row.nextSibling) {
                listEl.insertBefore(dropBelow, row.nextSibling);
              } else {
                listEl.appendChild(dropBelow);
              }
            }
          });
          row.addEventListener('drop', async (e) => {
            e.preventDefault();
            const from = draggingName;
            const to = name;
            if (!from || from === to) return;
            let order = profiles.map(p => p.name);
            const fromIdx = order.indexOf(from);
            order.splice(fromIdx, 1);
            const targetIdx = order.indexOf(to);
            const insertIdx = dropAbove.classList.contains('show') ? targetIdx : targetIdx + 1;
            order.splice(insertIdx, 0, from);
            const res = await ipcRenderer.invoke('profiles:reorder', order);
            if (!res.ok) return alert(res.error || 'Failed to save order.');
            await refresh();
            showToast('Order saved.');
          });

          const top = document.createElement('div');
          top.className = 'row-top';

          const leftWrap = document.createElement('div');
          leftWrap.style.display = 'flex';
          leftWrap.style.alignItems = 'center';
          leftWrap.style.gap = '8px';

          const dragHandle = document.createElement('div');
          dragHandle.className = 'drag-handle';
          dragHandle.textContent = '≡';

          const nm = document.createElement('div');
          nm.className = 'name';
          const job = (p.job || '').trim();
          const jobTag = job ? ' <span class="tag">'+job+'</span>' : '';
          nm.innerHTML = name + jobTag;

          leftWrap.appendChild(dragHandle);
          leftWrap.appendChild(nm);

          const actions = document.createElement('div');
          actions.className = 'row-actions';

          if (isActive(name)) {
            const muteBtn = document.createElement('button');
            muteBtn.className = 'btn';
            muteBtn.textContent = (audioStates[name] ? '取消静音' : '静音');
            muteBtn.onclick = async () => {
              const res = await ipcRenderer.invoke('profiles:toggle-audio', name);
              if (res && res.ok) {
                audioStates[name] = !!res.muted;
                muteBtn.textContent = (audioStates[name] ? '取消静音' : '静音');
                showToast(audioStates[name] ? '会话已静音。' : '会话已取消静音。');
              }
            };
            actions.appendChild(muteBtn);
          }

          const manage = document.createElement('button');
          manage.className = 'btn manage-btn';
          manage.dataset.name = name;
          manage.textContent = (manageOpen === name) ? '关闭' : '管理';
          if (isActive(name)) {
            manage.disabled = true;
          } else {
            manage.onclick = () => {
              createForm.classList.remove('show');
              manageOpen = (manageOpen === name) ? null : name;
              render();
            };
          }
          actions.appendChild(manage);

          // 添加辅助按钮
          const assistBtn = document.createElement('button');
          assistBtn.className = 'btn';
          assistBtn.textContent = '辅助';
          assistBtn.dataset.name = name;
          assistBtn.onclick = () => {
            showAssistWindow(name);
          };
          actions.appendChild(assistBtn);

          if (isActive(name)) {
            const quitBtn = document.createElement('button');
            quitBtn.className = 'btn danger';
            quitBtn.textContent = '退出';
            quitBtn.onclick = async () => {
              await ipcRenderer.invoke('profiles:quit', name);
            };
            actions.appendChild(quitBtn);
          }

          const play = document.createElement('button');
          play.className = 'btn primary';
          if (isActive(name)) {
            play.textContent = '显示';
            play.onclick = async () => {
              await ipcRenderer.invoke('profiles:focus', name);
            };
          } else {
            play.textContent = '启动';
            play.onclick = async () => {
              manageOpen = null;
              createForm.classList.remove('show');
              render();
              await ipcRenderer.invoke('profiles:launch', { name });
            };
          }
          actions.appendChild(play);

          top.appendChild(leftWrap);
          top.appendChild(actions);
          row.appendChild(top);

          const m = document.createElement('div');
          m.className = 'manage' + (manageOpen === name ? ' show' : '');

          const renameWrap = document.createElement('div');
          renameWrap.className = 'grid cols-2';
          const renameInput = document.createElement('input');
          renameInput.type = 'text';
          renameInput.placeholder = '重命名角色';
          renameInput.value = name;
          renameWrap.appendChild(renameInput);

          const jobSel = document.createElement('select');
          jobSel.innerHTML = \`${JOB_OPTIONS_HTML}\`;
          jobSel.value = p.job || '${DEFAULT_JOB}';
          renameWrap.appendChild(jobSel);

          const saveRow = document.createElement('div');
          saveRow.className = 'grid cols-2';
          const saveBtn = document.createElement('button');
          saveBtn.className = 'btn';
          saveBtn.textContent = '保存更改';
          saveBtn.onclick = async () => {
            const newName = (renameInput.value || '').trim();
            const newJob = (jobSel.value || '').trim();
            if (!newName) return alert('请输入有效的名称');
            const res = await ipcRenderer.invoke('profiles:update', { from: name, to: newName, job: newJob });
            if (!res.ok) return alert(res.error || '更新失败。');
            manageOpen = newName;
            await refresh();
            showToast('更改已保存。');
          };

          const frameBtn = document.createElement('button');
          frameBtn.className = 'btn';
          frameBtn.textContent = p.frame ? '禁用窗口边框' : '启用窗口边框';
          frameBtn.onclick = async () => {
            const res = await ipcRenderer.invoke('profiles:update', { from: name, to: name, frame: !p.frame, job: jobSel.value });
            if (!res.ok) return alert(res.error || '更新失败。');
            await refresh();
            showToast('窗口边框' + (!p.frame ? '已启用' : '已禁用') + '。');
          };

          saveRow.appendChild(saveBtn);
          saveRow.appendChild(frameBtn);
          m.appendChild(renameWrap);
          m.appendChild(saveRow);

          const authRow = document.createElement('div');
          authRow.className = 'grid cols-2';

          const clearBtn = document.createElement('button');
          clearBtn.className = 'btn';
          clearBtn.textContent = '清除角色数据';
          clearBtn.onclick = async () => {
            const ok = await nativeConfirm('清除角色"'+name+'"的数据（cookies、缓存文件、存储数据）？');
            if (!ok) return;
            const res = await ipcRenderer.invoke('profiles:clear', name);
            if (!res.ok) alert(res.error || '清除角色数据失败。');
            else showToast('角色数据已清除。');
          };
          authRow.appendChild(clearBtn);

          const resetWinBtn = document.createElement('button');
          resetWinBtn.className = 'btn';
          resetWinBtn.textContent = '重置保存的窗口大小/位置';
          const hasWinState = !!(p.winState && (p.winState.isMaximized || (p.winState.bounds && p.winState.bounds.width && p.winState.bounds.height)));
          resetWinBtn.disabled = !hasWinState;
          resetWinBtn.title = hasWinState ? '' : '暂无保存的窗口大小/位置';
          resetWinBtn.onclick = async () => {
            const ok = await nativeConfirm('重置角色"'+name+'"保存的窗口大小/位置？');
            if (!ok) return;
            const res = await ipcRenderer.invoke('profiles:resetWinState', name);
            if (!res.ok) alert(res.error || '重置失败。');
            else {
              await refresh();
              showToast('保存的窗口大小/位置已重置。');
            }
          };
          authRow.appendChild(resetWinBtn);

          m.appendChild(authRow);

          const dangerWrap = document.createElement('div');
          dangerWrap.className = 'grid cols-2';

          if (p.isClone) {
            const clonedBadge = document.createElement('button');
            clonedBadge.className = 'btn';
            clonedBadge.textContent = '已克隆角色';
            clonedBadge.disabled = true;
            dangerWrap.appendChild(clonedBadge);
          } else {
            const cloneBtn = document.createElement('button');
            cloneBtn.className = 'btn';
            cloneBtn.textContent = '克隆角色';
            cloneBtn.onclick = async () => {
              const res = await ipcRenderer.invoke('profiles:clone', { name });
              if (!res.ok) return alert(res.error || '克隆角色失败。');
              await refresh();
              showToast('角色已克隆。');
            };
            dangerWrap.appendChild(cloneBtn);
          }

          const delBtn = document.createElement('button');
          delBtn.className = 'btn danger';
          delBtn.textContent = '删除角色';
          delBtn.disabled = anySessionOpen();
          delBtn.title = anySessionOpen() ? '关闭所有运行中的会话以删除角色。' : '';
          delBtn.onclick = async () => {
            if (anySessionOpen()) return;
            const ok = await nativeConfirm('删除角色"'+name+'"？这将移除其保存的cookies、缓存文件、存储数据，并完全删除其分区文件夹。启动器将重启以完成删除操作。');
            if (!ok) return;
            setUiBusy(true);
            const res = await ipcRenderer.invoke('profiles:delete', { name, clear: true });
            if (!res.ok) {
              setUiBusy(false);
              return alert(res.error || '删除角色失败。');
            }
            if (!res.restarting) {
              setUiBusy(false);
              await refresh();
              showToast('角色已删除。');
            }
          };
          dangerWrap.appendChild(delBtn);

          m.appendChild(dangerWrap);

          row.appendChild(m);
          listEl.appendChild(row);

          if (isActive(name)) { queryAudioState(name); }
        });
      }

      async function refresh() {
        profiles = await ipcRenderer.invoke('profiles:get');
        actives = await ipcRenderer.invoke('profiles:active');
        render();
      }

      ipcRenderer.on('profiles:updated', refresh);
      ipcRenderer.on('profiles:active-updated', (_e, a) => { actives = a || []; render(); });
      ipcRenderer.on('profiles:audio-updated', (_e, { name, muted }) => {
        audioStates[name] = !!muted;
        render();
      });
      ipcRenderer.on('shots:done', (_e, payload) => {
        if (payload && payload.file) {
          showToast('截图已保存。');
        }
      });

      ipcRenderer.on('app:restarted-cleanup-complete', () => {
        showToast('角色列表已重新加载。');
      });

      refresh();

      // ---------- 提示 ----------
      const tips = [
        "游戏时按 Ctrl+Shift+L 可显示或隐藏启动器并打开另一个角色。",
        "从选项 → 导入/导出配置文件 轻松导入或导出您的角色列表和设置。",
        "按 Ctrl+Shift+P 可截取当前会话的屏幕截图。",
        "从选项 → 打开截图文件夹 访问您的截图。",
        "按 Ctrl+Shift+M 可静音或取消静音当前会话。",
        "拖放重新排序角色，顺序会自动保存。",
        "在搜索栏中输入内容快速筛选角色。",
        "使用职业下拉菜单按角色职业筛选角色。",
        "克隆现有角色可立即复制其设置。",
        "想要更宽的视野？点击管理按钮可为每个角色切换窗口边框。",
        "如有需要，可从管理面板重置保存的窗口大小或位置。",
        "从管理面板安全清除角色数据（cookies、缓存、存储）。",
        "有新版本可用时会显示金色按钮。",
        "按 Ctrl+Tab 或 Ctrl+Shift+Tab 可在活动会话之间循环切换。",
        "要切换到特定活动会话，请按 Ctrl+Shift+L 并点击'显示'。",
        "希望在按下启动后保持启动器可见？在选项 → 启动后保持打开 中切换。"
      ];

      function shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
      }
      
      function initTips() {
        const tipsBox = document.getElementById("tipsBox");
        const tipsContent = document.getElementById("tipsContent");
        if (!tipsBox || !tipsContent) return;
      
        let shuffledTips = shuffle([...tips]);
        let tipIndex = 0;
        let intervalId;
      
        function showTip() {
          tipsContent.textContent = shuffledTips[tipIndex];
          tipIndex = (tipIndex + 1) % shuffledTips.length;
          if (tipIndex === 0) {
            shuffledTips = shuffle([...tips]);
          }
        }
      
        function startRotation() {
          if (!intervalId) {
            intervalId = setInterval(showTip, 8000);
          }
        }
      
        function stopRotation() {
          clearInterval(intervalId);
          intervalId = null;
        }
      
        showTip();
        startRotation();
      
        tipsBox.addEventListener("mouseenter", stopRotation);
        tipsBox.addEventListener("mouseleave", startRotation);
        tipsBox.addEventListener("click", () => {
          stopRotation();
          showTip();
          startRotation();
        });
      }

      window.addEventListener("DOMContentLoaded", initTips);


    </script>
  </body>
  </html>`;

  launcherWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  launcherWin.once('ready-to-show', () => launcherWin.show());
  launcherWin.on('closed', () => { launcherWin = null; });
}

// ---------- Launch Game (with window state restore/save) ----------

function applyWinStateOptionsFromProfile(profile) {
  const ws = sanitizeWinState(profile.winState);
  const opts = {};
  let postCreate = (win) => { try { win.maximize(); } catch {} };

  if (ws && ws.bounds) {
    if (typeof ws.bounds.width === 'number') opts.width = ws.bounds.width;
    if (typeof ws.bounds.height === 'number') opts.height = ws.bounds.height;
    if (typeof ws.bounds.x === 'number') opts.x = ws.bounds.x;
    if (typeof ws.bounds.y === 'number') opts.y = ws.bounds.y;
  }

  if (ws) {
    postCreate = ws.isMaximized
      ? (win) => { try { win.maximize(); } catch {} }
      : (_win) => {};
  }

  return { opts, postCreate };
}

function captureCurrentWinState(win) {
  try {
    const isMaximized = !!win.isMaximized();
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
    if (!bounds || !bounds.width || !bounds.height) return undefined;
    return {
      bounds: {
        x: typeof bounds.x === 'number' ? bounds.x : undefined,
        y: typeof bounds.y === 'number' ? bounds.y : undefined,
        width: Math.max(200, bounds.width),
        height: Math.max(200, bounds.height)
      },
      isMaximized
    };
  } catch {
    return undefined;
  }
}

function saveWindowStateForProfile(profileName, win) {
  const ws = captureCurrentWinState(win);
  if (!ws) return;
  const list = readProfiles();
  const idx = getProfileIndex(list, profileName);
  if (idx === -1) return;
  list[idx].winState = sanitizeWinState(ws);
  writeProfiles(list);
  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.webContents.send('profiles:updated');
  }
}

function exitAppNow() {
  try {
    quittingApp = true;
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.__confirmedClose = true; } catch {}
      try { if (!w.isDestroyed()) w.close(); } catch {}
    }
  } finally {
    app.quit();
  }
}

function launchGameWithProfile(name) {
  const profile = getProfileByName(name);
  if (!profile) return;
  const part = partitionForProfile(profile);
  const url = 'https://universe.flyff.com/';

  const { opts: winStateOpts, postCreate } = applyWinStateOptionsFromProfile(profile);

  const win = new BrowserWindow({
    width: winStateOpts.width || 1200,
    height: winStateOpts.height || 800,
    x: winStateOpts.x,
    y: winStateOpts.y,
    autoHideMenuBar: true,
    show: false,
    frame: !!profile.frame,
    icon: 'icon.png',
    webPreferences: {
      backgroundThrottling: false,
      partition: part,
      nativeWindowOpen: true
    }
  });

  win.__profileName = name;
  
  if (profile.muted) {
    try { win.webContents.setAudioMuted(true); } catch {}
  }

  win.on('close', async(e) => {
    if (win.__confirmedClose) {
        saveWindowStateForProfile(name, win);
        return;
    }

    if (win.__closingPrompt) {
        e.preventDefault();
        return;
    }

    e.preventDefault();
    win.__closingPrompt = true;

    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();

    const res = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['退出会话', '退出 FlyffU 启动器', '取消'],
        defaultId: 0,
        cancelId: 2,
        title: '退出会话',
        message: '退出此游戏会话？',
        detail: '角色: ' + (win.__profileName || name),
        noLink: true,
        normalizeAccessKeys: true
    });

    if (res.response === 0) {
        saveWindowStateForProfile(name, win);
        win.__confirmedClose = true;
        win.close();
        return;
    } else if (res.response === 1) {
        saveWindowStateForProfile(name, win);
        if (getActiveProfileNames().length > 1) {
            const confirm = await dialog.showMessageBox(win, {
                type: 'warning',
                buttons: ['是，全部退出', '取消'],
                defaultId: 0,
                cancelId: 1,
                title: '确认退出',
                message: '仍有多个会话正在运行。',
                detail: '您确定要关闭 FlyffU 启动器和所有正在运行的角色吗？',
                noLink: true,
                normalizeAccessKeys: true
            });
            if (confirm.response !== 0) {
                win.__closingPrompt = false;
                return;
            }
        }
        exitAppNow();
        return;
    }

    win.__closingPrompt = false;
  });

  const debouncedSave = debounce(() => saveWindowStateForProfile(name, win), 300);
  win.on('resize', debouncedSave);
  win.on('move', debouncedSave);
  win.on('maximize', debouncedSave);
  win.on('unmaximize', debouncedSave);

  win.webContents.setWindowOpenHandler(({ url }) => {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: win,
        modal: false,
        autoHideMenuBar: true,
        frame: true,
        width: 1000,
        height: 700,
        webPreferences: {
          partition: part,
          backgroundThrottling: false
        }
      }
    };
  });

  win.on('closed', () => {
    const key = win.__profileName || name;
    const s = gameWindows.get(key);
    if (s) {
      s.delete(win);
      if (s.size === 0) gameWindows.delete(key);
    }

    broadcastActiveUpdate();

    if (!quittingApp && getActiveProfileNames().length === 0) {
      ensureLauncher();
      if (launcherWin && !launcherWin.isDestroyed()) {
        launcherWin.show();
        launcherWin.focus();
      }
    }
  });

  try { postCreate(win); } catch {}

  win.loadURL(url);
  win.once('ready-to-show', () => win.show());

  if (!gameWindows.has(name)) gameWindows.set(name, new Set());
  const set = gameWindows.get(name);
  set.add(win);
  broadcastActiveUpdate();
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Helpers: cookie cloning ----------

async function cloneCookiesBetweenPartitions(srcPartition, dstPartition) {
  try {
    const src = session.fromPartition(srcPartition);
    const dst = session.fromPartition(dstPartition);

    const cookies = await src.cookies.get({});
    const dstExisting = await dst.cookies.get({});
    await Promise.all(
      dstExisting.map(c =>
        dst.cookies.remove(
          `${c.secure ? 'https' : 'http'}://${(c.domain || '').replace(/^\./, '')}${c.path || '/'}`,
          c.name
        ).catch(() => {})
      )
    );

    await Promise.all(
      cookies.map(c => {
        const url = `${c.secure ? 'https' : 'http'}://${(c.domain || '').replace(/^\./, '')}${c.path || '/'}`;
        const payload = {
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expirationDate,
          sameSite: c.sameSite
        };
        return dst.cookies.set(payload).catch(() => {});
      })
    );
  } catch (e) {
    console.error('Cookie clone failed:', e);
  }
}

// ---------- IPC handlers ----------

ipcMain.handle('settings:get', async () => {
  return settings;
});

ipcMain.handle('settings:update', async (_e, patch) => {
  settings = { ...settings, ...patch };
  writeSettings(settings);
  return { ok: true, settings };
});

ipcMain.handle('profiles:get', async () => {
  return readProfiles();
});

ipcMain.handle('profiles:active', async () => {
  return getActiveProfileNames();
});

ipcMain.handle('profiles:add', async (_e, payload) => {
  const list = readProfiles();
  const nameInput = typeof payload === 'string' ? payload : payload?.name;
  const jobInput = typeof payload === 'object' ? (payload?.job || '') : '';

  const name = safeProfileName(nameInput);
  if (!name) return { ok: false, error: '请输入有效的名称。' };
  if (list.some(p => p.name === name)) return { ok: false, error: '名称已存在！' };

  const job = JOBS_SET.has((jobInput || '').trim()) ? (jobInput || '').trim() : DEFAULT_JOB;

  const profile = { name, job, partition: partitionForProfile({ name }), frame: true, isClone: false, winState: undefined };
  writeProfiles([...list, profile]);
  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  return { ok: true };
});

ipcMain.handle('profiles:clone', async (_e, { name }) => {
  const list = readProfiles();
  const src = list.find(p => p.name === name);
  if (!src) return { ok: false, error: '角色未找到' };

  const base = `${src.name} Copy`;
  let newName = base;
  let n = 2;
  while (list.some(p => p.name === newName)) {
    newName = `${base} ${n++}`;
  }

  const targetName = safeProfileName(newName);
  const newPartition = partitionForProfile({ name: targetName });

  const cloned = {
    name: targetName,
    job: src.job || DEFAULT_JOB,
    partition: newPartition,
    frame: !!src.frame,
    isClone: true,
    winState: src.winState ? { ...src.winState } : undefined
  };

  writeProfiles([...list, cloned]);

  try {
    await cloneCookiesBetweenPartitions(partitionForProfile(src), newPartition);
  } catch (e) {
    console.error('Failed to clone profile cookies:', e);
  }

  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  return { ok: true, to: cloned.name };
});

ipcMain.handle('profiles:reorder', async (_e, orderNames) => {
  const list = readProfiles();
  if (!Array.isArray(orderNames) || !orderNames.length) return { ok: false, error: '无效的顺序' };
  const map = new Map(list.map(p => [p.name, p]));
  const next = [];
  for (const nm of orderNames) {
    if (map.has(nm)) {
      next.push(map.get(nm));
      map.delete(nm);
    }
  }
  for (const rest of map.values()) next.push(rest);

  writeProfiles(next);
  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  return { ok: true };
});

ipcMain.handle('profiles:update', async (_e, { from, to, frame, job }) => {
  const list = readProfiles();
  const idx = getProfileIndex(list, from);
  if (idx === -1) return { ok: false, error: '角色未找到' };

  const newName = safeProfileName(to || from);
  if (!newName) return { ok: false, error: '请输入有效的名称' };
  if (newName !== from && list.some(p => p.name === newName)) return { ok: false, error: '目标名称已存在' };

  if (newName !== from && gameWindows.has(from)) {
    const wins = gameWindows.get(from);
    gameWindows.delete(from);
    gameWindows.set(newName, wins);
    if (wins) {
      for (const w of wins) {
        try { w.__profileName = newName; } catch {}
      }
    }
  }

  const oldPartition = list[idx].partition || partitionForProfile(list[idx]);
  const wasClone = typeof list[idx].isClone === 'boolean' ? list[idx].isClone : inferIsCloneFromName(list[idx].name);
  const nextJob = JOBS_SET.has((job || '').trim()) ? (job || '').trim() : (list[idx].job || DEFAULT_JOB);

  list[idx].name = newName;
  list[idx].partition = oldPartition;
  list[idx].frame = (typeof frame === 'boolean') ? frame : !!list[idx].frame;
  list[idx].isClone = wasClone;
  list[idx].job = nextJob;

  writeProfiles(list);

  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  broadcastActiveUpdate();
  return { ok: true };
});

ipcMain.handle('profiles:rename', async (_e, { from, to }) => {
  const list = readProfiles();
  const idx = getProfileIndex(list, from);
  if (idx === -1) return { ok: false, error: 'Profile not found' };

  const newName = safeProfileName(to);
  if (!newName) return { ok: false, error: 'Enter a valid name' };
  if (list.some(p => p.name === newName)) return { ok: false, error: 'Target name already exists' };

  if (gameWindows.has(from)) {
    const wins = gameWindows.get(from);
    gameWindows.delete(from);
    gameWindows.set(newName, wins);
    if (wins) {
      for (const w of wins) {
        try { w.__profileName = newName; } catch {}
      }
    }
  }

  const oldPartition = list[idx].partition || partitionForProfile(list[idx]);
  const wasClone = typeof list[idx].isClone === 'boolean' ? list[idx].isClone : inferIsCloneFromName(list[idx].name);

  list[idx].name = newName;
  list[idx].partition = oldPartition;
  list[idx].isClone = wasClone;

  writeProfiles(list);

  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  broadcastActiveUpdate();
  return { ok: true };
});

ipcMain.handle('profiles:resetWinState', async (_e, name) => {
  const list = readProfiles();
  const idx = getProfileIndex(list, name);
  if (idx === -1) return { ok: false, error: 'Profile not found' };
  list[idx].winState = undefined;
  writeProfiles(list);
  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  return { ok: true };
});

ipcMain.handle('profiles:delete', async (_e, { name, clear }) => {
  const list = readProfiles();
  const p = list.find(x => x.name === name);
  if (!p) return { ok: false, error: 'Profile not found' };
  const part = partitionForProfile(p);

  if (gameWindows.has(name)) {
    for (const w of gameWindows.get(name)) {
      try {
        w.__confirmedClose = true;
        if (!w.isDestroyed()) w.close();
      } catch {}
    }
    gameWindows.delete(name);
  }

  const next = list.filter(x => x.name !== name);
  writeProfiles(next);

  let requiresRestart = false;

  const remainingRefs = next.filter(x => (x.partition || partitionForProfile(x)) === part).length;

  if (clear && remainingRefs === 0) {
    try {
      const s = session.fromPartition(part);
      await s.clearStorageData({
        storages: [
          'cookies',
          'localstorage',
          'filesystem',
          'serviceworkers',
          'cachestorage',
          'indexeddb',
          'websql'
        ]
      });
      if (typeof s.flushStorageData === 'function') {
        try { s.flushStorageData(); } catch {}
      }
      await s.clearCache().catch(() => {});
    } catch (e) {
      console.error('Failed clearing storage for', name, e);
    }

    const primaryDir = getPartitionDir(part);
    enqueuePendingDelete(primaryDir);
    const legacyDirs = getLegacyPartitionDirsForProfile(p);
    for (const dir of legacyDirs) enqueuePendingDelete(dir);

    try {
      const partsRoot = path.join(USER_DATA, 'Partitions');
      for (const base of dirBasesFromPartition(part)) {
        const full = path.join(partsRoot, base);
        enqueuePendingDelete(full);
      }
    } catch (e) {
      console.error('Enqueue partition-variant dirs failed:', e);
    }

    requiresRestart = true;
  }

  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  broadcastActiveUpdate();

  if (requiresRestart) {
    app.relaunch();
    app.exit(0);
    return { ok: true, restarting: true };
  }

  return { ok: true, restarting: false };
});

ipcMain.handle('profiles:clear', async (_e, name) => {
  const p = getProfileByName(name);
  if (!p) return { ok: false, error: '角色未找到' };
  try {
    const s = session.fromPartition(partitionForProfile(p));
    await s.clearStorageData({
      storages: [
        'cookies',
        'localstorage',
        'filesystem',
        'serviceworkers',
        'cachestorage',
        'indexeddb',
        'websql'
      ]
    });
    if (typeof s.flushStorageData === 'function') {
      try { s.flushStorageData(); } catch {}
    }
    await s.clearCache().catch(() => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Failed to clear profile data.' };
  }
});

ipcMain.handle('profiles:launch', async (_e, payload) => {
  const name = (typeof payload === 'string') ? payload : payload?.name;
  const stayOpen = !!settings.stayOpenAfterLaunch;

  launchGameWithProfile(name);

  if (launcherWin && !launcherWin.isDestroyed()) {
    if (!stayOpen) {
      try { launcherWin.hide(); } catch {}
    } else {
      if (launcherWin.isVisible() && !launcherWin.isMinimized()) {
        setTimeout(() => {
          try {
            launcherWin.setAlwaysOnTop(true, 'screen-saver');
            launcherWin.show();
            launcherWin.focus();
            setTimeout(() => { try { launcherWin.setAlwaysOnTop(false); } catch {} }, 300);
          } catch {}
        }, 120);
      }
    }
  }
  return { ok: true };
});

ipcMain.handle('profiles:quit', async (_e, name) => {
  if (gameWindows.has(name)) {
    for (const w of gameWindows.get(name)) {
      try { if (!w.isDestroyed()) w.close(); } catch {}
    }
  }
  return { ok: true };
});

ipcMain.handle('profiles:focus', async (_e, name) => {
  const wins = getAllGameWindowsForProfile(name);
  if (!wins.length) return { ok: false, error: '没有正在运行的会话' };

  const target = wins[0];
  if (target && !target.isDestroyed()) {
    try {
      target.show();
      target.focus();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  return { ok: false, error: 'Window destroyed' };
});

ipcMain.handle('profiles:audio-state', async (_e, name) => {
  const list = readProfiles();
  const idx = getProfileIndex(list, name);
  if (idx === -1) return { ok: false, error: '角色未找到' };

  const wins = getAllGameWindowsForProfile(name);
  if (wins.length === 0) {
    return { ok: true, muted: !!list[idx].muted };
  }

  const anyUnmuted = wins.some(w => !w.webContents.isAudioMuted());
  const muted = !anyUnmuted;

  list[idx].muted = muted;
  writeProfiles(list);

  return { ok: true, muted };
});

ipcMain.handle('profiles:toggle-audio', async (_e, name) => {
  const list = readProfiles();
  const idx = getProfileIndex(list, name);
  if (idx === -1) return { ok: false, error: '角色未找到' };

  const wins = getAllGameWindowsForProfile(name);
  let next;
  if (wins.length === 0) {
    next = !list[idx].muted;
  } else {
    const currentlyMuted = wins.every(w => w.webContents.isAudioMuted());
    next = !currentlyMuted;
    for (const w of wins) {
      try { w.webContents.setAudioMuted(next); } catch {}
    }
  }

  list[idx].muted = next;
  writeProfiles(list);

  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.webContents.send('profiles:audio-updated', { name, muted: next });
  }

  return { ok: true, muted: next };
});

ipcMain.handle('profiles:export', async () => {
  try {
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: '导出配置文件',
      defaultPath: path.join(app.getPath('documents'), 'profiles.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false };
    const data = JSON.stringify(readProfiles(), null, 2);
    fs.writeFileSync(filePath, data, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: '导出失败: ' + (e.message || e) };
  }
});

ipcMain.handle('profiles:import', async () => {
  try {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: '导入配置文件',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false };
    const raw = fs.readFileSync(filePaths[0], 'utf8');
    const arr = JSON.parse(raw);
    const normalized = normalizeProfiles(arr);
    writeProfiles(normalized);
    if (launcherWin) launcherWin.webContents.send('profiles:updated');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: '导入失败: ' + (e.message || e) };
  }
});

ipcMain.handle('shots:open-folder', async () => {
  try {
    await shell.openPath(SHOTS_DIR);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Failed to open folder' };
  }
});

ipcMain.handle('app:check-update', async () => {
  try {
    const latest = await fetchLatestReleaseTag();
    const current = normalizeVersion(pkg.version);
    const updateAvailable = compareSemver(latest, current) === 1;
    return { ok: true, latest, current, updateAvailable };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});





ipcMain.handle('app:quit', () => {
  quittingApp = true;
  exitAppNow();
});

ipcMain.handle('ui:confirm', async (_e, { message, detail, title, yesLabel, noLabel }) => {
  const parent = (launcherWin && !launcherWin.isDestroyed()) ? launcherWin : BrowserWindow.getFocusedWindow();
  const buttons = [yesLabel || '是', noLabel || '否'];
  const res = await dialog.showMessageBox(parent, {
    type: 'question',
    buttons,
    defaultId: 0,
    cancelId: 1,
    title: title || '确认',
    message: String(message || '您确定吗？'),
    detail: detail ? String(detail) : undefined,
    normalizeAccessKeys: true,
    noLink: true
  });
  return { ok: res.response === 0 };
});

ipcMain.handle('ui:alert', async (_e, { message, title }) => {
  const parent = (launcherWin && !launcherWin.isDestroyed()) ? launcherWin : BrowserWindow.getFocusedWindow();
  await dialog.showMessageBox(parent, {
    type: 'info',
    buttons: ['确定'],
    defaultId: 0,
    title: title || '信息',
    message: String(message || '')
  });
  return { ok: true };
});

ipcMain.handle('ui:about', async () => {
  const parent = (launcherWin && !launcherWin.isDestroyed())
    ? launcherWin
    : BrowserWindow.getFocusedWindow();

  const iconPath = path.join(__dirname, 'icon.png');
  const iconDataUrl = nativeImage.createFromPath(iconPath)
    .resize({ width: 40, height: 40 })
    .toDataURL();

  const aboutWin = new BrowserWindow({
    parent,
    modal: true,
    width: 400,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    show: false,
    icon: iconPath,
    backgroundColor: '#0b0f16',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });

  const html = `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>关于</title>
    <style>
      :root{ --bg:#0b0f16; --text:#e6edf3; --sub:#9aa7bd; }
      *{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial}
      html,body{height:100%}
      body{margin:0;background:var(--bg);color:var(--text);display:flex;align-items:center;justify-content:center}
      .wrap{width:min(92vw,440px);padding:8px 6px}
      .head{display:flex;align-items:center;gap:12px;margin-bottom:10px}
      .head img{width:40px;height:40px;border-radius:10px}
      .title{font-size:18px;font-weight:800;letter-spacing:.2px}
      .sub{font-size:12px;color:var(--sub)}
	  .abt{font-size:12px;justify-content:center;align-items:center}
      .row{font-size:13px;margin:6px 2px;letter-spacing:.2px;display:flex;justify-content:center;align-items:center;gap:14px;flex-wrap:wrap;}.row a{color:#9ab4ff;text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1px;}.row a:hover{filter:brightness(1.15);}
      a{color:#8fbaff;text-decoration:none}
      a:hover{text-decoration:underline}
    </style>
  </head>
  
  <body>
    <div class="wrap">
      <div class="head">
        <img src="${iconDataUrl}" alt="icon">
        <div>
          <div class="title">FlyffU 启动器 v${pkg.version}</div>
          <div class="sub">由 Toffee 开发的 Flyff Universe 多角色启动器</div>
        </div>
      </div>
	  
	  <div class="abt">
	  FlyffU 启动器是一个开源的 Flyff Universe 多角色启动器，由 Toffee 和社区贡献者共同开发。
	  <br/><br/>
	  FlyffU 启动器包含隔离的角色配置、即时截图、简化的会话控制和内置新闻面板。轻松运行多个会话，保存窗口布局并整齐组织角色，提供更流畅、更专注的游戏体验。
	  </div>
	  
	  <br/>
	  
      <div class="row">
        <a href="#" data-link="https://discord.gg/DNyvbaPqyt">Discord</a>
        <a href="#" data-link="https://github.com/toffeegg/FlyffU-Launcher">GitHub</a>
		<a href="#" data-link="https://github.com/toffeegg/FlyffU-Launcher/blob/main/privacy-policy.md">隐私政策</a>
		<a href="#" data-link="https://github.com/toffeegg/FlyffU-Launcher/blob/main/LICENSE">许可证</a>
      </div>
	</div>
	
    <script>
      const { shell } = require('electron');
      document.querySelectorAll('a[data-link]').forEach(a=>{
        a.addEventListener('click', (e) => {
          e.preventDefault();
          shell.openExternal(a.getAttribute('data-link'));
        });
      });
      window.addEventListener('keydown', (e)=>{ if(e.key==='Escape') window.close(); });
    </script>
  </body>
  </html>`.trim();

  aboutWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  aboutWin.once('ready-to-show', () => aboutWin.show());
  return { ok: true };
});

ipcMain.handle('ui:shortcuts', async () => {
  const parent = (launcherWin && !launcherWin.isDestroyed())
    ? launcherWin
    : BrowserWindow.getFocusedWindow();
	
  const iconPath = path.join(__dirname, 'icon.png');
  const iconDataUrl = nativeImage.createFromPath(iconPath)
    .resize({ width: 40, height: 40 })
    .toDataURL();	

  const win = new BrowserWindow({
    parent,
    modal: true,
    width: 500,
    height: 400,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    show: false,
    icon: iconPath,	
    backgroundColor: '#0b0f16',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });

  const html = `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>快捷键</title>
    <style>
      :root{ --bg:#0b0f16; --text:#e6edf3; --sub:#9aa7bd; --line:#1c2533; }
      *{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial}
      html,body{height:100%}
      body{margin:0;background:var(--bg);color:var(--text);display:flex;align-items:center;justify-content:center}
      .wrap{width:min(92vw,460px);padding:12px}
      .list{display:flex;flex-direction:column;gap:8px}
      .item{display:flex;align-items:center;justify-content:space-between;background:#0f1624;border:1px solid #1e2a3e;border-radius:8px;padding:10px 12px}
      .label{font-size:13px;color:#d6e6ff}
      .kbd{font:600 12px/1.2 ui-monospace,SFMono-Regular,Consolas,Monaco,monospace;background:#0b1220;border:1px solid #1e2a3e;border-bottom-width:2px;padding:6px 8px;border-radius:6px}
      a{color:#8fbaff;text-decoration:none}
      a:hover{text-decoration:underline}
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="list">
        <div class="item"><div class="label">切换启动器</div><div class="kbd">Ctrl + Shift + L</div></div>
		<div class="item"><div class="label">静音/取消静音当前会话</div><div class="kbd">Ctrl + Shift + M</div></div>
        <div class="item"><div class="label">截取当前会话截图</div><div class="kbd">Ctrl + Shift + P</div></div>
		<div class="item"><div class="label">向前切换活动会话</div><div class="kbd">Ctrl + Tab</div></div>
		<div class="item"><div class="label">向后切换活动会话</div><div class="kbd">Ctrl + Shift + Tab</div></div>
      </div>
    </div>
    <script>
      window.addEventListener('keydown', (e)=>{ if(e.key==='Escape') window.close(); });
    </script>
  </body>
  </html>`.trim();

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.once('ready-to-show', () => win.show());
  return { ok: true };
});

// 辅助窗口处理函数
ipcMain.handle('ui:assist', async (event, profileName) => {
  const parent = (launcherWin && !launcherWin.isDestroyed())
    ? launcherWin
    : BrowserWindow.getFocusedWindow();

  const iconPath = path.join(__dirname, 'icon.png');
  const iconDataUrl = nativeImage.createFromPath(iconPath)
    .resize({ width: 40, height: 40 })
    .toDataURL();

  // 为每个角色创建唯一的窗口标题，避免窗口重叠
  const windowTitle = `角色辅助工具 - ${profileName}`;
  
  // 检查是否已存在该角色的辅助窗口
  if (assistWindows.has(profileName)) {
    const existingWin = assistWindows.get(profileName);
    if (!existingWin.isDestroyed()) {
      // 如果窗口已存在，则聚焦到该窗口
      if (existingWin.isMinimized()) existingWin.restore();
      existingWin.focus();
      return { ok: true, profileName, action: 'focused' };
    } else {
      // 如果窗口已销毁，则从Map中移除
      assistWindows.delete(profileName);
    }
  }
  
  const assistWin = new BrowserWindow({
    modal: false, // 改为非模态窗口，允许主窗口操作
    width: 600,
    height: 400,
    resizable: true,
    minimizable: true,
    maximizable: true,
    autoHideMenuBar: true,
    show: false,
    icon: iconPath,
    backgroundColor: '#0b0f16',
    title: windowTitle,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });

  const html = `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>${windowTitle}</title>
    <style>
      :root{ --bg:#0b0f16; --text:#e6edf3; --sub:#9aa7bd; --line:#1c2533; --panel:#0f1624; }
      *{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial}
      html,body{height:100%;margin:0;padding:0}
      body{background:var(--bg);color:var(--text);display:flex;flex-direction:column}
      
      .header{
        background:var(--panel);
        border-bottom:1px solid var(--line);
        padding:16px 20px;
        display:flex;
        align-items:center;
        gap:12px
      }
      .header-icon{
        width:32px;
        height:32px;
        border-radius:8px
      }
      .header-title{
        font-size:18px;
        font-weight:600;
        color:#e6efff
      }
      .header-subtitle{
        font-size:13px;
        color:var(--sub);
        margin-left:auto
      }
      
      .content{
        flex:1;
        padding:20px;
        display:flex;
        flex-direction:column;
        gap:16px;
        overflow-y:auto
      }
      
      .section{
        background:var(--panel);
        border:1px solid var(--line);
        border-radius:8px;
        padding:16px
      }
      .section-title{
        font-size:14px;
        font-weight:600;
        color:#d6e6ff;
        margin-bottom:8px
      }
      .section-content{
        font-size:13px;
        color:var(--sub);
        line-height:1.5
      }
      
      .placeholder{
        text-align:center;
        padding:40px 20px;
        color:var(--sub);
        font-size:14px
      }
      
      .footer{
        background:var(--panel);
        border-top:1px solid var(--line);
        padding:12px 20px;
        text-align:center;
        font-size:12px;
        color:var(--sub)
      }
      
      /* 测试按钮样式 */
      .test-btn{
        background:linear-gradient(135deg, #3a7bd5, #00d2ff);
        color:white;
        border:none;
        border-radius:6px;
        padding:10px 16px;
        font-size:14px;
        font-weight:500;
        cursor:pointer;
        transition:all 0.2s ease;
        box-shadow:0 2px 8px rgba(58,123,213,0.3);
      }
      .test-btn:hover{
        background:linear-gradient(135deg, #2d5fa3, #00b8e6);
        transform:translateY(-1px);
        box-shadow:0 4px 12px rgba(58,123,213,0.4);
      }
      .test-btn:active{
        transform:translateY(0);
        box-shadow:0 2px 6px rgba(58,123,213,0.3);
      }
      
      .test-result{
        margin-top:8px;
        padding:8px 12px;
        background:var(--panel);
        border:1px solid var(--line);
        border-radius:4px;
        font-size:13px;
        color:var(--sub);
        min-height:20px;
      }
      
      /* BUFF配置样式 */
      .config-row{
        display:flex;
        align-items:center;
        gap:10px;
        margin-bottom:12px;
      }
      
      .config-row label{
        min-width:120px;
        font-size:13px;
        color:var(--text);
      }
      
      .config-input{
        padding:6px 8px;
        background:var(--panel);
        border:1px solid var(--line);
        border-radius:4px;
        color:var(--text);
        font-size:13px;
        width:120px;
      }
      
      .config-input:focus{
        outline:none;
        border-color:#2563eb;
      }
      
      .config-hint{
        font-size:12px;
        color:var(--sub);
      }
      
      .config-btn{
        padding:8px 16px;
        background:var(--panel);
        border:1px solid var(--line);
        border-radius:4px;
        color:var(--text);
        font-size:13px;
        cursor:pointer;
        transition:all 0.2s;
      }
      
      .config-btn:hover{
        background:#111829;
      }
      
      .config-btn.primary{
        background:linear-gradient(135deg, #2563eb, #1d4ed8);
        border-color:#2563eb;
        color:white;
      }
      
      .config-btn.primary:hover{
        background:linear-gradient(135deg, #1d4ed8, #1e40af);
      }
      
      .status-display{
        margin-top:8px;
        padding:8px 12px;
        background:var(--panel);
        border:1px solid var(--line);
        border-radius:4px;
        font-size:13px;
        color:var(--sub);
        min-height:20px;
      }
      
      /* 滚动条样式 */
      ::-webkit-scrollbar{width:8px}
      ::-webkit-scrollbar-thumb{background:#1f2633;border-radius:8px}
      ::-webkit-scrollbar-track{background:transparent}
      
      /* 快捷命令列表样式 */
      .commands-table-container {
        width: 100%;
        overflow-x: auto;
      }
      
      .commands-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
        margin-bottom: 16px;
      }
      
      .commands-table th,
      .commands-table td {
        padding: 8px 12px;
        text-align: left;
        border-bottom: 1px solid var(--line);
      }
      
      .commands-table th {
        background: var(--panel);
        color: #d6e6ff;
        font-weight: 600;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      
      .commands-table td {
        color: var(--sub);
        vertical-align: middle;
      }
      
      .command-name {
        font-weight: 500;
        color: var(--text);
      }
      
      .command-action {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      
      .play-pause-btn {
        width: 24px;
        height: 24px;
        border: none;
        border-radius: 4px;
        background: linear-gradient(135deg, #2563eb, #1d4ed8);
        color: white;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        transition: all 0.2s ease;
      }
      
      .play-pause-btn:hover {
        background: linear-gradient(135deg, #1d4ed8, #1e40af);
        transform: scale(1.05);
      }
      
      .play-pause-btn.running {
        background: linear-gradient(135deg, #dc2626, #b91c1c);
      }
      
      .delete-btn {
        width: 24px;
        height: 24px;
        border: none;
        border-radius: 4px;
        background: #374151;
        color: #ef4444;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        transition: all 0.2s ease;
      }
      
      .delete-btn:hover {
        background: #ef4444;
        color: white;
      }
      
      .add-command-container {
        display: flex;
        justify-content: center;
        margin-top: 16px;
      }
      
      .add-command-btn {
        padding: 8px 16px;
        background: linear-gradient(135deg, #10b981, #059669);
        border: none;
        border-radius: 6px;
        color: white;
        font-size: 13px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: all 0.2s ease;
      }
      
      .add-command-btn:hover {
        background: linear-gradient(135deg, #059669, #047857);
        transform: translateY(-1px);
      }
      
      .add-icon {
        font-size: 16px;
        font-weight: bold;
      }
      
      .command-input {
        padding: 4px 8px;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 4px;
        color: var(--text);
        font-size: 13px;
        width: 100%;
      }
      
      .command-input:focus {
        outline: none;
        border-color: #2563eb;
      }
      
      .status-indicator {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-right: 6px;
      }
      
      .status-running {
        background: #10b981;
        animation: pulse 1.5s infinite;
      }
      
      .status-stopped {
        background: #6b7280;
      }
      
      @keyframes pulse {
        0% { opacity: 1; }
        50% { opacity: 0.5; }
        100% { opacity: 1; }
      }
    </style>
  </head>
  
  <body>
    <div class="header">
      <img src="${iconDataUrl}" alt="icon" class="header-icon">
      <div class="header-title">角色辅助工具</div>
      <div class="header-subtitle">${profileName}</div>
    </div>
    
    <div class="content">
      <div class="section">
        <div class="section-title">角色信息</div>
        <div class="section-content">
          当前角色：<strong>${profileName}</strong><br>
          辅助功能开发中...
        </div>
      </div>
      
      <div class="section">
        <div class="section-title">快捷命令列表</div>
        <div class="section-content">
          <div class="commands-table-container">
            <table class="commands-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>命令</th>
                  <th>快捷键</th>
                  <th>间隔(ms)</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody id="commandsList">
                <!-- 命令列表将动态生成 -->
              </tbody>
            </table>
            
            <div class="add-command-container">
              <button id="addCommandBtn" class="add-command-btn">
                <span class="add-icon">+</span> 增加一个命令
              </button>
            </div>
          </div>
        </div>
      </div>
      
      <div class="section" style="display: none;">
        <div class="section-title">按键测试</div>
        <div class="section-content">
          <button id="testKeyBtn" class="test-btn">测试 ALT+1 组合键</button>
          <div class="test-result" id="testResult"></div>
        </div>
      </div>
      
      <div class="section">
        <div class="section-title">BUFF自动添加配置</div>
        <div class="section-content">
          <div class="config-row">
            <label for="buffInterval">BUFF间隔(毫秒)：</label>
            <input type="number" id="buffInterval" class="config-input" placeholder="必须填写，如：500" min="100" max="5000">
            <span class="config-hint">* 必填，控制技能释放间隔</span>
          </div>
          <div class="config-row">
            <label for="buffCount">BUFF数量：</label>
            <input type="number" id="buffCount" class="config-input" value="12" min="1" max="20">
            <span class="config-hint">默认12，最大20</span>
          </div>
          
          <!-- 使用说明 - 移动到配置区域 -->
          <div class="config-row" style="margin-top: 15px; padding: 12px; background: linear-gradient(135deg, #2a2a2a 0%, #1a1a1a 100%); border-radius: 8px; border-left: 4px solid #00d2ff;">
            <div style="font-size: 14px; line-height: 1.5; color: #ffffff;">
              <strong style="color: #00ff88; font-size: 15px;">📋 使用说明</strong><br>
              <span style="color: #ffaa00;">请先把BUFF放到ALT+0到9和CTRL+0到9上，设置好BUFF数量和间隔后，再按下F1</span><br><br>
            </div>
          </div>
          
          <div class="config-row">
            <button id="startBuffBtn" class="config-btn primary" style="display: none;">开始添加BUFF (F1)</button>

          </div>
        </div>
      </div>
      
      <div class="placeholder">
        更多功能正在开发中...
      </div>
    </div>
    
    <div class="footer">
      FlyffU 启动器辅助工具 - 当前角色：${profileName}
    </div>
    
    <script>
      const { ipcRenderer } = require('electron');
      
      // 确保profileName在全局作用域可用
      const profileName = '${profileName}';

      // Safe storage helpers: try localStorage, fall back to in-memory object when localStorage is unavailable (data: URL 禁用存储)
      function safeGetItem(key) {
        try {
          return localStorage.getItem(key);
        } catch (e) {
          console.warn('localStorage.getItem failed, using in-memory fallback for', key, e && e.message);
          window.__storageFallback = window.__storageFallback || {};
          return window.__storageFallback[key] || null;
        }
      }

      function safeSetItem(key, value) {
        try {
          localStorage.setItem(key, value);
        } catch (e) {
          console.warn('localStorage.setItem failed, using in-memory fallback for', key, e && e.message);
          window.__storageFallback = window.__storageFallback || {};
          window.__storageFallback[key] = value;
        }
      }
      
      // BUFF自动添加状态管理
      let isBuffing = false;
      let buffTimer = null;
      let currentBuffIndex = 0;
      let buffConfig = {
        interval: null,
        count: 12
      };
      
      // 快捷命令列表状态管理（使用全局 window.commands 以避免本地/全局数组不一致）
      if (!window.commands) window.commands = [];
      let commandTimers = {};
      let commandStates = {};
      
      // 快捷命令数据结构
      class QuickCommand {
        constructor(id, name, command, shortcut, interval) {
          this.id = id;
          this.name = name;
          this.command = command;
          this.shortcut = shortcut;
          this.interval = interval;
          this.isRunning = false;
        }
      }
      
      // 按键组合定义 - 严格按照指定顺序：ALT+1到ALT+9，ALT+0，然后CTRL+1到CTRL+9，CTRL+0
      const buffKeyCombos = [
        'ALT+1', 'ALT+2', 'ALT+3', 'ALT+4', 'ALT+5', 'ALT+6', 'ALT+7', 'ALT+8', 'ALT+9', 'ALT+0',
        'CTRL+1', 'CTRL+2', 'CTRL+3', 'CTRL+4', 'CTRL+5', 'CTRL+6', 'CTRL+7', 'CTRL+8', 'CTRL+9', 'CTRL+0'
      ];
      
      window.addEventListener('keydown', (e)=>{
        if(e.key==='Escape') window.close();
        
        // F1键监听 - 开始/中断BUFF添加
        if(e.key === 'F1') {
          e.preventDefault();
          handleF1KeyPress();
        }
      });
      
      // 窗口加载完成后的初始化
      window.addEventListener('load', () => {
        console.log('辅助窗口已加载，角色：' + profileName);
        
        // 获取按钮和结果显示元素
        const testBtn = document.getElementById('testKeyBtn');
        const testResult = document.getElementById('testResult');
        const startBuffBtn = document.getElementById('startBuffBtn');
        const buffIntervalInput = document.getElementById('buffInterval');
        const buffCountInput = document.getElementById('buffCount');
        const buffStatus = document.getElementById('buffStatus');
        
        // 快捷命令相关元素
        const commandsList = document.getElementById('commandsList');
        const addCommandBtn = document.getElementById('addCommandBtn');
        console.log('辅助窗口元素检测: commandsList=', !!commandsList, ' addCommandBtn=', !!addCommandBtn);
        
        // 监听全局F1键消息
        ipcRenderer.on('global-f1-pressed', () => {
          console.log('收到全局F1键消息，角色：' + profileName);
          handleF1KeyPress();
        });
        
        // 监听快捷命令快捷键消息
        ipcRenderer.on('quick-command-shortcut', (event, shortcut) => {
          console.log('收到快捷命令快捷键消息：', shortcut);
          handleQuickCommandShortcut(shortcut);
        });
        
        // 加载保存的配置
        loadSavedConfig();
        
        // 加载快捷命令列表
        loadCommands();
        // 向主进程报告当前已绑定的快捷键，方便主进程统一注册全局快捷键
        try {
          if (typeof ipcRenderer !== 'undefined' && ipcRenderer && ipcRenderer.send) {
            const scs = (window.commands || []).map(c => c.shortcut).filter(Boolean);
            ipcRenderer.send('assist:register-quick-shortcuts', { profileName: profileName, shortcuts: scs });
          }
        } catch (e) {
          console.error('向主进程发送已绑定快捷键列表失败：', e);
        }
        
        // 测试按钮点击事件
        testBtn.addEventListener('click', () => {
          // 发送ALT+1组合键测试请求
          ipcRenderer.send('assist:send-key-combo', {
            profileName: profileName,
            keyCombo: 'ALT+1'
          });
          console.log('发送测试按键：ALT+1 到角色：', profileName);
          
          // 显示发送状态
          testResult.textContent = '正在向游戏窗口发送 ALT+1 组合键...';
          testResult.style.color = '#00d2ff';
          
          // 2秒后清除状态
          setTimeout(() => {
            testResult.textContent = 'ALT+1 组合键已发送完成';
            testResult.style.color = '#00ff88';
          }, 2000);
        });
        
        // 开始添加BUFF按钮点击事件
        startBuffBtn.addEventListener('click', () => {
          handleF1KeyPress();
        });
        
        // 添加快捷命令按钮点击事件
          if (addCommandBtn) {
          console.log('绑定添加命令按钮事件');
          // 修复：使用标准函数形式绑定事件，避免箭头函数可能的作用域问题
          addCommandBtn.addEventListener('click', function() {
            console.log('点击了添加命令按钮 - 事件触发');
            try {
              console.log('当前 window.commands 长度(点击前):', (window.commands || []).length);
              addNewCommand();
              console.log('当前 window.commands 长度(点击后):', (window.commands || []).length);
            } catch (e) {
              console.error('addCommandBtn 点击处理出错:', e);
            }
          });
        } else {
          console.error('找不到添加命令按钮');
        }
        
        // 输入框变化时自动保存（实时保存）
        buffIntervalInput.addEventListener('input', autoSaveConfig);
        buffCountInput.addEventListener('input', autoSaveConfig);
        buffIntervalInput.addEventListener('change', autoSaveConfig);
        buffCountInput.addEventListener('change', autoSaveConfig);
      });
      
      // 加载保存的配置
      function loadSavedConfig() {
        try {
          const saved = safeGetItem('buffConfig_' + profileName);
          if (saved) {
            const config = JSON.parse(saved);
            const intervalInput = document.getElementById('buffInterval');
            const countInput = document.getElementById('buffCount');
            
            if (intervalInput && countInput) {
              intervalInput.value = config.interval || '';
              countInput.value = config.count || 12;
            }
            
            // 确保buffConfig对象存在并正确设置属性
            buffConfig = {
              interval: config.interval || null,
              count: config.count || 12
            };
            
            console.log('已加载BUFF配置:', buffConfig);
          }
        } catch (e) {
          console.error('加载配置失败:', e);
          // 即使加载失败也初始化buffConfig对象
          buffConfig = {
            interval: null,
            count: 12
          };
        }
      }
      
      // 自动保存配置（带防抖功能）
      let saveTimeout = null;
      function autoSaveConfig() {
        // 清除之前的定时器
        if (saveTimeout) {
          clearTimeout(saveTimeout);
        }
        
        // 设置新的定时器，500ms后执行保存
        saveTimeout = setTimeout(() => {
          const intervalInput = document.getElementById('buffInterval');
          const countInput = document.getElementById('buffCount');
          
          if (!intervalInput || !countInput) {
            console.error('找不到配置输入元素');
            return;
          }
          
          const interval = parseInt(intervalInput.value);
          const count = parseInt(countInput.value) || 12;
          
          // 修复：保存interval和count到buffConfig中
          buffConfig.interval = interval;
          
          // 确保count在有效范围内并保存
          if (count >= 1 && count <= 20) {
            buffConfig.count = count;
          } else {
            buffConfig.count = 12; // 默认值
            countInput.value = 12;
          }
          
          console.log('保存BUFF配置:', buffConfig);
          
            try {
            // 强制保存配置到可用的存储（localStorage 或 内存回退）
            safeSetItem('buffConfig_' + profileName, JSON.stringify(buffConfig));
            updateStatus('配置已自动保存', '#00ff88');
            
            // 2秒后清除状态提示
            setTimeout(() => {
              updateStatus('', '#00ff88');
            }, 2000);
          } catch (e) {
            console.error('配置保存失败:', e);
            updateStatus('配置保存失败', '#ff4444');
          }
        }, 500);
      }
      
      // F1键处理函数
      function handleF1KeyPress() {
        if (isBuffing) {
          // 中断当前BUFF添加 - 用户主动中断
          stopBuffing(true);
          updateStatus('BUFF添加已中断', '#ffaa00');
          return;
        }
        
        console.log('处理F1键按下，当前配置:', buffConfig);
        
        // 修复：重新获取并验证interval和count值
        const intervalInput = document.getElementById('buffInterval');
        const countInput = document.getElementById('buffCount');
        
        if (!intervalInput || !countInput) {
          console.error('找不到配置输入元素');
          return;
        }
        
        const interval = parseInt(intervalInput.value);
        const count = parseInt(countInput.value) || 12;
        
        // 检查配置是否完整且有效
        if (!interval || interval < 100 || interval > 5000) {
          ipcRenderer.send('assist:send-message', {
            profileName: profileName,
            message: '请设置对应的BUFF间隔和数量'
          });
          updateStatus('请先设置有效的BUFF间隔(100-5000ms)', '#ff4444');
          return;
        }
        
        // 更新buffConfig中的值
        buffConfig.interval = interval;
        buffConfig.count = count;
        
        console.log('F1键按下，已更新配置:', buffConfig);
        
        // 开始BUFF添加
        startBuffing();
      }
      
      // 开始BUFF添加
      function startBuffing() {
        isBuffing = true;
        currentBuffIndex = 0;
        
        // 发送开始提示
        ipcRenderer.send('assist:send-message', {
          profileName: profileName,
          message: '添加BUFF开始'
        });
        
        updateStatus('BUFF添加开始...', '#00d2ff');
        
        // 开始执行BUFF添加
        executeNextBuff();
      }
      
      // 执行下一个BUFF
      function executeNextBuff() {
        if (!isBuffing || currentBuffIndex >= Math.min(buffConfig.count, buffKeyCombos.length)) {
          // BUFF添加完成 - 调用stopBuffing时传入false表示不是用户中断
          stopBuffing(false);
          ipcRenderer.send('assist:send-message', {
            profileName: profileName,
            message: 'BUFF添加结束'
          });
          updateStatus('BUFF添加完成', '#00ff88');
          return;
        }
        
        // 发送当前BUFF组合键
        const keyCombo = buffKeyCombos[currentBuffIndex];
        ipcRenderer.send('assist:send-key-combo', {
          profileName: profileName,
          keyCombo: keyCombo
        });
        
        updateStatus('正在添加BUFF ' + (currentBuffIndex + 1) + '/' + Math.min(buffConfig.count, buffKeyCombos.length) + ': ' + keyCombo, '#00d2ff');
        
        currentBuffIndex++;
        
        // 设置下一个BUFF的定时器
        buffTimer = setTimeout(() => {
          executeNextBuff();
        }, buffConfig.interval);
      }
      
      // 停止BUFF添加
      function stopBuffing(isUserInterrupt = true) {
        if (isBuffing && isUserInterrupt) {
          // 只有当是用户主动中断时，才发送中断提示
          ipcRenderer.send('assist:send-message', {
            profileName: profileName,
            message: 'BUFF已中断'
          });
        }
        
        isBuffing = false;
        if (buffTimer) {
          clearTimeout(buffTimer);
          buffTimer = null;
        }
      }
      
      // 更新状态显示
      function updateStatus(message, color) {
        const statusElement = document.getElementById('buffStatus');
        if (statusElement) {
          statusElement.textContent = message;
          statusElement.style.color = color;
        } else {
          // 修复：如果没有找到状态元素，在控制台显示状态消息
          let statusType = '信息';
          if (color === '#ff4444') statusType = '错误';
          else if (color === '#00ff88') statusType = '成功';
          console.log('[' + statusType + '] ' + message);
          
          // 尝试在页面其他地方显示状态
          const statusDiv = document.createElement('div');
          statusDiv.id = 'buffStatus';
          statusDiv.textContent = message;
          statusDiv.style.color = color;
          statusDiv.style.marginTop = '10px';
          statusDiv.style.fontSize = '14px';
          
          const sectionContent = document.querySelector('.section-content');
          if (sectionContent) {
            sectionContent.appendChild(statusDiv);
          }
        }
      }
      
      // 快捷命令相关功能函数
      
      // 加载快捷命令列表 - 修复使用全局变量
      function loadCommands() {
        console.log('加载快捷命令列表');
        const savedCommands = safeGetItem('quickCommands_' + profileName);
        
        // 确保commands是全局变量，但只在不存在时初始化
        if (!window.commands) {
          window.commands = [];
          console.log('初始化全局commands数组');
        }
        
        if (savedCommands) {
          try {
            const parsedCommands = JSON.parse(savedCommands);
            // 只有从localStorage加载时才替换数组内容
            window.commands = parsedCommands.map(cmd => new QuickCommand(
              cmd.id || Date.now() + Math.random(),
              cmd.name || '新命令',
              cmd.command || '',
              cmd.shortcut || '',
              cmd.interval || 1000
            ));
            console.log('已加载命令数量:', window.commands.length);
          } catch (error) {
            console.error('加载快捷命令失败：', error);
            // 错误时不清空现有命令，只记录错误
          }
        }
        
        renderCommands();
      }
      
      // 保存快捷命令列表 - 使用全局变量
      function saveCommands() {
        console.log('保存快捷命令列表');
        try {
          const commandsToSave = (window.commands || []).map(cmd => ({
            id: cmd.id,
            name: cmd.name,
            command: cmd.command,
            shortcut: cmd.shortcut,
            interval: cmd.interval,
            isRunning: cmd.isRunning
          }));
          console.log('即将保存到 localStorage 的数据：', commandsToSave);
          safeSetItem('quickCommands_' + profileName, JSON.stringify(commandsToSave));
          try {
            if (typeof ipcRenderer !== 'undefined' && ipcRenderer && ipcRenderer.send) {
              const shortcuts = commandsToSave.map(c => c.shortcut).filter(Boolean);
              ipcRenderer.send('assist:register-quick-shortcuts', { profileName: profileName, shortcuts });
            }
          } catch (e) {
            console.error('向主进程注册快捷键失败：', e);
          }
          console.log('已保存命令数量:', commandsToSave.length);
        } catch (error) {
          console.error('保存快捷命令失败：', error);
        }
      }
      
      // 渲染快捷命令列表 - 使用全局变量
      function renderCommands() {
        console.log('渲染快捷命令列表');
        const commandsList = document.getElementById('commandsList');
        if (!commandsList) {
          console.error('commandsList元素不存在');
          return;
        }
        
        commandsList.innerHTML = '';
        
        // 确保使用全局commands变量
        const cmds = window.commands || [];
        console.log('渲染命令数量:', cmds.length);
        
        cmds.forEach((command, index) => {
          console.log('渲染命令项:', index, command);
          const row = document.createElement('tr');
          row.className = 'command-row';
          row.innerHTML = [
            '<td class="command-name">',
            '  <input type="text" class="command-name-input" value="' + command.name + '" placeholder="命令名称" data-index="' + index + '" />',
            '</td>',
            '<td class="command-content">',
            '  <input type="text" class="command-content-input" value="' + command.command + '" placeholder="命令内容" data-index="' + index + '" />',
            '</td>',
            '<td class="command-shortcut">',
            '  <input type="text" class="command-shortcut-input" value="' + command.shortcut + '" placeholder="快捷键" data-index="' + index + '" />',
            '</td>',
            '<td class="command-interval">',
            '  <input type="number" class="command-interval-input" value="' + command.interval + '" min="100" max="60000" step="100" data-index="' + index + '" />',
            '</td>',
            '<td class="command-actions">',
            '  <div class="command-status">',
            '    <span class="status-indicator ' + (command.isRunning ? 'running' : 'stopped') + '"></span>',
            '    <span class="status-text">' + (command.isRunning ? '运行中' : '已停止') + '</span>',
            '  </div>',
            '  <button class="play-pause-btn ' + (command.isRunning ? 'pause' : 'play') + '" data-index="' + index + '">',
            '    ' + (command.isRunning ? '❚❚' : '▶'),
            '  </button>',
            '  <button class="delete-command-btn" data-index="' + index + '">🗑️</button>',
            '</td>'
          ].join('');
          commandsList.appendChild(row);
        });
        
        // 绑定事件监听器
        bindCommandEvents();
      }
      
      // 绑定快捷命令事件监听器
      function bindCommandEvents() {
        // 名称输入框
        const nameInputs = document.querySelectorAll('.command-name-input');
        console.log('绑定名称输入框数量:', nameInputs.length);
        nameInputs.forEach(input => {
          input.addEventListener('input', handleCommandInputChange);
          input.addEventListener('change', handleCommandInputChange);
        });
        
        // 命令内容输入框
        const contentInputs = document.querySelectorAll('.command-content-input');
        console.log('绑定命令内容输入框数量:', contentInputs.length);
        contentInputs.forEach(input => {
          input.addEventListener('input', handleCommandInputChange);
          input.addEventListener('change', handleCommandInputChange);
        });
        
        // 快捷键输入框：改为点击进入捕获模式，点击已在捕获的输入框则清空绑定
        const shortcutInputs = document.querySelectorAll('.command-shortcut-input');
        console.log('绑定快捷键输入框数量:', shortcutInputs.length)
        shortcutInputs.forEach(input => {
          // 不允许直接编辑文本，统一由捕获设置值
          try { input.readOnly = true } catch (e) {}

          input.addEventListener('click', (e) => {
            const idx = parseInt(e.target.dataset.index)
            // 当再次点击当前正在捕获的输入框 -> 清空绑定
            if (window.capturingShortcutIndex === idx) {
              console.log('停止捕获并清空快捷键绑定: index', idx)
              if (window.commands && window.commands[idx]) {
                window.commands[idx].shortcut = ''
              }
              e.target.value = ''
              saveCommands()
              
              try { ipcRenderer.send('assist:end-capture', { profileName: profileName, index: idx }); } catch (e) {}
              window.capturingShortcutIndex = null
              updateCaptureUI(null)
              return
            }

            // 开始捕获新的快捷键
            console.log('开始捕获快捷键: index', idx)
            window.capturingShortcutIndex = idx
            try { ipcRenderer.send('assist:begin-capture', { profileName: profileName, index: idx }); } catch (e) {}
            e.target.value = '按下组合键...'
            updateCaptureUI(idx)
          })
        })
        
        // 间隔输入框
        const intervalInputs = document.querySelectorAll('.command-interval-input');
        console.log('绑定间隔输入框数量:', intervalInputs.length);
        intervalInputs.forEach(input => {
          input.addEventListener('input', handleCommandInputChange);
          input.addEventListener('change', handleCommandInputChange);
        });
        
        // 播放/暂停按钮
        const playBtns = document.querySelectorAll('.play-pause-btn');
        console.log('绑定播放/暂停按钮数量:', playBtns.length);
        playBtns.forEach(btn => {
          btn.addEventListener('click', handlePlayPauseClick);
        });
        
        // 删除按钮
        const delBtns = document.querySelectorAll('.delete-command-btn');
        console.log('绑定删除按钮数量:', delBtns.length);
        delBtns.forEach(btn => {
          btn.addEventListener('click', handleDeleteCommandClick);
        });
      }
      
      // 更新捕获 UI 状态（高亮/占位提示）
      function updateCaptureUI(activeIndex) {
        document.querySelectorAll('.command-shortcut-input').forEach(inp => {
          const i = parseInt(inp.dataset.index)
          if (activeIndex !== null && i === activeIndex) {
            inp.classList.add('capturing')
            try { inp.placeholder = '按下组合键...' } catch (e) {}
          } else {
            inp.classList.remove('capturing')
            try { inp.placeholder = '' } catch (e) {}
          }
        })
      }

      // 全局键盘监听：当处于捕获模式时记录组合键并绑定
      window.addEventListener('keydown', function (ev) {
        if (window.capturingShortcutIndex == null) return
        // 防止页面其它快捷键触发
        try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}

        const parts = []
        if (ev.ctrlKey) parts.push('CTRL')
        if (ev.altKey) parts.push('ALT')
        if (ev.shiftKey) parts.push('SHIFT')
        if (ev.metaKey) parts.push('META')

        // 更可靠的按键名称映射，支持更多单键（字母/数字/空格/方向键/功能键等）
        let key = ev.key || '';
        // 规范化常见名称
        if (key === ' ') key = 'Space';
        if (/^Arrow/.test(key)) key = key.replace('Arrow', '');
        if (key === 'Esc') key = 'Escape';

        key = String(key).toUpperCase();
        // 排除单独的修饰键
        if (key && !['CONTROL', 'SHIFT', 'ALT', 'META'].includes(key)) {
          parts.push(key)
        }

        const combo = parts.join('+')
        const idx = window.capturingShortcutIndex
        if (idx == null) return

        // 写入到对应命令并更新输入框显示
        if (window.commands && window.commands[idx]) {
          window.commands[idx].shortcut = combo
        }
        const input = document.querySelector('.command-shortcut-input[data-index="' + idx + '"]')
        if (input) input.value = combo

        console.log('已绑定快捷键:', combo, '到 index', idx)
        saveCommands()

        // 结束捕获
        try { ipcRenderer.send('assist:end-capture', { profileName: profileName, index: idx }); } catch (e) {}
        window.capturingShortcutIndex = null
        updateCaptureUI(null)
      })

      // 处理命令输入框变化 - 使用全局变量
      function handleCommandInputChange(event) {
        const index = parseInt(event.target.dataset.index);
        const command = window.commands[index];
        
        if (event.target.classList.contains('command-name-input')) {
          command.name = event.target.value;
        } else if (event.target.classList.contains('command-content-input')) {
          command.command = event.target.value;
        } else if (event.target.classList.contains('command-shortcut-input')) {
          command.shortcut = event.target.value.toUpperCase();
          event.target.value = command.shortcut;
        } else if (event.target.classList.contains('command-interval-input')) {
          command.interval = parseInt(event.target.value) || 1000;
        }
        
        saveCommands();
      }
      
      // 处理播放/暂停按钮点击 - 使用全局变量
      function handlePlayPauseClick(event) {
        const index = parseInt(event.target.dataset.index);
        const command = window.commands[index];
        
        if (command.isRunning) {
          stopCommand(index);
        } else {
          startCommand(index);
        }
      }
      
      // 处理删除命令按钮点击 - 使用全局变量
      function handleDeleteCommandClick(event) {
        const index = parseInt(event.target.dataset.index);
        
        if (confirm('确定要删除这个命令吗？')) {
          // 停止命令执行
          stopCommand(index);
          
          // 从全局数组中移除
          window.commands.splice(index, 1);
          
          // 重新渲染列表
          renderCommands();
          
          // 保存更改
          saveCommands();
        }
      }
      
      // 添加快捷命令 - 完全重写以确保功能正常
      // 引入修复文件
      console.log('引入修复文件');
      try {
        require('./fix_add_command.js');
      } catch (e) {
        console.log('修复文件未找到，使用内置函数');
      }
      
      function addNewCommand() {
        console.log('执行添加新命令');
        try {
          // 确保commands数组存在
          if (!window.commands) {
            window.commands = [];
            console.log('初始化全局commands数组');
          }
          
          // 创建新命令
          const newCommand = new QuickCommand(
            Date.now() + Math.random(),
            '新命令',
            '',
            '',
            1000
          );
          
          // 添加到数组
          window.commands.push(newCommand);
          console.log('已添加新命令，当前命令数量:', window.commands.length);
          
          // 使用renderCommands函数重新渲染所有命令
          renderCommands();
          
          // 保存到localStorage
          saveCommands();
          
          console.log('命令添加成功并已渲染');
          
        } catch (error) {
          console.error('添加新命令失败:', error);
          // 显示错误提示
          updateStatus('添加命令失败: ' + error.message, '#ff4444');
        }
      }
      
      // 开始执行命令 - 使用全局变量
      function startCommand(index) {
        try {
          const command = window.commands[index];
          if (!command) {
            console.error('startCommand: 命令不存在，索引:', index);
            return;
          }
          
          if (!command.command) {
            alert('请先设置命令内容');
            return;
          }
          
          if (command.interval < 100) {
            alert('执行间隔不能小于100ms');
            return;
          }
          
          // 防止重复启动 - 检查是否已有定时器在运行
          if (commandTimers[command.id]) {
            console.warn('startCommand: 命令已在运行中，先停止旧的定时器:', command.id);
            clearInterval(commandTimers[command.id]);
            delete commandTimers[command.id];
          }
          
          // 设置运行状态
          command.isRunning = true;
          
          // 更新界面状态
          updateCommandStatus(index);
          
          // 立即执行一次（按 id 查找最新索引以防数组顺序变动）
          const curIdx = window.commands.findIndex(c => c.id === command.id);
          if (curIdx !== -1) {
            executeCommand(curIdx);
          } else {
            console.warn('startCommand: 执行第一次命令时未找到命令，ID:', command.id);
          }

          // 设置定时器，按命令 id 存储定时器以防索引变动
          const timer = setInterval(() => {
            try {
              const idxNow = window.commands.findIndex(c => c.id === command.id);
              if (idxNow !== -1) {
                executeCommand(idxNow);
              } else {
                console.warn('定时器执行: 未找到命令，ID:', command.id, '清除定时器');
                // 命令不存在了，清除定时器
                clearInterval(commandTimers[command.id]);
                delete commandTimers[command.id];
              }
            } catch (timerError) {
              console.error('定时器执行出错:', timerError);
            }
          }, command.interval);
          
          // 存储定时器引用
          commandTimers[command.id] = timer;
          console.log('命令已启动:', command.id, '定时器已设置');
          
          // 保存状态
          saveCommands();
        } catch (error) {
          console.error('启动命令时出错:', error, '索引:', index);
          
          // 出错时确保状态一致
          if (window.commands[index]) {
            window.commands[index].isRunning = false;
            updateCommandStatus(index);
            saveCommands();
          }
        }
      }
      
      // 停止执行命令 - 使用全局变量
      function stopCommand(index) {
        try {
          const command = window.commands[index];
          if (!command) {
            console.error('stopCommand: 命令不存在，索引:', index);
            return;
          }
          
          // 确保状态设置为false
          command.isRunning = false;
          
          // 清除定时器，添加更严格的检查和日志
          const timerId = command.id;
          if (timerId && commandTimers[timerId]) {
            console.log('停止命令定时器:', timerId, '索引:', index);
            clearInterval(commandTimers[timerId]);
            delete commandTimers[timerId];
            console.log('定时器已清除:', timerId);
          } else {
            console.warn('stopCommand: 未找到对应的定时器，命令ID:', timerId);
          }
          
          // 更新界面状态
          updateCommandStatus(index);
          
          // 保存状态
          saveCommands();
        } catch (error) {
          console.error('停止命令时出错:', error, '索引:', index);
        }
      }
      
      // 执行命令 - 使用全局变量
      function executeCommand(index) {
        try {
          const command = window.commands[index];
          if (!command) {
            console.error('executeCommand: 命令不存在，索引:', index);
            return;
          }
          
          // 再次检查命令是否在运行中，防止在执行期间被停止
          if (!command.isRunning && !commandTimers[command.id]) {
            console.warn('executeCommand: 命令不在运行中，跳过执行:', command.id);
            return;
          }
          
          // 发送命令到游戏窗口
          ipcRenderer.send('assist:send-key-combo', {
            profileName: profileName,
            keyCombo: command.command
          });
          
          console.log('执行快捷命令：', command.name, command.command);
        } catch (error) {
          console.error('执行命令时出错:', error, '索引:', index);
        }
      }
      
      // 更新命令状态显示 - 使用全局变量
      function updateCommandStatus(index) {
        const command = window.commands[index];
        const row = document.querySelector(".command-row:nth-child(" + (index + 1) + ")");
        if (!row) return;
        
        const statusIndicator = row.querySelector('.status-indicator');
        const statusText = row.querySelector('.status-text');
        const playPauseBtn = row.querySelector('.play-pause-btn');
        
        if (command.isRunning) {
          statusIndicator.className = 'status-indicator running';
          statusText.textContent = '运行中';
          playPauseBtn.className = 'play-pause-btn pause';
          playPauseBtn.textContent = '❚❚';
        } else {
          statusIndicator.className = 'status-indicator stopped';
          statusText.textContent = '已停止';
          playPauseBtn.className = 'play-pause-btn play';
          playPauseBtn.textContent = '▶';
        }
      }
      
      // 处理快捷命令快捷键 - 使用全局变量
      function normalizeShortcutString(s) {
        return String(s || '').replace(/\s+/g, '').toUpperCase();
      }

      function handleQuickCommandShortcut(shortcut) {
        const cmds = window.commands || [];
        console.log('收到快捷键触发:', shortcut, '当前命令数:', cmds.length);
        console.log('命令快捷键列表:', cmds.map((c, i) => ({index:i, id:c.id, shortcut:c.shortcut, isRunning:c.isRunning, hasTimer:!!commandTimers[c.id]})));
        const norm = normalizeShortcutString(shortcut);
        const command = cmds.find(cmd => normalizeShortcutString(cmd.shortcut) === norm);
        if (!command) {
          console.log('未找到匹配的命令快捷键:', shortcut);
          return;
        }
        const index = cmds.indexOf(command);
        
        // 完全修复：与UI按钮保持完全一致的逻辑
        // 直接基于命令的isRunning状态来决定操作，不进行状态修正
        if (command.isRunning) {
          // 命令正在运行，执行停止操作
          console.log('停止命令: 通过快捷键 (命令正在运行)');
          stopCommand(index);
        } else {
          // 命令已停止，执行启动操作
          console.log('启动命令: 通过快捷键 (命令已停止)');
          startCommand(index);
        }
        
        console.log('快捷键操作后命令状态: id=', command.id, 'index=', index, 'isRunning=', command.isRunning, 'hasTimer=', !!commandTimers[command.id]);
      }
      </script>
  </body>
  </html>`.trim();

  assistWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  // 将渲染器（辅助窗口）的 console 输出转发到主进程终端，便于调试
  try {
    assistWin.webContents.on('console-message', (event, level, message, line, sourceId) => {
      try {
        console.log(`[assist:${profileName}] console (level ${level}) ${message} (line ${line} @ ${sourceId})`);
      } catch (e) {
        console.log('[assist] console-message handler error', e);
      }
    });

    assistWin.webContents.on('did-finish-load', () => {
      console.log(`assistWin (${profileName}) did-finish-load`);
    });
  } catch (e) {
    console.error('无法绑定 assistWin.webContents 事件:', e);
  }
  
  // 设置窗口位置，让辅助窗口独立显示在屏幕中央
  assistWin.once('ready-to-show', () => {
    // 获取屏幕尺寸
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
    
    // 计算窗口位置，使其在屏幕中央显示
    const windowBounds = assistWin.getBounds();
    const x = Math.round((screenWidth - windowBounds.width) / 2);
    const y = Math.round((screenHeight - windowBounds.height) / 2);
    
    // 设置窗口位置并显示
    assistWin.setPosition(x, y);
    assistWin.show();
  });
  
  // 保存窗口引用到管理Map
  assistWindows.set(profileName, assistWin);
  
  // 窗口关闭时从管理Map中移除
  assistWin.on('closed', () => {
    console.log('辅助窗口已关闭，角色：', profileName);
    try {
      unregisterProfileShortcuts(profileName);
    } catch (e) {}
    if (assistWindows.get(profileName) === assistWin) {
      assistWindows.delete(profileName);
    }
  });
  
  return { ok: true, profileName: profileName, action: 'created' };
});

// 处理辅助窗口发送组合键的请求
ipcMain.on('assist:send-key-combo', (event, data) => {
  const { profileName, keyCombo } = data;
  
  console.log('收到按键发送请求：角色 ' + profileName + '，组合键 ' + keyCombo);
  
  // 查找对应的游戏窗口
  const gameWindowsSet = gameWindows.get(profileName);
  if (gameWindowsSet && gameWindowsSet.size > 0) {
    // 获取第一个可用的游戏窗口
    const gameWin = Array.from(gameWindowsSet).find(w => w && !w.isDestroyed());
    if (gameWin) {
      try {
        // 根据组合键类型发送不同的按键
        if (keyCombo.startsWith('ALT+')) {
          const key = keyCombo.split('+')[1];
          sendAltKeyCombo(gameWin, key);
        } else if (keyCombo.startsWith('CTRL+')) {
          const key = keyCombo.split('+')[1];
          sendCtrlKeyCombo(gameWin, key);
        } else if (keyCombo.startsWith('SHIFT+')) {
          const key = keyCombo.split('+')[1];
          sendShiftKeyCombo(gameWin, key);
        } else {
          // 发送单个按键
          sendSingleKey(gameWin, keyCombo);
        }
      } catch (error) {
        console.error('发送按键失败：', error);
      }
    } else {
      console.log('角色 ' + profileName + ' 的游戏窗口已销毁，无法发送按键');
    }
  } else {
    console.log('未找到角色 ' + profileName + ' 的游戏窗口，无法发送按键');
  }
});

// 发送ALT+按键组合
function sendAltKeyCombo(window, key) {
  // 模拟ALT+按键
  window.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: 'Alt'
  });
  
  window.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: key
  });
  
  // 短暂延迟后释放按键
  setTimeout(() => {
    window.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: key
    });
    
    window.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'Alt'
    });
    
    console.log('已发送 ALT+' + key + ' 组合键');
  }, 100);
}

// 发送CTRL+按键组合
function sendCtrlKeyCombo(window, key) {
  // 模拟CTRL+按键
  window.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: 'Control'
  });
  
  window.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: key
  });
  
  // 短暂延迟后释放按键
  setTimeout(() => {
    window.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: key
    });
    
    window.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'Control'
    });
    
    console.log('已发送 CTRL+' + key + ' 组合键');
  }, 100);
}

// 发送SHIFT+按键组合
function sendShiftKeyCombo(window, key) {
  // 模拟SHIFT+按键
  window.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: 'Shift'
  });
  
  window.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: key
  });
  
  // 短暂延迟后释放按键
  setTimeout(() => {
    window.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: key
    });
    
    window.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'Shift'
    });
    
    console.log('已发送 SHIFT+' + key + ' 组合键');
  }, 100);
}

// 发送单个按键
function sendSingleKey(window, key) {
  // 发送单个按键
  window.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: key
  });
  
  // 短暂延迟后释放按键
  setTimeout(() => {
    window.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: key
    });
    
    console.log('已发送单个按键: ' + key);
  }, 100);
}

// 处理辅助窗口发送消息的请求
ipcMain.on('assist:send-message', (event, data) => {
  const { profileName, message } = data;
  
  console.log('收到消息发送请求：角色 ' + profileName + '，消息：' + message);
  
  // 查找对应的游戏窗口
  const gameWindowsSet = gameWindows.get(profileName);
  if (gameWindowsSet && gameWindowsSet.size > 0) {
    // 获取第一个可用的游戏窗口
    const gameWin = Array.from(gameWindowsSet).find(w => w && !w.isDestroyed());
    if (gameWin) {
      // 在游戏窗口中显示消息
      showToastInWindow(gameWin, message);
      console.log('已向游戏窗口 ' + profileName + ' 显示消息：' + message);
    } else {
      console.log('角色 ' + profileName + ' 的游戏窗口已销毁，无法显示消息');
    }
  } else {
    console.log('未找到角色 ' + profileName + ' 的游戏窗口，无法显示消息');
  }
});

// ---------- App lifecycle ----------

app.on('ready', async () => {
  console.log('App ready event triggered');
  try {
    if (!fs.existsSync(PROFILES_FILE)) writeProfiles([]);
    writeProfiles(readProfiles());
    settings = readSettings();
    console.log('Settings and profiles initialized');

    await processPendingDeletes().catch(() => {});
    console.log('Pending deletes processed');

    console.log('Attempting to create launcher window...');
    createLauncher();
    console.log('Launcher window created:', !!launcherWin);

    updateGlobalShortcut();
    console.log('Global shortcuts updated');

    if (launcherWin && !launcherWin.isDestroyed()) {
      launcherWin.webContents.send('app:restarted-cleanup-complete');
      console.log('Sent restart complete event');
    }
  } catch (error) {
    console.error('Error in app.ready:', error);
  }
});

// 添加错误处理
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  await processPendingDeletes().catch(() => {});
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!launcherWin) createLauncher();
  launcherWin.show();
});
