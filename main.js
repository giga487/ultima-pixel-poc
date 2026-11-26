import { dotnet } from './_framework/dotnet.js';
import { mountUoFiles, stats as uoStats } from './uo-files.js';

const status = document.getElementById('status');
const statusPill = document.getElementById('status-pill');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const container = document.getElementById('game-container');
const canvas = document.getElementById('canvas');

function setStatus(text, isReady = false) {
    if (status) status.textContent = text;
    if (loadingText && !isReady) loadingText.textContent = text;
    if (statusPill) statusPill.classList.toggle('ready', isReady);
    if (loadingOverlay && isReady) loadingOverlay.classList.add('hidden');
}

// Prevent the browser context menu so right-click movement/actions reach the game cleanly
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

let canvasMode = 'fixed';
let resizeTimer = null;
let onCanvasResized = null;

function notifyFluidResize() {
    if (canvasMode !== 'fluid' || !onCanvasResized) return;
    const rect = container.getBoundingClientRect();
    const w = Math.max(640, Math.floor(rect.width));
    const h = Math.max(480, Math.floor(rect.height));
    onCanvasResized(w, h);
}

function setCanvasMode(fluid, fixedWidth, fixedHeight) {
    if (fluid) {
        canvasMode = 'fluid';
        canvas.classList.remove('mode-fixed');
        canvas.classList.add('mode-fluid');
        requestAnimationFrame(notifyFluidResize);
    } else {
        canvasMode = 'fixed';
        if (fixedWidth > 0 && fixedHeight > 0) {
            canvas.style.setProperty('--fixed-ratio', String(fixedWidth / fixedHeight));
        }
        canvas.classList.remove('mode-fluid');
        canvas.classList.add('mode-fixed');
    }
}

const resizeObserver = new ResizeObserver(() => {
    if (canvasMode !== 'fluid') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(notifyFluidResize, 80);
});
resizeObserver.observe(container);
document.addEventListener('fullscreenchange', () => {
    if (canvasMode !== 'fluid') return;
    requestAnimationFrame(notifyFluidResize);
});

let musicAudio = null;
let pendingMusicPlay = false;
let resolvedUoDirectory = '/uo';
let resolvedUoDataUrl = '/uo/';
let resolvedApiBaseUrl = new URL('/api', location.href).href.replace(/\/+$/, '');
let flushProfileSync = null;

function getApiBaseUrl() {
    return resolvedApiBaseUrl;
}

function flushProfileKeepalive(url, bearerToken, jsonBody) {
    if (!url || !jsonBody) return;
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (bearerToken) {
            headers['Authorization'] = `Bearer ${bearerToken}`;
        }
        fetch(url, {
            method: 'PUT',
            credentials: 'same-origin',
            headers,
            body: jsonBody,
            keepalive: true
        }).catch(() => {});
    } catch {
        // Ignore network errors during page unload
    }
}

const fsBtn = document.getElementById('btn-fullscreen');
if (fsBtn) {
    fsBtn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            container.requestFullscreen?.().catch(() => {});
        } else {
            document.exitFullscreen?.().catch(() => {});
        }
    });
}

window.addEventListener('pagehide', () => {
    try { flushProfileSync?.(); } catch {}
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        try { flushProfileSync?.(); } catch {}
    }
});

function uoPathToUrl(path) {
    const normalized = String(path || '').replace(/\\/g, '/');
    const prefix = resolvedUoDirectory.replace(/\/+$/, '') + '/';
    const rel = normalized.startsWith(prefix)
        ? normalized.slice(prefix.length)
        : normalized.replace(/^\/+/, '');
    const base = resolvedUoDataUrl.endsWith('/') ? resolvedUoDataUrl : resolvedUoDataUrl + '/';
    return base + rel.split('/').map(encodeURIComponent).join('/');
}

let sfxCtx = null;
let sfxMasterGain = null;
let sfxMasterVolume = 1.0;
const sfxBufferCache = new Map();
const activeSfxNodes = new Set();

function ensureSfxContext() {
    if (!sfxCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        sfxCtx = new AudioCtx();
        sfxMasterGain = sfxCtx.createGain();
        sfxMasterGain.gain.value = sfxMasterVolume;
        sfxMasterGain.connect(sfxCtx.destination);
    }
    return sfxCtx;
}

function tryResumeMusic() {
    if (pendingMusicPlay && musicAudio) {
        musicAudio.play().then(() => { pendingMusicPlay = false; }).catch(() => {});
    }
    if (sfxCtx && sfxCtx.state === 'suspended') {
        sfxCtx.resume().catch(() => {});
    }
}

function setMasterSoundVolume(volume) {
    sfxMasterVolume = Math.max(0, Math.min(1, Number(volume) || 0));
    if (sfxMasterGain) {
        sfxMasterGain.gain.value = sfxMasterVolume;
    }
}

function stopAllSounds() {
    for (const node of activeSfxNodes) {
        try { node.stop(); } catch {}
    }
    activeSfxNodes.clear();
}

function playSoundPcm(index, pcmBytes, sampleRate, volume) {
    const vol = Math.max(0, Math.min(1, Number(volume) || 0));
    if (vol <= 0.001 || !pcmBytes || pcmBytes.length < 2) return;

    const ctx = ensureSfxContext();
    if (!ctx) return;

    if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
        if (ctx.state === 'suspended') return;
    }

    let buffer = sfxBufferCache.get(index);
    if (!buffer) {
        const rate = sampleRate > 0 ? sampleRate : 22050;
        const sampleCount = (pcmBytes.length / 2) | 0;
        buffer = ctx.createBuffer(1, sampleCount, rate);
        const channel = buffer.getChannelData(0);
        const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, sampleCount * 2);
        for (let i = 0; i < sampleCount; i++) {
            channel[i] = view.getInt16(i * 2, true) / 32768.0;
        }
        sfxBufferCache.set(index, buffer);
    }

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    gain.gain.value = vol;
    source.connect(gain);
    gain.connect(sfxMasterGain);
    activeSfxNodes.add(source);
    source.onended = () => {
        activeSfxNodes.delete(source);
        source.disconnect();
        gain.disconnect();
    };
    source.start();
}

window.addEventListener('pointerdown', tryResumeMusic);
window.addEventListener('keydown', tryResumeMusic);

function stopMusic() {
    pendingMusicPlay = false;
    if (musicAudio) {
        musicAudio.pause();
        musicAudio.src = '';
        musicAudio = null;
    }
}

function setMusicVolume(volume) {
    if (musicAudio) {
        musicAudio.volume = Math.max(0, Math.min(1, Number(volume) || 0));
    }
}

function playMusic(path, volume, loop) {
    stopMusic();
    if (noMusic || !path) return;

    const url = uoPathToUrl(path);
    const audio = new Audio(url);
    audio.loop = !!loop;
    audio.volume = Math.max(0, Math.min(1, Number(volume) || 0));
    audio.preload = 'auto';
    musicAudio = audio;

    audio.play().catch(() => {
        // Browser autoplay policy blocks audio until the first user gesture
        if (musicAudio === audio) {
            pendingMusicPlay = true;
        }
    });
}

// For inspection from the browser console: download statistics of the Ultima Online files
window.uoStats = uoStats;

// settings.json (served next to the page) is the client settings; "uodataurl" is where the UO data files come from.
// ?uodata=<url> overrides it, ?spike runs the graphics spike, any other ?key=value becomes "-key value" on the command line.
const SETTINGS_PATH = '/settings.json';

const query = new URLSearchParams(location.search);
const args = ['-settings', SETTINGS_PATH];
let uoDataOverride = null;
let apiUrlOverride = null;
let noMusic = false;
let manualLogin = false;
let offlineMode = false;
let pickChar = false;
let requestedChar = null;
let isSpike = false;
for (const [key, value] of query) {
    if (key === 'uodata') {
        uoDataOverride = value;
    } else if (key === 'apiurl') {
        apiUrlOverride = value;
    } else if (key === 'nomusic') {
        noMusic = true;
    } else if (key === 'manual') {
        manualLogin = true;
    } else if (key === 'offline') {
        offlineMode = value !== '0' && value !== 'false';
    } else if (key === 'embed') {
        if (value !== '0' && value !== 'false') {
            document.body.classList.add('embed-mode');
        }
    } else if (key === 'pick') {
        pickChar = true;
    } else if (key === 'char') {
        requestedChar = value;
    } else if (key === 'spike') {
        isSpike = true;
        args.push('spike');
    } else {
        args.push('-' + key);
        if (value) args.push(value);
    }
}

try {
    const settingsResponse = await fetch('./settings.json');
    const settings = settingsResponse.ok ? await settingsResponse.json() : {};
    const uoDirectory = settings.ultimaonlinedirectory || '/uo';
    const uoDataUrl = uoDataOverride ?? settings.uodataurl ?? '/uo/';
    resolvedUoDirectory = uoDirectory;
    resolvedUoDataUrl = uoDataUrl;
    const isOffline = offlineMode || String(settings.ip || '').toLowerCase().startsWith('offline://');
    const rawApiUrl = isOffline ? '' : (apiUrlOverride ?? settings.apiurl ?? '/api');
    resolvedApiBaseUrl = rawApiUrl ? new URL(rawApiUrl, location.href).href.replace(/\/+$/, '') : '';

    if (isOffline && !isSpike) {
        const offlineIp = String(settings.ip || '').toLowerCase().startsWith('offline://')
            ? settings.ip
            : 'offline://local';
        settings.ip = offlineIp;
        args.push('-ip', offlineIp);
        args.push('-username', 'demo');
        args.push('-password', 'demo');
        args.push('-saveaccount', 'false');
        args.push('-last_server_name', 'Pixel Isle');
        args.push('-skiploginscreen');
        args.push('-autologin', 'true');
        const hudAcc = document.getElementById('hud-account');
        if (hudAcc) hudAcc.textContent = 'Offline Pixel Sandbox — Right-click: move | Double-click character: Paperdoll';
    }

    // Portal SSO: verify session cookie and request a one-time game ticket so the user skips LoginGump
    if (!isOffline && !isSpike && !manualLogin && resolvedApiBaseUrl) {
        setStatus('Checking portal session...');
        const meResp = await fetch(`${resolvedApiBaseUrl}/auth/me`, { credentials: 'same-origin' });
        if (meResp.status === 401) {
            location.href = '/?notice=' + encodeURIComponent('Please sign in from the portal to play.');
            throw new Error('redirecting');
        }
        if (meResp.ok) {
            const me = await meResp.json();
            const hudAcc = document.getElementById('hud-account');
            if (hudAcc && me.username) hudAcc.textContent = me.username;

            const ticketResp = await fetch(`${resolvedApiBaseUrl}/game/ticket`, {
                method: 'POST',
                credentials: 'same-origin'
            });
            if (ticketResp.ok) {
                const t = await ticketResp.json();
                const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = `${wsProto}//${location.host}/ws?ticket=${encodeURIComponent(t.ticket)}`;
                settings.ip = wsUrl;
                args.push('-ip', wsUrl);
                args.push('-username', t.username);
                args.push('-password', t.ticket);
                args.push('-saveaccount', 'false');
                args.push('-last_server_name', t.serverName || 'UltimaGDR');
                args.push('-skiploginscreen');
                if (!pickChar) {
                    args.push('-autologin', 'true');
                }
                if (requestedChar) {
                    args.push('-lastcharactername', requestedChar);
                }
            }
        }
    }

    const { Module, setModuleImports, getAssemblyExports, getConfig, runMain } = await dotnet
        .withDiagnosticTracing(false)
        .withApplicationArguments(...args)
        .withModuleConfig({ canvas })
        .create();

    setModuleImports('main.js', { setCanvasMode, playMusic, setMusicVolume, stopMusic, playSoundPcm, setMasterSoundVolume, stopAllSounds, getApiBaseUrl, flushProfileKeepalive });

    const config = getConfig();
    const exports = await getAssemblyExports(config.mainAssemblyName);
    onCanvasResized = exports.ClassicUO.Web.Program.OnCanvasResized;
    flushProfileSync = exports.ClassicUO.Web.Program.FlushProfileSync;

    // the settings file ClassicUO reads (-settings), and the UO data files as lazy files under ultimaonlinedirectory
    window.uoDebug = { FS: Module.FS };   // for inspection from the browser console
    Module.FS.writeFile(SETTINGS_PATH, JSON.stringify({ ...settings, ultimaonlinedirectory: uoDirectory, uodataurl: uoDataUrl }));

    setStatus(`Loading pixel-art world assets...`);
    try {
        const files = await mountUoFiles(Module.FS, uoDataUrl, uoDirectory);
        console.log(`UO data: ${files.files} files (${(files.totalSize / 1048576).toFixed(2)} MB) mounted at ${uoDirectory}, downloaded on demand from ${uoDataUrl}`);
    } catch (e) {
        console.error(`UO data not available from ${uoDataUrl}: ${e}`);
    }

    setStatus('Entering world...');

    // runMain (not run/runMainAndExit): Main initializes ClassicUO and returns cleanly (no Emscripten
    // `throw 'unwind'`, which would corrupt Mono SGen LMF frames). We then drive frames via requestAnimationFrame.
    await runMain();
    setStatus('Ready (800x600 offline)', true);

    const stepFrame = exports.ClassicUO.Web.Program.StepFrame;
    window.uoDebug.forceGc = () => exports.ClassicUO.Web.Program.ForceGcDiagnostic();

    function frameLoop() {
        try {
            stepFrame();
        } catch (err) {
            console.error('ClassicUO frame error:', err);
        }
        requestAnimationFrame(frameLoop);
    }
    requestAnimationFrame(frameLoop);
} catch (e) {
    if (e === 'unwind') {
        setStatus('Ready (800x600 offline)', true);
    } else {
        setStatus('Failed to start: ' + e, false);
        console.error(e);
    }
}
